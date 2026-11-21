// Run 9.0 (FR-1.89 to FR-1.97, H-06, the owner's request): finding one's way
// in the workspace. A first visit lands on Home; a sidebar names where the
// owner is and what can be done there; breadcrumbs carry every id one click
// from the clipboard; the environment tabs keep the section; a narrow window
// gets a drawer; the keyboard reaches all of it in order; and navigation
// never offers what the server would refuse.
import { randomBytes } from "node:crypto";
import { webPath } from "@mykey/contracts";
import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueFor } from "../harness/credentials-fixture.ts";
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
      await page.locator("body").click({ position: { x: 1, y: 1 } });
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
