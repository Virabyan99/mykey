// Run 9.0 Task A (D-70, FR-1.96): axe-core over every kind of screen of the
// new workspace, signed in and out. axe's source is put into the page through
// the DevTools protocol (`page.evaluate`), which the page's policy does not
// govern: the page itself still loads nothing but its own script and style,
// and the test checks that no violation of the policy was reported.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { webPath } from "@mykey/contracts";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebWithStores, type StoresWeb } from "../harness/web.ts";

let web: StoresWeb;
let secretName = "";
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

beforeAll(async () => {
  web = await startWebWithStores();
  secretName = `A11Y_${randomBytes(4).toString("hex").toUpperCase()}`;
  const value = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
  const created = await web.f.create("env1a", secretName, value);
  expect(created.status, created.text).toBe(201);
}, 600_000);

afterAll(async () => {
  await web.close();
});

interface Violation {
  id: string;
  impact: string;
  nodes: string[];
}

/** The serious and critical violations axe finds on the page as it is now. */
async function serious(page: Page): Promise<Violation[]> {
  await page.evaluate(AXE);
  return page.evaluate<Violation[]>(`
    globalThis.axe.run(document, { resultTypes: ["violations"] }).then((result) =>
      result.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) })),
    )
  `);
}

describe("the workspace's accessibility", () => {
  it("axe finds no serious or critical violation on the sign-in screen", async () => {
    const session = await web.anonymous();
    try {
      await session.page.goto(`${web.origin}/sign-in`);
      await session.page.getByRole("heading", { level: 1, name: "Sign in" }).waitFor();
      expect(await serious(session.page)).toEqual([]);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("axe finds no serious or critical violation on: Home, a project, secrets, a secret, credentials, activity, audit, operations, account, help, an article, connect", async () => {
    const { a } = web.tenants;
    const org = a.organizationId;
    const at = { org, project: a.project1, env: a.env1a };
    const screens: [string, string][] = [
      ["Home", webPath("overview", { org })],
      ["a project", webPath("project", { org, project: a.project1 })],
      ["secrets", webPath("secrets", at)],
      ["a secret", webPath("secret", { ...at, name: secretName })],
      ["credentials", webPath("credentials", at)],
      ["activity", webPath("activity", { org })],
      ["audit", webPath("audit", { org })],
      ["operations", webPath("operations", at)],
      ["account", webPath("account")],
      ["help", webPath("help")],
      ["an article", webPath("help-article", { article: "secrets-basics" })],
      ["connect", webPath("connect", at)],
    ];
    const session = await web.signedIn("ownerA");
    try {
      const found: Record<string, Violation[]> = {};
      for (const [screen, path] of screens) {
        await session.page.goto(`${web.origin}${path}`);
        await session.page.getByRole("heading", { level: 1 }).waitFor();
        // What the screen reads first is on the page before it is checked.
        await session.page.waitForLoadState("networkidle");
        const violations = await serious(session.page);
        if (violations.length > 0) found[screen] = violations;
      }
      expect(found).toEqual({});
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
