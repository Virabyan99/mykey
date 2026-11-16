// Run 5.9 Task C (AC-1.22, PO-10, FR-1.54): the reference in a real browser
// attempts no request but its own document. A route handler aborts and records
// anything that is not same-origin; an init script records every
// securitypolicyviolation and counts calls of fetch, XMLHttpRequest, WebSocket,
// EventSource and sendBeacon. This is a test of egress, not of TLS: the
// context accepts the test API's private certificate.
// Needs Chromium: `pnpm exec playwright install chromium` (once per workstation or runner).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { format } from "prettier";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyReferenceAsset } from "../../scripts/reference-asset.ts";
import { startTestApi, type TestApi } from "../harness/api.ts";
import { createTenants, type FixtureUser, type Tenants } from "../harness/tenants.ts";

const EVIDENCE = resolve(
  import.meta.dirname,
  "../../docs/evidence/session-5/reference-capture.json",
);

interface Capture {
  violations: { directive: string; blocked: string }[];
  calls: Record<"fetch" | "xhr" | "WebSocket" | "EventSource" | "sendBeacon", number>;
}

// Runs before any script of the page (through the DevTools protocol, outside the page's policy).
const INIT = `(() => {
  const capture = { violations: [], calls: { fetch: 0, xhr: 0, WebSocket: 0, EventSource: 0, sendBeacon: 0 } };
  Object.defineProperty(window, "__capture", { value: capture });
  document.addEventListener("securitypolicyviolation", (event) => {
    capture.violations.push({ directive: event.violatedDirective, blocked: String(event.blockedURI) });
  }, true);
  const original = window.fetch;
  window.fetch = function (...args) { capture.calls.fetch += 1; return original.apply(this, args); };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) { capture.calls.xhr += 1; return open.apply(this, args); };
  for (const name of ["WebSocket", "EventSource"]) {
    const Original = window[name];
    if (Original === undefined) continue;
    window[name] = new Proxy(Original, {
      construct(target, args) { capture.calls[name] += 1; return Reflect.construct(target, args); },
    });
  }
  if (navigator.sendBeacon !== undefined) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (...args) => { capture.calls.sendBeacon += 1; return beacon(...args); };
  }
})();`;

let api: TestApi;
let tenants: Tenants;
let browser: Browser;
let scalarVersion: string;
const own = { requested: [] as string[], failed: [] as string[] };
const thirdParty: string[] = [];
let capture: Capture | undefined;
let origin: string;
let page: Page;

async function contextFor(user: FixtureUser | null): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" });
  if (user !== null) {
    const pair = await tenants.cookie(user);
    const at = pair.indexOf("=");
    await context.addCookies([
      { name: pair.slice(0, at), value: pair.slice(at + 1), url: api.baseUrl, secure: true },
    ]);
  }
  return context;
}

beforeAll(async () => {
  ({ version: scalarVersion } = copyReferenceAsset());
  api = await startTestApi({
    dispatcher: false,
    processOrganization: () => tenants.a.organizationId,
  });
  tenants = await createTenants(api);
  browser = await chromium.launch();

  const context = await contextFor("ownerA");
  origin = new URL(api.baseUrl).origin;
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (new URL(url).origin === origin) {
      await route.continue();
    } else {
      thirdParty.push(url);
      await route.abort("blockedbyclient");
    }
  });
  context.on("request", (request) => own.requested.push(request.url()));
  context.on("requestfailed", (request) => own.failed.push(request.url()));
  await context.addInitScript({ content: INIT });
  page = await context.newPage();
  const answer = await page.goto(`${api.baseUrl}/v1/reference`, { waitUntil: "load" });
  expect(answer?.status()).toBe(200);
  await page.getByText("/v1/version").first().waitFor({ state: "visible", timeout: 60_000 });
  // Whatever the page would start later (lazy chunks, telemetry, fonts) gets its chance.
  await page.waitForLoadState("networkidle");
  await page.mouse.wheel(0, 20_000);
  await page.waitForTimeout(3_000);
  // No DOM types in the test's TypeScript: the page's global object is globalThis there.
  capture = await page.evaluate(() => (globalThis as unknown as { __capture: Capture }).__capture);
}, 300_000);

afterAll(async () => {
  if (capture !== undefined) {
    const paths = [...new Set(own.requested.map((url) => new URL(url).pathname))];
    // Formatted as `pnpm run check` expects the committed file.
    writeFileSync(
      EVIDENCE,
      await format(
        JSON.stringify({
          run: "5.9 Task C",
          scalar: `@scalar/api-reference ${scalarVersion}`,
          browser: `Chromium ${browser.version()}`,
          playwright: playwrightVersion(),
          requestedPaths: paths,
          counts: {
            thirdPartyRequestsAttempted: thirdParty.length,
            policyViolations: capture.violations.length,
            networkApiCalls: Object.values(capture.calls).reduce((sum, n) => sum + n, 0),
          },
        }),
        { parser: "json" },
      ),
    );
  }
  await browser.close();
  await api.close();
});

/** The pinned version, as the root package.json names it. */
function playwrightVersion(): string {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
  ) as { devDependencies: Record<string, string> };
  return manifest.devDependencies.playwright ?? "unknown";
}

describe("the reference in a browser", () => {
  it("the reference renders", async () => {
    await expect(page.getByText("/v1/version").first().isVisible()).resolves.toBe(true);
    const body = await page.locator("body").innerText();
    expect(body).toContain("/v1/organizations/{org}/projects/{project}/environments/{env}/secrets");
  });

  it("the page makes no request but its own", () => {
    // The document itself and at most the browser's own favicon, both of this origin.
    const allowed = new Set([`${origin}/v1/reference`, `${origin}/favicon.ico`]);
    expect(own.requested[0]).toBe(`${origin}/v1/reference`);
    expect(own.requested.filter((url) => !allowed.has(url))).toEqual([]);
    expect(thirdParty).toEqual([]);
    expect(capture!.violations).toEqual([]);
    expect(capture!.calls).toEqual({
      fetch: 0,
      xhr: 0,
      WebSocket: 0,
      EventSource: 0,
      sendBeacon: 0,
    });
  });

  it("nothing can be executed", async () => {
    for (const role of ["button", "link", "menuitem", "tab"] as const) {
      await expect(page.getByRole(role, { name: /send|test request|try/i }).count()).resolves.toBe(
        0,
      );
    }
    // The test's TypeScript has no DOM types: the part of a form element it reads.
    interface FormElement {
      getAttribute(name: string): string | null;
      method: string;
    }
    const forms = await page.locator("form").evaluateAll((list) =>
      (list as unknown as FormElement[]).map((form) => ({
        action: form.getAttribute("action"),
        method: form.method,
      })),
    );
    expect(forms.filter((form) => form.action !== null || form.method === "post")).toEqual([]);
  });

  it("without a session the browser gets no page (401); a member gets the hidden 404", async () => {
    for (const [user, status] of [
      [null, 401],
      ["editorA", 404],
    ] as const) {
      const context = await contextFor(user);
      const other = await context.newPage();
      const answer = await other.goto(`${api.baseUrl}/v1/reference`);
      expect(answer?.status(), String(user)).toBe(status);
      expect(await answer?.headerValue("content-type"), String(user)).toMatch(/^application\/json/);
      await context.close();
    }
  });
});
