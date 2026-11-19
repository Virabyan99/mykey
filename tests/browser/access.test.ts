// Run 7.9 (FR-1.76, FR-1.89, FR-1.93, FR-1.96; AC-1.29, AC-1.34, AC-1.51;
// PO-12): the workspace without a mouse, on a narrow screen, inside another
// site's frame, with colours switched off, and at each kind of refusal. Most
// of it is proof of what Runs 7.1 to 7.8 built, over real OpenBao.
//
// The nine failure classes: five are the server's own answers. Four (a state
// conflict, a sealed store, an unwritable audit log, no capacity) cannot be
// made on the shared test stack without breaking the files beside this one;
// for them the harness answers the page's request with the contract's
// envelope and status for that code. The page under test is the same.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { codeAt, stepAt } from "@mykey/auth";
import { ERROR_CODES, webPath, type ErrorCode } from "@mykey/contracts";
import type { Locator, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signInComplete } from "../harness/api.ts";
import { clearCredentials, issueFor } from "../harness/credentials-fixture.ts";
import { machineCall } from "../harness/machine.ts";
import { startWebWithStores, type StoresWeb } from "../harness/web.ts";

let web: StoresWeb;

beforeAll(async () => {
  web = await startWebWithStores();
}, 600_000);

afterAll(async () => {
  await web.close();
});

beforeEach(async () => {
  await web.api.superuser.query("DELETE FROM app.rate_limit");
  await web.f.freshen();
});

afterEach(async () => {
  await clearCredentials(web.f, web.tenants.a.env1a);
});

const canary = (): string =>
  ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
const newName = (): string => `ACC_${randomBytes(5).toString("hex").toUpperCase()}`;
const at = () => ({
  org: web.tenants.a.organizationId,
  project: web.tenants.a.project1,
  env: web.tenants.a.env1a,
});
const overviewPath = (): string => webPath("overview", { org: web.tenants.a.organizationId });
const heading = (page: Page, name: string): Locator =>
  page.getByRole("heading", { level: 1, name });

interface Written {
  version: number;
  stateTag: string;
}

async function seeded(): Promise<{ name: string; written: Written }> {
  const name = newName();
  const answer = await web.f.create("env1a", name, canary());
  expect(answer.status, answer.code ?? "").toBe(201);
  return { name, written: answer.body.result as Written };
}

/** Whether the keyboard is on `target`. */
const isFocused = (target: Locator): Promise<boolean> =>
  target.evaluate((element: unknown) => {
    const node = element as { ownerDocument: { activeElement: unknown } };
    return node.ownerDocument.activeElement === element;
  });

/** Where the keyboard is, relative to `box`: inside it, on no control at all, or on a control outside it. */
const focusIn = (box: Locator): Promise<"inside" | "nowhere" | "outside"> =>
  box.evaluate((element: unknown) => {
    const node = element as {
      contains(other: unknown): boolean;
      ownerDocument: { activeElement: unknown; body: unknown };
    };
    const active = node.ownerDocument.activeElement;
    if (active === null || active === node.ownerDocument.body) return "nowhere";
    return node.contains(active) ? "inside" : "outside";
  });

/** Presses Tab until the keyboard is on `target`, and checks that the focus can be seen there. */
async function tabTo(page: Page, target: Locator, what: string): Promise<void> {
  await target.waitFor();
  for (let presses = 0; presses < 150; presses += 1) {
    if (await isFocused(target)) {
      const ring = await target.evaluate((element: unknown) => {
        const scope = globalThis as unknown as {
          getComputedStyle(of: unknown): { outlineStyle: string; outlineWidth: string };
        };
        const style = scope.getComputedStyle(element);
        return `${style.outlineStyle} ${style.outlineWidth}`;
      });
      expect(ring, `the focus ring on ${what}`).toBe("solid 3px");
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${what}`);
}

describe("without a mouse", () => {
  it("keyboard only: sign in, create a secret, reveal it, issue a token and revoke it without the mouse", async () => {
    const session = await web.anonymous();
    const { page } = session;
    const keys = page.keyboard;
    const { email, password, seed } = web.tenants.credentials("adminA");
    const name = newName();
    const value = canary();
    const credential = `keyboard-${randomBytes(3).toString("hex")}`;
    try {
      // Sign in.
      await page.goto(`${web.origin}/`);
      await heading(page, "Sign in").waitFor();
      await tabTo(page, page.getByLabel("E-mail address"), "the e-mail field");
      await keys.type(email);
      await keys.press("Tab");
      expect(await isFocused(page.getByLabel("Password", { exact: true }))).toBe(true);
      await keys.type(password);
      await keys.press("Enter");
      await heading(page, "Enter your code").waitFor();
      await tabTo(page, page.getByLabel("Code from your authenticator app"), "the code field");
      await keys.type(codeAt(seed, stepAt(new Date()) + 1));
      await keys.press("Enter");
      await page.waitForURL(`${web.origin}${overviewPath()}`);

      // To the environment, and a new secret.
      const dev = page
        .getByRole("region", { name: "Project One" })
        .getByRole("link", { name: "dev", exact: true });
      await tabTo(page, dev, "the environment's link");
      await keys.press("Enter");
      await heading(page, "Secrets").waitFor();
      await tabTo(page, page.getByRole("button", { name: "New secret" }), "New secret");
      await keys.press("Enter");
      await tabTo(page, page.getByLabel("Name", { exact: true }), "the name field");
      await keys.type(name);
      await tabTo(page, page.getByLabel("Value", { exact: true }), "the value field");
      await keys.type(value);
      await tabTo(page, page.getByRole("button", { name: "Create secret" }), "Create secret");
      await keys.press("Enter");
      const row = page
        .getByRole("table", { name: "Secrets" })
        .locator("tbody tr")
        .filter({ has: page.getByRole("rowheader", { name, exact: true }) });
      await row.waitFor();

      // Reveal it.
      await tabTo(page, row.getByRole("link", { name }), "the secret's link");
      await keys.press("Enter");
      await heading(page, name).waitFor();
      await tabTo(page, page.getByRole("button", { name: "Reveal" }), "Reveal");
      await keys.press("Enter");
      const shown = page.getByLabel("Value", { exact: true });
      await shown.waitFor();
      expect((await shown.textContent()) === value).toBe(true);

      // Issue a token.
      const sections = page.getByRole("navigation", { name: "Sections" });
      await tabTo(
        page,
        sections.getByRole("link", { name: "Machine credentials" }),
        "the credentials link",
      );
      await keys.press("Enter");
      await heading(page, "Machine credentials").waitFor();
      await tabTo(page, page.getByRole("button", { name: "New credential" }), "New credential");
      await keys.press("Enter");
      await tabTo(page, page.getByLabel("Name", { exact: true }), "the credential's name");
      await keys.type(credential);
      await tabTo(
        page,
        page.getByRole("button", { name: "Issue credential", exact: true }),
        "Issue credential",
      );
      await keys.press("Enter");
      const panel = page.getByRole("region", { name: "The token, shown once" });
      await panel.waitFor({ timeout: 60_000 });
      const token = (await panel.getByLabel("Token").textContent()) ?? "";
      expect((await machineCall(web.f, "keys", { env: "env1a", token })).status).toBe(200);

      // Revoke it. The dialog keeps the keyboard, and gives it back when it is closed.
      const issued = page
        .getByRole("table", { name: "Machine credentials" })
        .locator("tbody tr")
        .filter({ has: page.getByRole("rowheader", { name: credential, exact: true }) });
      const revoke = issued.getByRole("button", { name: "Revoke" });
      await tabTo(page, revoke, "Revoke");
      await keys.press("Enter");
      const dialog = page.getByRole("dialog", { name: `Revoke ${credential}` });
      await dialog.waitFor();
      for (let presses = 0; presses < 12; presses += 1) {
        await keys.press("Tab");
        expect(await focusIn(dialog), `after Tab ${String(presses + 1)}`).not.toBe("outside");
      }
      await keys.press("Escape");
      await dialog.waitFor({ state: "detached" });
      expect(await isFocused(revoke), "the focus is back on Revoke").toBe(true);

      await keys.press("Enter");
      await dialog.waitFor();
      await tabTo(page, dialog.getByLabel("Type the name to confirm"), "the confirmation field");
      await keys.type(credential);
      await tabTo(
        page,
        dialog.getByRole("button", { name: "Revoke", exact: true }),
        "the dialog's Revoke",
      );
      await keys.press("Enter");
      await issued.locator(".badge", { hasText: "revoked" }).waitFor({ timeout: 60_000 });
      expect((await machineCall(web.f, "keys", { env: "env1a", token })).status).toBe(401);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 300_000);
});

describe("a narrow screen", () => {
  it("at 360 by 740 the overview, the secrets list, a secret, the credentials and the activity screens have no sideways scroll", async () => {
    const { name } = await seeded();
    await issueFor(web.f, "env1a", { name: `narrow-${randomBytes(8).toString("hex")}` });
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const screens: [string, string, string][] = [
      ["the overview", overviewPath(), "Overview"],
      ["the secrets list", webPath("secrets", at()), "Secrets"],
      ["a secret", webPath("secret", { ...at(), name }), name],
      ["the credentials", webPath("credentials", at()), "Machine credentials"],
      ["the activity", webPath("activity", { org: at().org }), "Activity"],
    ];
    try {
      await page.setViewportSize({ width: 360, height: 740 });
      for (const [label, path, title] of screens) {
        await page.goto(`${web.origin}${path}`);
        await heading(page, title).waitFor();
        await page.waitForLoadState("networkidle");
        if (label !== "a secret") await page.getByRole("table").first().waitFor();
        const sizes = await page.evaluate<{
          view: number;
          page: number;
          body: number;
          moved: number;
        }>(`(() => {
          window.scrollTo(500, 0);
          return {
            view: document.documentElement.clientWidth,
            page: document.documentElement.scrollWidth,
            body: document.body.scrollWidth,
            moved: window.scrollX,
          };
        })()`);
        expect(sizes.view, label).toBe(360);
        // What ends outside the screen, outside a table's own frame: named, so a failure says what to repair.
        const outside = await page.evaluate<string[]>(`
          Array.from(document.querySelectorAll("body *"))
            .filter((element) => element.closest(".scroll") === null || element.classList.contains("scroll"))
            .filter((element) => element.getBoundingClientRect().right > 360.5)
            .map((element) => element.tagName.toLowerCase() + "." + element.className)
        `);
        expect(outside, label).toEqual([]);
        expect(sizes.page, `${label}: the page is wider than the screen`).toBeLessThanOrEqual(360);
        expect(sizes.body, `${label}: the body is wider than the screen`).toBeLessThanOrEqual(360);
        expect(sizes.moved, `${label}: the page moved sideways`).toBe(0);
        // A table wider than the screen moves inside its own frame, and the frame fits.
        const frames = await page.evaluate<number[]>(`
          Array.from(document.querySelectorAll("table")).map((table) => {
            const frame = table.closest(".scroll");
            return frame === null ? -1 : Math.ceil(frame.getBoundingClientRect().right);
          })
        `);
        for (const right of frames) {
          expect(right, `${label}: a table outside a frame`).not.toBe(-1);
          expect(right, `${label}: a table's frame ends outside the screen`).toBeLessThanOrEqual(
            360,
          );
        }
      }
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);
});

describe("another site", () => {
  it("the page cannot be framed: a page of another origin that embeds it gets nothing", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    // A real page of another origin on this machine. (A page made up by the test at a public
    // name is stopped earlier, by the browser's rule about pages that reach into a local network.)
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        `<!doctype html><title>embedder</title><iframe id="inner" src="${web.origin}/" width="600" height="400"></iframe>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const embedder = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const asked: string[] = [];
    const refused: string[] = [];
    try {
      await page.route(`${embedder}/**`, (route) => route.continue());
      page.on("request", (request) => {
        if (request.url() === `${web.origin}/`) asked.push(request.resourceType());
      });
      page.on("requestfailed", (request) => {
        if (request.url() === `${web.origin}/`) refused.push(request.failure()?.errorText ?? "");
      });
      await page.goto(`${embedder}/`);
      await page.waitForLoadState("networkidle");
      // The frame asked for the workspace, and the browser refused the answer because of its headers.
      expect(asked).toEqual(["document"]);
      expect(refused).toEqual(["net::ERR_BLOCKED_BY_RESPONSE"]);
      const shell = await web.api.request("GET", "/");
      expect(shell.status).toBe(200);
      expect(shell.headers.get("x-frame-options")).toBe("DENY");
      expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      // The browser showed none of it: the frame holds its own error page.
      const inner = page.frames().find((frame) => frame !== page.mainFrame());
      expect(inner).toBeDefined();
      expect(inner?.url()).toMatch(/^chrome-error:/);
      const reachable = await page.evaluate(`(() => {
        try {
          const frame = document.getElementById("inner");
          return frame.contentDocument === null ? "nothing" : frame.contentDocument.title;
        } catch (error) {
          return "nothing";
        }
      })()`);
      expect(reachable).toBe("nothing");
      // No script of the workspace ran in the frame, so it asked the API for nothing.
      expect(session.requested.filter((url) => url.includes("/v1/"))).toEqual([]);
    } finally {
      await session.close();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });
});

describe("the content policy", () => {
  it("an inline script, a script of another origin and an inline style are refused by the browser", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${overviewPath()}`);
      await heading(page, "Overview").waitFor();
      expect(await session.violations()).toEqual([]);
      // What an injected markup would try: each is put into the page, and none takes effect.
      await page.evaluate(`(() => {
        const inline = document.createElement("script");
        inline.textContent = "window.__ran = 1";
        document.head.appendChild(inline);
        const foreign = document.createElement("script");
        foreign.src = "https://cdn.invalid/x.js";
        document.head.appendChild(foreign);
        const styled = document.createElement("p");
        styled.id = "styled";
        styled.setAttribute("style", "position: fixed");
        document.body.appendChild(styled);
      })()`);
      await page.waitForFunction("window.__capture.violations.length >= 3");
      const violations = await session.violations();
      expect(violations.map((violation) => violation.directive).sort()).toEqual([
        "script-src-elem",
        "script-src-elem",
        "style-src-attr",
      ]);
      expect(violations.map((violation) => violation.blocked).sort()).toEqual([
        "https://cdn.invalid/x.js",
        "inline",
        "inline",
      ]);
      expect(await page.evaluate("typeof window.__ran")).toBe("undefined");
      expect(
        await page.evaluate(`getComputedStyle(document.getElementById("styled")).position`),
      ).toBe("static");
      // The other origin was never asked.
      expect(session.thirdParty).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

describe("without colours", () => {
  it("every state badge on the overview has text, with colours switched off (forced-colors)", async () => {
    await issueFor(web.f, "env1a", { name: "colours" });
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.emulateMedia({ forcedColors: "active" });
      await page.goto(`${web.origin}${overviewPath()}`);
      await page.getByRole("region", { name: "Project One" }).waitFor();
      await page.getByRole("table", { name: "Credentials by state" }).waitFor();
      expect(await page.evaluate(`matchMedia("(forced-colors: active)").matches`)).toBe(true);
      const badges = page.locator(".badge");
      const texts = await badges.allTextContents();
      // Two projects, three environments and the six credential states.
      expect(texts.length).toBeGreaterThanOrEqual(11);
      for (const text of texts)
        expect(text, `a badge without a word: "${text}"`).toMatch(/[a-z]{4,}/);
      for (const badge of await badges.all()) {
        const box = await badge.boundingBox();
        expect(box === null ? 0 : box.width, "a badge with no size").toBeGreaterThan(20);
      }
    } finally {
      await session.close();
    }
  });
});

describe("labels and what cannot be read", () => {
  it("every field and every button of every screen has a name, and a field's error is tied to the field", async () => {
    const { name } = await seeded();
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const screens: [string, string][] = [
      [overviewPath(), "Overview"],
      [webPath("secrets", at()), "Secrets"],
      [webPath("secret", { ...at(), name }), name],
      [webPath("credentials", at()), "Machine credentials"],
      [webPath("operations", at()), "Operations"],
      [webPath("import", at()), "Import and export"],
      [webPath("activity", { org: at().org }), "Activity"],
      [webPath("audit", { org: at().org }), "Audit"],
      [webPath("account", {}), "Account"],
      [webPath("help", {}), "Help"],
    ];
    try {
      for (const [path, title] of screens) {
        await page.goto(`${web.origin}${path}`);
        await heading(page, title).waitFor();
        await page.waitForLoadState("networkidle");
        // Open what the screen can open, so that its forms are looked at too.
        for (const opener of ["New secret", "New credential", "New project", "Edit value"]) {
          const button = page.getByRole("button", { name: opener, exact: true });
          if ((await button.count()) === 1) await button.click();
        }
        const unnamed = await page.evaluate<string[]>(`
          Array.from(document.querySelectorAll("input, select, textarea, button, a[href]"))
            .filter((control) => {
              const labelled =
                (control.labels && control.labels.length > 0) ||
                (control.getAttribute("aria-label") || "").trim() !== "" ||
                control.hasAttribute("aria-labelledby");
              const text = (control.textContent || "").trim();
              return control.matches("input, select, textarea") ? !labelled : text === "" && !labelled;
            })
            .map((control) => control.outerHTML.slice(0, 120))
        `);
        expect(unnamed, title).toEqual([]);
      }

      // A field's own error: announced, and tied to the field it is about.
      await page.goto(`${web.origin}${webPath("secrets", at())}`);
      await page.getByRole("button", { name: "New secret" }).click();
      const field = page.getByLabel("Name", { exact: true });
      await field.fill("not a valid name");
      await page.getByRole("button", { name: "Create secret" }).click();
      await page.locator(".field-error").first().waitFor();
      expect(await field.getAttribute("aria-invalid")).toBe("true");
      const described = (await field.getAttribute("aria-describedby")) ?? "";
      const tied = await page.evaluate<string[]>(
        `${JSON.stringify(described.split(" "))}.map((id) => {
          const element = document.getElementById(id);
          return element === null ? "missing" : element.className + ":" + (element.getAttribute("role") || "");
        })`,
      );
      expect(tied).toContain("field-error:alert");
      expect(tied).not.toContain("missing");
    } finally {
      await session.close();
    }
  }, 240_000);

  it("a list the activity's filter cannot read is said, not shown as an empty list", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${webPath("activity", { org: at().org })}`);
      await heading(page, "Activity").waitFor();
      await page.route(new RegExp("/environments[?]"), (route) => route.abort("connectionreset"));
      await page
        .getByLabel("Project", { exact: true })
        .last()
        .selectOption({ label: "Project One" });
      await alertOf(page, "No usable answer came back").waitFor();
      await page.getByText("The environments of this project could not be read.").waitFor();
      // The timeline itself is still there, for the whole project.
      await page.getByRole("table", { name: "Activity" }).waitFor();
    } finally {
      await session.close();
    }
  });
});

const SERVER_TEXT = "raw text of the server 7f3a";

/** Answers the page's next create-secret request with the contract's refusal for `code`. */
async function refuseCreate(page: Page, code: ErrorCode): Promise<string> {
  const requestId = randomUUID();
  await page.route(new RegExp("/secrets$"), async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: ERROR_CODES[code].status,
      contentType: "application/json; charset=utf-8",
      headers: { "x-request-id": requestId },
      body: JSON.stringify({ error: { code, message: SERVER_TEXT, requestId } }),
    });
  });
  return requestId;
}

async function fillNewSecret(page: Page, name: string, value: string): Promise<void> {
  await page.goto(`${web.origin}${webPath("secrets", at())}`);
  await heading(page, "Secrets").waitFor();
  await page.getByRole("button", { name: "New secret" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Value", { exact: true }).fill(value);
}

const alertOf = (page: Page, title: string): Locator =>
  page.getByRole("alert").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

/** What every refusal must hold: its own words, never the code alone, never the server's text. */
async function expectOwnText(shown: Locator, code: ErrorCode, own: RegExp): Promise<void> {
  const text = (await shown.textContent()) ?? "";
  expect(text, code).toMatch(own);
  expect(text, `${code}: the raw code is shown`).not.toContain(code);
  expect(text, `${code}: the server's text is shown`).not.toContain(SERVER_TEXT);
}

describe("each of the nine failure classes of FR-1.93 shows its own text and never the raw code alone", () => {
  it("hidden or absent (the server's 404)", async () => {
    const { name } = await seeded();
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const refused: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 404) refused.push(new URL(response.url()).pathname);
    });
    try {
      // A name the environment does not list: the page says so, and offers nothing.
      await page.goto(`${web.origin}${webPath("secret", { ...at(), name: "ABSENT_NAME" })}`);
      await page
        .getByText("There is no secret with this name in this environment.")
        .first()
        .waitFor();
      await expectOwnText(page.getByRole("main"), "not_found", /There is no secret with this name/);
      expect(await page.getByRole("button", { name: "Reveal" }).count()).toBe(0);

      // A secret that is gone after the page listed it: the server's 404, explained.
      await page.goto(`${web.origin}${webPath("secret", { ...at(), name })}`);
      await page.getByRole("button", { name: "Reveal" }).waitFor();
      await web.api.superuser.query(
        "UPDATE app.secret_index SET name = name || '_GONE' WHERE environment_id = $1 AND name = $2",
        [web.tenants.a.env1a, name],
      );
      await page.getByRole("button", { name: "Reveal" }).click();
      const gone = alertOf(page, "Not found");
      await gone.waitFor();
      await expectOwnText(gone, "not_found", /does not exist, or it is not visible to you/);
      expect(refused).toHaveLength(1);
      expect(await page.getByLabel("Value", { exact: true }).count()).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("an expired session (the server's 401)", async () => {
    const mine = await signInComplete(web.api, web.tenants.credentials("editorA"));
    const session = await web.withCookie(mine.cookie);
    const { page } = session;
    const value = canary();
    try {
      await fillNewSecret(page, newName(), value);
      await web.api.superuser.query("DELETE FROM auth.session WHERE id = $1", [mine.sessionId]);
      await page.getByRole("button", { name: "Create secret" }).click();
      await heading(page, "Sign in").waitFor();
      await expectOwnText(
        page.getByRole("main"),
        "unauthenticated",
        /Your session ended\. Sign in again\./,
      );
      expect((await page.content()).includes(value)).toBe(false);
    } finally {
      await session.close();
    }
  });

  it("fresh verification (the server's 403)", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${webPath("credentials", at())}`);
      await page.getByRole("button", { name: "New credential" }).click();
      await page.getByLabel("Name", { exact: true }).fill("not issued");
      await web.api.superuser.query(
        "UPDATE auth.session SET totp_verified_at = now() - interval '20 minutes'",
      );
      await page.getByRole("button", { name: "Issue credential", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Confirm with your authenticator" });
      await dialog.waitFor();
      await dialog.getByLabel("Code from your authenticator app").waitFor();
      await expectOwnText(dialog, "fresh_verification_required", /authenticator/);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      // Nothing was issued, and the form still holds what was typed.
      expect(await page.getByLabel("Name", { exact: true }).inputValue()).toBe("not issued");
      expect(await page.getByRole("region", { name: "The token, shown once" }).count()).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("a version conflict (the server's 409)", async () => {
    const { name, written } = await seeded();
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const mine = canary();
    try {
      await page.goto(`${web.origin}${webPath("secret", { ...at(), name })}`);
      await page.getByRole("button", { name: "Edit value" }).click();
      await page.getByText("This form was opened on version 1.").waitFor();
      const other = await web.f.update("env1a", name, canary(), written);
      expect(other.status, other.code ?? "").toBe(200);
      await page.getByLabel("New value").fill(mine);
      await page.getByRole("button", { name: "Save" }).click();
      const conflict = alertOf(page, "The secret changed since you opened it");
      await conflict.waitFor();
      await expectOwnText(conflict, "version_conflict", /nothing was overwritten/);
      expect(await conflict.getByRole("button").allTextContents()).toEqual(["Reload", "Cancel"]);
      expect((await page.content()).includes(mine)).toBe(false);
    } finally {
      await session.close();
    }
  });

  it("review (the server's 409)", async () => {
    const { name } = await seeded();
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${webPath("secret", { ...at(), name })}`);
      await page.getByRole("button", { name: "Reveal" }).waitFor();
      await web.api.superuser.query(
        "UPDATE app.secret_index SET state = 'needs_review' WHERE environment_id = $1 AND name = $2",
        [web.tenants.a.env1a, name],
      );
      await page.getByRole("button", { name: "Reveal" }).click();
      const review = alertOf(page, "This secret is under review");
      await review.waitFor();
      await expectOwnText(review, "key_under_review", /An operator settles this from the host/);
      expect(await review.getByRole("button").count()).toBe(0);
      expect(await page.getByLabel("Value", { exact: true }).count()).toBe(0);
    } finally {
      await session.close();
    }
  });

  const answered: [string, ErrorCode, string, RegExp][] = [
    [
      "a state conflict",
      "state_conflict",
      "Not possible in the current state",
      /Reload to see the current state/,
    ],
    [
      "backend sealed",
      "backend_sealed",
      "The secret store is sealed",
      /An operator unseals it from the host \(runbook kms-and-unseal\.md\)/,
    ],
    [
      "audit unavailable",
      "audit_unavailable",
      "The action could not be recorded",
      /so the action was not performed/,
    ],
    [
      "capacity",
      "capacity_exceeded",
      "No room for this",
      /ask the operator about the host's space/,
    ],
  ];

  it.each(answered)(
    "%s (the contract's answer for %s, given by the harness)",
    async (_label, code, title, own) => {
      const session = await web.signedIn("ownerA");
      const { page } = session;
      const name = newName();
      const value = canary();
      try {
        await fillNewSecret(page, name, value);
        const requestId = await refuseCreate(page, code);
        await page.getByRole("button", { name: "Create secret" }).click();
        const alert = alertOf(page, title);
        await alert.waitFor();
        await expectOwnText(alert, code, own);
        // The id to quote is the one the answer carried.
        expect(await alert.locator("dd code").allTextContents()).toEqual([requestId]);
        // Nothing reached the server, and nothing was written.
        expect(await web.f.backend("env1a", name)).toBeNull();
        expect(await session.violations()).toEqual([]);
      } finally {
        await session.close();
      }
    },
  );
});
