// Run 9.0 (FR-1.89 to FR-1.97, H-06, the owner's request): finding one's way
// in the workspace. A first visit lands on Home; a sidebar names where the
// owner is and what can be done there; breadcrumbs carry every id one click
// from the clipboard; the environment tabs keep the section; a narrow window
// gets a drawer; the keyboard reaches all of it in order; and navigation
// never offers what the server would refuse.
import { randomBytes, randomUUID } from "node:crypto";
import { ERROR_CODES, webPath, type ErrorCode } from "@mykey/contracts";
import { ACTIONS, PAGES, STATES } from "@mykey/web";
import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueFor } from "../harness/credentials-fixture.ts";
import { newProject } from "../harness/lifecycle-fixture.ts";
import { machineCall } from "../harness/machine.ts";
import { startWebWithStores, type StoresWeb, type WebSession } from "../harness/web.ts";

let web: StoresWeb;
let secretName = "";

beforeAll(async () => {
  web = await startWebWithStores();
  secretName = `NAV_${randomBytes(4).toString("hex").toUpperCase()}`;
  const value = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
  const created = await web.f.create("env1a", secretName, value);
  expect(created.status, created.text).toBe(201);
}, 600_000);

afterAll(async () => {
  await web.close();
});

const at = () => ({
  org: web.tenants.a.organizationId,
  project: web.tenants.a.project1,
  env: web.tenants.a.env1a,
});
const heading = (page: Page, name: string): Locator =>
  page.getByRole("heading", { level: 1, name, exact: true });
const sidebar = (page: Page): Locator => page.getByRole("navigation", { name: "Sections" });
const scope = (page: Page): Locator => page.getByRole("navigation", { name: "Scope" });

/** Whether the keyboard is on `target`. */
const isFocused = (target: Locator): Promise<boolean> =>
  target.evaluate((element: unknown) => {
    const node = element as { ownerDocument: { activeElement: unknown } };
    return node.ownerDocument.activeElement === element;
  });

async function withClipboard(session: WebSession): Promise<() => Promise<string>> {
  await session.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: web.origin,
  });
  return () => session.page.evaluate<string>("navigator.clipboard.readText()");
}

describe("the frame", () => {
  it("a first visit as ownerA lands on Home, and the sidebar names Home, Projects, Activity, Audit, Help centre, Account", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}/`);
      await page.waitForURL(`${web.origin}${webPath("overview", { org: at().org })}`);
      await heading(page, "Home").waitFor();
      const nav = sidebar(page);
      for (const name of ["Home", "Activity", "Audit", "Help centre", "Account"]) {
        await nav.getByRole("link", { name, exact: true }).waitFor();
      }
      await nav.getByText("Projects", { exact: true }).waitFor();
      await nav.getByRole("link", { name: "Project One", exact: true }).waitFor();
      expect(
        await nav.getByRole("link", { name: "Home", exact: true }).getAttribute("aria-current"),
      ).toBe("page");
      await page.getByRole("button", { name: "Sign out" }).waitFor();
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("on a project, an environment, the secrets list and a secret, the project's id is on the page as text, and Copy id puts exactly that id on the clipboard", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const read = await withClipboard(session);
    const paths = [
      webPath("project", { org: at().org, project: at().project }),
      webPath("secrets", at()),
      webPath("credentials", at()),
      webPath("secret", { ...at(), name: secretName }),
    ];
    try {
      for (const path of paths) {
        await page.goto(`${web.origin}${path}`);
        await page.getByRole("heading", { level: 1 }).waitFor();
        expect(await page.locator("main").textContent(), path).toContain(at().project);
        await page.evaluate("navigator.clipboard.writeText('-')");
        await scope(page).getByRole("button", { name: "Copy project id" }).click();
        await scope(page).getByRole("status").filter({ hasText: "Copied" }).first().waitFor();
        expect(await read(), path).toBe(at().project);
      }
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("the breadcrumbs name organization › project › environment › secret, each a link, each with its id", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const { org, project, env } = at();
    try {
      await page.goto(`${web.origin}${webPath("secret", { ...at(), name: secretName })}`);
      await heading(page, secretName).waitFor();
      const crumbs = scope(page).getByRole("listitem");
      expect(await crumbs.count()).toBe(4);
      const links = scope(page).getByRole("link");
      expect(await links.allTextContents()).toEqual([
        "Organization",
        "Project One",
        "dev",
        secretName,
      ]);
      expect(await links.nth(0).getAttribute("href")).toBe(webPath("overview", { org }));
      expect(await links.nth(1).getAttribute("href")).toBe(webPath("project", { org, project }));
      expect(await links.nth(2).getAttribute("href")).toBe(webPath("secrets", at()));
      expect(await links.nth(3).getAttribute("aria-current")).toBe("page");
      const text = (await scope(page).textContent()) ?? "";
      for (const id of [org, project, env]) expect(text).toContain(id);
      for (const of of ["organization", "project", "environment"]) {
        await scope(page)
          .getByRole("button", { name: `Copy ${of} id` })
          .waitFor();
      }
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("the environment tabs switch environment and keep the section", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const { a } = web.tenants;
    try {
      await page.goto(`${web.origin}${webPath("credentials", at())}`);
      await heading(page, "Machine credentials").waitFor();
      const tabs = page.getByRole("navigation", { name: "Environments" });
      expect(
        await tabs.getByRole("link", { name: "dev", exact: true }).getAttribute("aria-current"),
      ).toBe("page");
      await tabs.getByRole("link", { name: "prod", exact: true }).click();
      await page.waitForURL(`${web.origin}${webPath("credentials", { ...at(), env: a.env1b })}`);
      await heading(page, "Machine credentials").waitFor();
      expect(
        await tabs.getByRole("link", { name: "prod", exact: true }).getAttribute("aria-current"),
      ).toBe("page");
      await page.goBack();
      await page.waitForURL(`${web.origin}${webPath("credentials", at())}`);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("below 1024 px the sidebar is a drawer: Menu opens it, Escape closes it, and focus returns to Menu", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.setViewportSize({ width: 900, height: 800 });
      await page.goto(`${web.origin}${webPath("secrets", at())}`);
      await heading(page, "Secrets").waitFor();
      expect(await sidebar(page).isVisible()).toBe(false);
      const menu = page.getByRole("button", { name: "Menu", exact: true });
      await menu.click();
      const drawer = page.getByRole("dialog", { name: "Menu" });
      await drawer.waitFor();
      await drawer.getByRole("link", { name: "Machine credentials" }).waitFor();
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden" });
      expect(await isFocused(menu)).toBe(true);
      // A link of the drawer goes there and closes it.
      await menu.click();
      await drawer.getByRole("link", { name: "Machine credentials" }).click();
      await heading(page, "Machine credentials").waitFor();
      await drawer.waitFor({ state: "hidden" });
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  // Moved here from access.test.ts (Run 7.7), with the new screens added; its assertions are unchanged.
  it("at 360 by 740 no screen scrolls sideways", async () => {
    await issueFor(web.f, "env1a", { name: `narrow-${randomBytes(8).toString("hex")}` });
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const org = at().org;
    const screens: [string, string, string][] = [
      ["Home", webPath("overview", { org }), "Home"],
      ["a project", webPath("project", { org, project: at().project }), "Project One"],
      ["the secrets list", webPath("secrets", at()), "Secrets"],
      ["a secret", webPath("secret", { ...at(), name: secretName }), secretName],
      ["import and export", webPath("import", at()), "Import and export"],
      ["the credentials", webPath("credentials", at()), "Machine credentials"],
      ["the operations", webPath("operations", at()), "Operations"],
      ["connect", webPath("connect", at()), "Connect an application"],
      ["the activity", webPath("activity", { org }), "Activity"],
      ["the audit", webPath("audit", { org }), "Audit"],
      ["the account", webPath("account"), "Account"],
      ["the help centre", webPath("help"), "Help centre"],
      ["an article", webPath("help-article", { article: "project-id" }), ""],
    ];
    const tables = new Set(["Home", "the secrets list", "the credentials", "the activity"]);
    try {
      await page.setViewportSize({ width: 360, height: 740 });
      for (const [label, path, title] of screens) {
        await page.goto(`${web.origin}${path}`);
        if (title === "") await page.getByRole("heading", { level: 1 }).waitFor();
        else await heading(page, title).waitFor();
        await page.waitForLoadState("networkidle");
        if (tables.has(label)) await page.getByRole("table").first().waitFor();
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
        // What ends outside the screen, outside a table's or a code block's own frame: named, so a failure says what to repair.
        const outside = await page.evaluate<string[]>(`
          Array.from(document.querySelectorAll("body *"))
            .filter((element) => element.closest(".scroll, .code-block pre") === null || element.matches(".scroll, .code-block pre"))
            .filter((element) => element.getClientRects().length > 0)
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
  }, 300_000);

  it("keyboard only: skip link, sidebar, breadcrumbs, the page's primary action, in that order", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${webPath("secrets", at())}`);
      await heading(page, "Secrets").waitFor();
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      const order: [string, Locator][] = [
        ["the skip link", page.getByRole("link", { name: "Skip to the content" })],
        ["the sidebar's Home", sidebar(page).getByRole("link", { name: "Home", exact: true })],
        ["the breadcrumbs' organization", scope(page).getByRole("link", { name: "Organization" })],
        ["the primary action", page.getByRole("button", { name: "New secret", exact: true })],
      ];
      let presses = 0;
      for (const [what, target] of order) {
        await target.waitFor();
        while (!(await isFocused(target))) {
          await page.keyboard.press("Tab");
          presses += 1;
          expect(presses, `Tab never reached ${what}`).toBeLessThan(120);
        }
      }
      // The skip link goes to the content: the next Tab is inside main.
      await page.goto(`${web.origin}${webPath("secrets", at())}`);
      await heading(page, "Secrets").waitFor();
      await page.keyboard.press("Tab");
      expect(await isFocused(order[0]![1])).toBe(true);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      const inMain = await page.evaluate<boolean>(
        "document.activeElement !== null && document.activeElement.closest('main') !== null",
      );
      expect(inMain).toBe(true);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("a member (not owner) sees no New project and no action the server would refuse", async () => {
    const session = await web.signedIn("readerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${webPath("overview", { org: at().org })}`);
      await heading(page, "Home").waitFor();
      await page.waitForLoadState("networkidle");
      expect(await page.getByRole("button", { name: "New project" }).count()).toBe(0);
      expect(await page.getByRole("link", { name: /New project/ }).count()).toBe(0);
      // The sidebar lists only what the server listed for this member.
      const listed = await sidebar(page).getByRole("link").allTextContents();
      expect(listed).not.toContain("Project Two");
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

// Run 9.0 Task D: every screen on the page contract.
describe("the page contract", () => {
  it("every screen has exactly one h1 and its summary from the catalogue", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const org = at().org;
    const screens: [keyof typeof PAGES, string][] = [
      ["overview", webPath("overview", { org })],
      ["project", webPath("project", { org, project: at().project })],
      ["secrets", webPath("secrets", at())],
      ["secret", webPath("secret", { ...at(), name: secretName })],
      ["import", webPath("import", at())],
      ["credentials", webPath("credentials", at())],
      ["operations", webPath("operations", at())],
      ["connect", webPath("connect", at())],
      ["activity", webPath("activity", { org })],
      ["audit", webPath("audit", { org })],
      ["account", webPath("account")],
      ["help", webPath("help")],
    ];
    try {
      for (const [id, path] of screens) {
        await page.goto(`${web.origin}${path}`);
        await page.getByRole("heading", { level: 1 }).waitFor();
        expect(await page.getByRole("heading", { level: 1 }).count(), id).toBe(1);
        await page.getByText(PAGES[id].summary, { exact: true }).waitFor();
        // "How this works" opens and holds the catalogue's points.
        await page.getByText("How this works", { exact: true }).click();
        for (const point of PAGES[id].how) {
          await page.getByText(point, { exact: true }).first().waitFor();
        }
      }
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("every empty list (a new project's environment, an environment with no secret, no credential, no operation) shows its empty state with a primary action that works", async () => {
    const made = await newProject(web.f);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const place = { org: at().org, project: made.projectId, env: made.environmentId };
    try {
      await page.goto(`${web.origin}${webPath("secrets", place)}`);
      const noSecrets = page.getByRole("region", { name: "No secrets yet" });
      await noSecrets.waitFor();
      await noSecrets.getByRole("button", { name: "Add the first secret" }).click();
      await page.getByRole("form", { name: "New secret" }).waitFor();

      await page.goto(`${web.origin}${webPath("credentials", place)}`);
      const noCredentials = page.getByRole("region", { name: "No machine credentials yet" });
      await noCredentials.waitFor();
      await noCredentials.getByRole("button", { name: "Issue the first credential" }).click();
      await page.getByRole("heading", { level: 2, name: "New credential" }).waitFor();

      await page.goto(`${web.origin}${webPath("operations", place)}`);
      const noOperations = page.getByRole("region", { name: "No operations" });
      await noOperations.waitFor();
      await noOperations.getByRole("link", { name: "Go to Secrets" }).click();
      await heading(page, "Secrets").waitFor();
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("every confirmation dialog states its consequence before the button", async () => {
    const name = `confirm-${randomBytes(4).toString("hex")}`;
    await issueFor(web.f, "env1a", { name });
    const session = await web.signedIn("ownerA");
    const { page } = session;
    /** The consequence's text comes before the dialog's confirming button, in the document's order. */
    const before = async (dialog: Locator, text: string, button: string): Promise<void> => {
      await dialog.getByText(text, { exact: true }).waitFor();
      const ordered = await dialog.evaluate(
        (element: unknown, args: { text: string; button: string }) => {
          interface Node {
            textContent: string | null;
            compareDocumentPosition(other: unknown): number;
          }
          const root = element as { querySelectorAll(selector: string): ArrayLike<Node> };
          const said = Array.from(root.querySelectorAll("p")).find(
            (node) => node.textContent === args.text,
          );
          const pressed = Array.from(root.querySelectorAll("button")).find(
            (node) => (node.textContent ?? "").trim() === args.button,
          );
          if (said === undefined || pressed === undefined) return false;
          // DOCUMENT_POSITION_FOLLOWING: the button follows the text.
          return (said.compareDocumentPosition(pressed) & 4) !== 0;
        },
        { text, button },
      );
      expect(ordered, `${text} before ${button}`).toBe(true);
    };
    try {
      await page.goto(`${web.origin}${webPath("credentials", at())}`);
      await heading(page, "Machine credentials").waitFor();
      const row = page.getByRole("row").filter({ hasText: name });
      await row.getByRole("button", { name: "Revoke" }).click();
      let dialog = page.getByRole("dialog");
      await before(dialog, ACTIONS.revoke[0], "Revoke");
      await dialog.getByRole("button", { name: "Cancel" }).click();

      await page.goto(`${web.origin}${webPath("secret", { ...at(), name: secretName })}`);
      await heading(page, secretName).waitFor();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      dialog = page.getByRole("dialog");
      await dialog.getByRole("heading", { name: `Delete ${secretName}` }).waitFor();
      const deleted = (await dialog.locator("p").first().textContent()) ?? "";
      expect(deleted).toMatch(/^Version \d+ stops being readable/);
      await before(dialog, deleted, "Delete");
      await dialog.getByRole("button", { name: "Cancel" }).click();

      await page.goto(`${web.origin}${webPath("import", at())}`);
      await heading(page, "Import and export").waitFor();
      await page.getByRole("button", { name: "Export this environment" }).click();
      dialog = page.getByRole("dialog");
      await before(dialog, ACTIONS.export[0], "Export");
      await before(dialog, ACTIONS.export[1], "Export");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("a state badge's meaning opens on focus and on hover, and Escape closes it", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${webPath("secrets", at())}`);
      const row = page
        .getByRole("table", { name: "Secrets" })
        .locator("tbody tr")
        .filter({ has: page.getByRole("rowheader", { name: secretName, exact: true }) });
      await row.waitFor();
      const badge = row.locator(".tip-anchor");
      const tip = page.getByRole("tooltip").filter({ hasText: STATES.index.live.meaning });
      await badge.focus();
      await tip.waitFor();
      await page.keyboard.press("Escape");
      await tip.waitFor({ state: "hidden" });
      await page.getByRole("heading", { level: 1 }).hover();
      await badge.hover();
      await tip.waitFor();
      expect(await tip.textContent()).toContain(STATES.index.live.next);
      await page.keyboard.press("Escape");
      await tip.waitFor({ state: "hidden" });
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("an ErrorPanel for each code links to that code's troubleshooting entry", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    let code: ErrorCode = "not_found";
    // A 401 ends the session on the page (no panel): it has its own case in auth.test.ts.
    const codes = (Object.keys(ERROR_CODES) as ErrorCode[]).filter(
      (candidate) => ERROR_CODES[candidate].status !== 401,
    );
    const requestId = randomUUID();
    const projects = /\/v1\/organizations\/[^/]+\/projects(\?.*)?$/;
    await page.route(projects, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({
        status: ERROR_CODES[code].status,
        contentType: "application/json; charset=utf-8",
        headers: { "x-request-id": requestId },
        body: JSON.stringify({ error: { code, message: "seeded", requestId } }),
      });
    });
    try {
      for (const next of codes) {
        code = next;
        await page.goto(`${web.origin}${webPath("overview", { org: at().org })}`);
        const link = page
          .getByRole("alert")
          .first()
          .getByRole("link", { name: "Learn more about this message" });
        await link.waitFor();
        expect(await link.getAttribute("href"), code).toBe(`/help/errors#error-${code}`);
      }
      await page.unroute(projects);
      await page.goto(`${web.origin}/help/errors#error-not_found`);
      await page.locator("#error-not_found").waitFor();
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);
});

// Run 9.0 Task E: getting started, and Connect an application.
describe("getting started and connecting", () => {
  it('"Getting started" on Home reads its six steps from the server\'s facts, and hides when the steps it can see are done', async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const home = webPath("overview", { org: at().org });
    const list = page.getByRole("region", { name: "Getting started" });
    const step = (title: string): Locator => list.getByRole("listitem").filter({ hasText: title });
    try {
      await page.goto(`${web.origin}${home}`);
      await list.waitFor();
      expect(await list.getByRole("listitem").count()).toBe(6);
      await step("Create a project").getByText("Done", { exact: true }).waitFor();
      await step("Add your secrets").getByText("Done", { exact: true }).waitFor();
      await step("Install the CLI").getByText("Not checked", { exact: true }).waitFor();
      await step("See what happened").getByRole("link", { name: "Activity" }).waitFor();
      // No machine has read yet: "not seen", never done.
      expect(await step("Start your application").textContent()).not.toContain("Done");

      // A credential, then a machine's read: the steps change from the server's answers.
      const issued = await issueFor(web.f, "env1a", {
        name: `started-${randomBytes(4).toString("hex")}`,
      });
      const before = session.requested.length;
      await page.reload();
      await step("Issue a machine credential").getByText("Done", { exact: true }).waitFor();
      await page.waitForLoadState("networkidle");
      // D-61 bounds a Home load at six requests; with a credential active, Getting started
      // adds one: the audit log's newest successful machine read, one row.
      const load = session.requested
        .slice(before)
        .map((url) => new URL(url))
        .filter((url) => url.pathname.startsWith("/v1/"));
      expect(load.length, load.map((url) => url.pathname).join(" ")).toBeLessThanOrEqual(7);
      const audit = load.filter((url) => url.pathname.endsWith("/audit"));
      expect(audit.map((url) => Object.fromEntries(url.searchParams))).toEqual([
        { actorKind: "machine", outcome: "success", limit: "1" },
      ]);
      const read = await machineCall(web.f, "keys", { env: "env1a", token: issued.token });
      expect(read.status).toBe(200);
      await page.reload();
      await heading(page, "Home").waitFor();
      await page.waitForLoadState("networkidle");
      expect(await list.count()).toBe(0);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("Connect an application shows the project id, the environment name and the page's origin in its commands, and Copy copies one block", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const read = await withClipboard(session);
    try {
      await page.goto(`${web.origin}${webPath("connect", at())}`);
      await heading(page, "Connect an application").waitFor();
      const variables = page.getByLabel("Name the service and the environment", { exact: true });
      const text = (await variables.textContent()) ?? "";
      expect(text).toContain(`export SECRETS_API_URL="${web.origin}"`);
      expect(text).toContain(`export SECRETS_PROJECT="${at().project}"`);
      expect(text).toContain('export SECRETS_ENVIRONMENT="dev"');
      const block = page.locator(".code-block").filter({ has: variables });
      await block.getByRole("button", { name: "Copy" }).click();
      await block.getByRole("status").filter({ hasText: "Copied" }).waitFor();
      expect((await read()).replaceAll("\r\n", "\n")).toBe(text);
      // The token is never filled in; its step is one block, the runbook's silent
      // command (Run 10.1, F-9.2-1), and comes before the token is issued.
      const store = page.getByLabel("Store the token", { exact: true });
      const storeText = (await store.textContent()) ?? "";
      expect(storeText).toMatch(/^bash -c '/);
      expect(await page.getByLabel("Store the token, part 2", { exact: true }).count()).toBe(0);
      const storeBlock = page.locator(".code-block").filter({ has: store });
      await storeBlock.getByRole("button", { name: "Copy" }).click();
      await storeBlock.getByRole("status").filter({ hasText: "Copied" }).waitFor();
      expect((await read()).replaceAll("\r\n", "\n")).toBe(storeText);
      expect(await page.locator("main").textContent()).not.toMatch(/hv[sbr]\.[A-Za-z0-9_-]{20,}/);
      // The server tab: the runbook for a server, filled in the same way.
      await page.getByRole("button", { name: "A server (systemd or Docker)" }).click();
      const server = page.getByLabel("Name the application, the service and the environment", {
        exact: true,
      });
      expect(await server.textContent()).toContain(`export SECRETS_PROJECT="${at().project}"`);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('the "no application yet" variant prints names only', async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${webPath("connect", at())}`);
      await heading(page, "Connect an application").waitFor();
      await page.getByLabel(/No application yet/).check();
      await page.getByRole("heading", { name: "Start a command that prints names only" }).waitFor();
      const commands = (await page.locator("main .code-block pre").allTextContents()).join("\n");
      // F-10.0-1: names only, also of a value with several lines.
      expect(commands).toContain('awk "BEGIN { for (k in ENVIRON) print k }" | sort');
      expect(commands).not.toContain("env | cut");
      expect(commands).not.toContain("APP_");
      expect(await page.locator("main").textContent()).not.toContain("APP_START");
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

// Run 9.0 Task G: Ctrl K.
describe("the command palette", () => {
  it('Ctrl K opens the palette, typing "cred" offers Machine credentials of the current environment, Enter goes there, Escape closes and returns focus', async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${webPath("secrets", at())}`);
      await heading(page, "Secrets").waitFor();
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Go to" });
      await palette.waitFor();
      await page.keyboard.type("cred");
      const first = palette.getByRole("option").first();
      expect(await first.textContent()).toContain("Machine credentials");
      expect(await first.getAttribute("aria-selected")).toBe("true");
      await page.keyboard.press("Enter");
      await page.waitForURL(`${web.origin}${webPath("credentials", at())}`);
      await heading(page, "Machine credentials").waitFor();
      await palette.waitFor({ state: "hidden" });

      const opener = page.getByRole("button", { name: /^Go to/ });
      await opener.click();
      await palette.waitFor();
      await page.keyboard.press("Escape");
      await palette.waitFor({ state: "hidden" });
      expect(await isFocused(opener)).toBe(true);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("after sign-out and sign-in as another user the palette holds none of the first user's projects", async () => {
    const first = await web.signedIn("ownerA");
    try {
      await first.page.goto(`${web.origin}${webPath("overview", { org: at().org })}`);
      await heading(first.page, "Home").waitFor();
      await first.page.keyboard.press("Control+k");
      const palette = first.page.getByRole("dialog", { name: "Go to" });
      await first.page.keyboard.type("Project One");
      await palette
        .getByRole("option", { name: /Project One/ })
        .first()
        .waitFor();
      await first.page.keyboard.press("Escape");
      await first.page.getByRole("button", { name: "Sign out" }).click();
      await first.page.getByRole("heading", { level: 1, name: "Sign in" }).waitFor();
      // Signed out, there is no palette to open.
      await first.page.keyboard.press("Control+k");
      expect(await first.page.getByRole("dialog", { name: "Go to" }).count()).toBe(0);
    } finally {
      await first.close();
    }
    const second = await web.signedIn("ownerB");
    try {
      await second.page.goto(`${web.origin}/`);
      await heading(second.page, "Home").waitFor();
      await second.page.keyboard.press("Control+k");
      const palette = second.page.getByRole("dialog", { name: "Go to" });
      await palette.waitFor();
      await second.page.keyboard.type("Project");
      const offered = await palette.getByRole("option").allTextContents();
      // Org B has its own "Project One" (tenants.ts); org A's "Project Two" is not offered.
      expect(offered.some((text) => text.includes("Project Two"))).toBe(false);
      await second.page.keyboard.type(" One");
      await second.page.keyboard.press("Enter");
      await second.page.waitForURL(
        `${web.origin}${webPath("project", { org: web.tenants.b.organizationId, project: web.tenants.b.project1 })}`,
      );
      expect(await second.violations()).toEqual([]);
    } finally {
      await second.close();
    }
  });
});
