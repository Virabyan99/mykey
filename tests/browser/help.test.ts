// Run 9.0 Task F (FR-1.97, the owner's request "find answers"): the help
// centre in Chromium. Every article renders and links only to the
// workspace's own paths; "?" on each screen opens that screen's help; back
// and forward work between articles; and the error A to Z has an entry for
// every code the error table explains.
import { ERROR_CODES, WEB_ROUTES, matchWebRoute, webPath } from "@mykey/contracts";
import { ARTICLES, PAGES } from "@mykey/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWeb, type Web } from "../harness/web.ts";

let web: Web;

beforeAll(async () => {
  web = await startWeb();
}, 300_000);

afterAll(async () => {
  await web.close();
});

describe("the help centre", () => {
  it("every article renders and every screen link in it is a WEB_ROUTES path", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      for (const article of ARTICLES) {
        await page.goto(`${web.origin}${webPath("help-article", { article: article.id })}`);
        await page.getByRole("heading", { level: 1, name: article.title, exact: true }).waitFor();
        const hrefs = await page
          .locator("main a[href]")
          .evaluateAll((links: unknown[]) =>
            links.map((link) =>
              (link as { getAttribute(name: string): string }).getAttribute("href"),
            ),
          );
        for (const href of hrefs) {
          if (href === "#content" || href === "/v1/reference") continue;
          const path = href.split("#")[0] ?? "";
          expect(matchWebRoute(path), `${article.id}: ${href}`).not.toBeNull();
        }
      }
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("the help centre's search finds the answer and opens it", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${webPath("help")}`);
      await page.getByRole("heading", { level: 1, name: "Help centre" }).waitFor();
      await page.getByLabel("Search the help").fill("lost phone");
      const results = page.getByRole("list", { name: "Results" });
      await results.getByRole("link").first().waitFor();
      expect(await results.getByRole("link").first().textContent()).toBe(
        "I lost my phone or my authenticator",
      );
      await results.getByRole("link").first().click();
      await page.waitForURL(`${web.origin}/help/lost-authenticator`);
      // Every category is listed, and every article is reachable from the help centre.
      await page.goto(`${web.origin}${webPath("help")}`);
      await page.getByRole("heading", { level: 1, name: "Help centre" }).waitFor();
      const linked = await page
        .locator("main a[href^='/help/']")
        .evaluateAll((links: unknown[]) =>
          links.map((link) =>
            (link as { getAttribute(name: string): string }).getAttribute("href"),
          ),
        );
      for (const article of ARTICLES) expect(linked, article.id).toContain(`/help/${article.id}`);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("? on each screen opens that screen's article", async () => {
    const { a } = web.tenants;
    const org = a.organizationId;
    const at = { org, project: a.project1, env: a.env1a };
    const screens: [keyof typeof PAGES, string][] = [
      ["overview", webPath("overview", { org })],
      ["project", webPath("project", { org, project: a.project1 })],
      ["secrets", webPath("secrets", at)],
      ["import", webPath("import", at)],
      ["credentials", webPath("credentials", at)],
      ["operations", webPath("operations", at)],
      ["connect", webPath("connect", at)],
      ["activity", webPath("activity", { org })],
      ["audit", webPath("audit", { org })],
      ["account", webPath("account")],
      ["help", webPath("help")],
    ];
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      for (const [id, path] of screens) {
        await page.goto(`${web.origin}${path}`);
        await page.getByRole("heading", { level: 1 }).waitFor();
        await page.getByRole("button", { name: "Help for this page" }).click();
        const panel = page.getByRole("dialog", { name: `Help: ${PAGES[id].title}` });
        await panel.waitFor();
        const article = ARTICLES.find((candidate) => candidate.id === PAGES[id].help);
        await panel.getByRole("heading", { name: article?.title ?? "", exact: true }).waitFor();
        await panel.getByRole("link", { name: "Read the article" }).click();
        await page.waitForURL(`${web.origin}/help/${PAGES[id].help}`);
        await panel.waitFor({ state: "hidden" });
      }
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 180_000);

  it("back and forward work between articles", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}/help/rotate-token`);
      await page.getByRole("heading", { level: 1, name: "How do I rotate a token?" }).waitFor();
      await page
        .getByRole("region", { name: "Related" })
        .getByRole("link", { name: "Machine credentials and tokens" })
        .click();
      await page.waitForURL(`${web.origin}/help/machine-credentials`);
      await page
        .getByRole("heading", { level: 1, name: "Machine credentials and tokens" })
        .waitFor();
      await page.goBack();
      await page.waitForURL(`${web.origin}/help/rotate-token`);
      await page.getByRole("heading", { level: 1, name: "How do I rotate a token?" }).waitFor();
      await page.goForward();
      await page.waitForURL(`${web.origin}/help/machine-credentials`);
      await page
        .getByRole("heading", { level: 1, name: "Machine credentials and tokens" })
        .waitFor();
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("the error A to Z has one entry per code of explain.ts", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}/help/errors`);
      await page.getByRole("heading", { level: 1, name: "Error messages, A to Z" }).waitFor();
      const anchors = await page
        .locator("main dt[id^='error-']")
        .evaluateAll((terms: unknown[]) => terms.map((term) => (term as { id: string }).id));
      const expected = [
        "error-transport",
        "error-unfinished",
        ...Object.keys(ERROR_CODES).map((code) => `error-${code}`),
      ];
      expect([...anchors].sort()).toEqual([...expected].sort());
      // A to Z, and no code is printed: the page speaks in words.
      const titles = await page.locator("main dt[id^='error-']").allTextContents();
      expect(titles).toEqual([...titles].sort((x, y) => x.localeCompare(y, "en")));
      const shown = (await page.locator("main").textContent()) ?? "";
      for (const code of Object.keys(ERROR_CODES)) {
        if (code.includes("_")) expect(shown, code).not.toContain(code);
      }
      expect(WEB_ROUTES.some((route) => route.id === "help-article")).toBe(true);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
