// Run 7.1 Task B (P-134, P-136, P-141, FR-1.89, FR-1.93): the workspace's
// shell in Chromium, served by the test API on the origin it checks. The
// page loads under its policy with nothing from elsewhere, shows no workspace
// without a session, names the scope, sends a real cookie POST, and explains
// three refusals from the one error table.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { windowSecondsLeft } from "@mykey/api";
import { WEB_ROUTES, webPath } from "@mykey/contracts";
import type { Locator } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web, type WebSession } from "../harness/web.ts";

let web: Web;

beforeAll(async () => {
  web = await startWeb();
}, 300_000);

afterAll(async () => {
  await web.close();
});

const overview = (): string => webPath("overview", { org: web.tenants.a.organizationId });
// Run 9.0 (P-162): the scope bar's three selects became the breadcrumbs (navigation
// "Scope") and the sidebar (navigation "Sections"); the assertions are the same.
const scopeOf = (session: WebSession): Locator =>
  session.page.getByRole("navigation", { name: "Scope" });
const sectionsOf = (session: WebSession): Locator =>
  session.page.getByRole("navigation", { name: "Sections" });

/** The sidebar with the organization's projects loaded. */
async function openOverview(session: WebSession): Promise<Locator> {
  await session.page.goto(`${web.origin}${overview()}`);
  const sections = sectionsOf(session);
  await sections.getByRole("link", { name: "Project One", exact: true }).waitFor();
  return sections;
}

describe("the workspace's shell", () => {
  it("loads with zero policy violations and zero third-party requests, and requests only its document, its script and its stylesheet before the first API call", async () => {
    const session = await web.signedIn("ownerA");
    try {
      const answer = await session.page.goto(`${web.origin}/`, { waitUntil: "load" });
      expect(answer?.status()).toBe(200);
      await scopeOf(session).waitFor();
      await session.page.waitForLoadState("networkidle");

      const paths = session.requested.map((url) => new URL(url).pathname);
      const firstCall = paths.findIndex((path) => path.startsWith("/v1/"));
      expect(firstCall).toBe(3);
      const before = paths.slice(0, firstCall);
      expect(before[0]).toBe("/");
      expect(before.filter((path) => /^\/assets\/app-[A-Z0-9]+\.js$/.test(path))).toHaveLength(1);
      expect(before.filter((path) => /^\/assets\/app-[A-Z0-9]+\.css$/.test(path))).toHaveLength(1);
      expect(session.requested.every((url) => new URL(url).origin === web.origin)).toBe(true);
      expect(session.thirdParty).toEqual([]);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("without a session every workspace path shows the sign-in screen", async () => {
    const session = await web.anonymous();
    const { a } = web.tenants;
    const params = {
      org: a.organizationId,
      project: a.project1,
      env: a.env1a,
      name: "API_KEY",
      article: "project-id",
    };
    try {
      // The reset screen is for someone who is not signed in: it is not a workspace path.
      for (const route of WEB_ROUTES.filter((candidate) => candidate.id !== "reset")) {
        const answer = await session.page.goto(`${web.origin}${webPath(route.id, params)}`);
        expect(answer?.status(), route.id).toBe(200);
        await session.page.getByRole("heading", { name: "Sign in", level: 1 }).waitFor();
        expect(await scopeOf(session).count(), route.id).toBe(0);
        expect(await session.page.getByText("Project One").count(), route.id).toBe(0);
      }
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("as ownerA the breadcrumbs name the organization, and after choosing a project and an environment they name all three", async () => {
    const session = await web.signedIn("ownerA");
    const { a } = web.tenants;
    try {
      // One organization: the entry path leads to it.
      await session.page.goto(`${web.origin}/`);
      await session.page.waitForURL(`${web.origin}${overview()}`);
      const scope = scopeOf(session);
      const sections = sectionsOf(session);
      await sections.getByRole("link", { name: "Project One", exact: true }).waitFor();
      // An organization has no name in Stage 1: its id (copyable) and the caller's role.
      expect(await scope.textContent()).toContain(a.organizationId);
      expect(await session.page.locator(".org-block").first().textContent()).toContain("owner");
      expect(await scope.getByRole("listitem").count()).toBe(1);

      await sections.getByRole("link", { name: "Project One", exact: true }).click();
      await session.page.waitForURL(
        `${web.origin}${webPath("project", { org: a.organizationId, project: a.project1 })}`,
      );
      const environments = sections.getByRole("list", { name: "Environments of Project One" });
      await environments.getByRole("link", { name: "prod", exact: true }).waitFor();
      await environments.getByRole("link", { name: "dev", exact: true }).click();
      await session.page.waitForURL(
        `${web.origin}${webPath("secrets", { org: a.organizationId, project: a.project1, env: a.env1a })}`,
      );

      const named = async (): Promise<string[]> => scope.getByRole("link").allTextContents();
      expect(await named()).toEqual(["Organization", "Project One", "dev"]);
      expect(await scope.textContent()).toContain(a.organizationId);
      // The address is the scope: loading it again names the same three.
      await session.page.reload();
      await scope.getByRole("link", { name: "dev", exact: true }).waitFor();
      expect(await named()).toEqual(["Organization", "Project One", "dev"]);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  // Run 8.0 Task C (FR-1.102): the owner reads what the service does not do
  // in the page itself, not only in the repository.
  it("the help shows the known limits: every heading of known-limits.md is on the page", async () => {
    const text = readFileSync(
      join(import.meta.dirname, "..", "..", "docs", "runbooks", "known-limits.md"),
      "utf8",
    );
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((match) => (match[1] ?? "").trim());
    // A code span is shown as code: its text without the backticks.
    const items = [...text.matchAll(/^- \*\*(.+?)\*\*/gm)].map((match) =>
      (match[1] ?? "").replaceAll("`", "").trim(),
    );
    expect(headings.length).toBeGreaterThanOrEqual(5);
    expect(items.length).toBeGreaterThanOrEqual(30);
    const session = await web.signedIn("ownerA");
    try {
      // Run 9.0: the known limits are the help article "What MyKey does not do".
      await session.page.goto(`${web.origin}/help/known-limits`);
      const limits = session.page.getByRole("region", { name: "Known limits" });
      await limits.waitFor();
      for (const heading of headings) {
        await limits.getByRole("heading", { name: heading, exact: true }).waitFor();
      }
      const shown = (await limits.textContent()) ?? "";
      for (const item of items) expect(shown, item).toContain(item);
      expect(shown).not.toMatch(/\*\*|`/);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("one real cookie POST from the page succeeds", async () => {
    const session = await web.signedIn("ownerA");
    try {
      await openOverview(session);
      const [response] = await Promise.all([
        session.page.waitForResponse(
          (candidate) => new URL(candidate.url()).pathname === "/v1/session/activity",
        ),
        session.page.getByRole("heading", { level: 1 }).click(),
      ]);
      expect(response.request().method()).toBe("POST");
      expect(response.status()).toBe(200);
      // The browser's own header: the origin the API checks, rewritten by nobody.
      expect(await response.request().headerValue("origin")).toBe(web.origin);
      const body = (await response.json()) as Record<string, unknown>;
      expect(typeof body.idleExpiresAt).toBe("string");
    } finally {
      await session.close();
    }
  });

  it("a seeded 503 quarantined, a 429 and a cut connection each show their text from the error table with the request id where there is one", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const environments = /\/v1\/organizations\/[^/]+\/projects\/[^/]+\/environments/;
    const panel = page.getByRole("alert");
    const refused = (): Promise<{ status: number; requestId: string }> =>
      page
        .waitForResponse((candidate) => environments.test(new URL(candidate.url()).pathname))
        .then((response) => ({
          status: response.status(),
          requestId: response.headers()["x-request-id"] ?? "",
        }));
    try {
      const sections = await openOverview(session);
      const link = (name: string): Locator => sections.getByRole("link", { name, exact: true });

      // 1. A closed gate.
      web.api.setGate("closed");
      let answer = refused();
      await link("Project One").click();
      let seen = await answer;
      expect(seen.status).toBe(503);
      await panel.getByRole("heading", { name: "The service is not open" }).waitFor();
      expect(await panel.textContent()).toContain("An operator opens it from the host");
      expect(seen.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await panel.textContent()).toContain(seen.requestId);
      web.api.setGate("open");
      await panel.getByRole("button", { name: "Reload" }).click();
      await link("prod").waitFor();
      expect(await panel.count()).toBe(0);

      // 2. A spent budget: this session's counter of the current minute is put over the limit.
      const left = windowSecondsLeft(Date.now());
      if (left < 15) await sleep(left * 1000 + 500);
      await page.reload();
      await link("prod").waitFor();
      const spent = await web.api.superuser.query(
        "UPDATE app.rate_limit SET count = 100000000 WHERE scope = 'rl:session'",
      );
      expect(spent.rowCount).toBeGreaterThan(0);
      answer = refused();
      await link("Project Two").click();
      seen = await answer;
      expect(seen.status).toBe(429);
      await panel.getByRole("heading", { name: "Too many requests" }).waitFor();
      expect(await panel.textContent()).toMatch(/Wait \d+ seconds?\./);
      expect(await panel.textContent()).toContain(seen.requestId);
      await web.api.superuser.query("DELETE FROM app.rate_limit");
      await panel.getByRole("button", { name: "Reload" }).click();
      await link("dev").waitFor();
      expect(await panel.count()).toBe(0);

      // 3. A cut connection: no answer, so no request id, and no claim about the outcome.
      await page.route(environments, (route) => route.abort("connectionreset"));
      await page.reload();
      await panel.getByRole("heading", { name: "No usable answer came back" }).waitFor();
      expect(await panel.textContent()).toContain("Whether the request arrived is not known");
      expect(await panel.textContent()).not.toContain("Request id");
      await page.unroute(environments);
      await panel.getByRole("button", { name: "Reload" }).click();
      await link("dev").waitFor();
      expect(await panel.count()).toBe(0);
      expect(await session.violations()).toEqual([]);
    } finally {
      web.api.setGate("open");
      await web.api.superuser.query("DELETE FROM app.rate_limit");
      await session.close();
    }
  });
});
