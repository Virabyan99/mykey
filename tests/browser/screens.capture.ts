// Run 9.0 Task H step 3: screenshots of every screen for the release review,
// in light and dark, at 1440 and 390 wide. Not a test: it is run by hand
// (`pnpm run screens:capture`), on the test stack with synthetic data only,
// and writes docs/evidence/session-9/screens/<screen>-<scheme>-<width>.png.
// No value is revealed on any screen it captures: the secret page is shown
// with its value hidden, and no token is issued.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { webPath } from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebWithStores, type StoresWeb } from "../harness/web.ts";

const OUT = resolve(import.meta.dirname, "../../docs/evidence/session-9/screens");
const WIDTHS = [1440, 390] as const;
const SCHEMES = ["light", "dark"] as const;

let web: StoresWeb;
const name = "DATABASE_URL";

beforeAll(async () => {
  web = await startWebWithStores();
  // Synthetic: a few names with synthetic values, so the lists are not empty.
  for (const each of [name, "API_KEY", "SMTP_PASSWORD"]) {
    const created = await web.f.create(
      "env1a",
      each,
      `synthetic-${randomBytes(8).toString("hex")}`,
    );
    expect(created.status, created.text).toBe(201);
  }
}, 600_000);

afterAll(async () => {
  await web.close();
});

describe("screens for the review", () => {
  it("captures every screen in light and dark at 1440 and 390", async () => {
    mkdirSync(OUT, { recursive: true });
    const { a } = web.tenants;
    const org = a.organizationId;
    const at = { org, project: a.project1, env: a.env1a };
    const screens: [string, string][] = [
      ["home", webPath("overview", { org })],
      ["project", webPath("project", { org, project: a.project1 })],
      ["secrets", webPath("secrets", at)],
      ["secret", webPath("secret", { ...at, name })],
      ["import-export", webPath("import", at)],
      ["credentials", webPath("credentials", at)],
      ["operations", webPath("operations", at)],
      ["connect", webPath("connect", at)],
      ["activity", webPath("activity", { org })],
      ["audit", webPath("audit", { org })],
      ["account", webPath("account")],
      ["help-centre", webPath("help")],
      ["help-article", webPath("help-article", { article: "project-id" })],
      ["help-errors", webPath("help-article", { article: "errors" })],
    ];
    const session = await web.signedIn("ownerA");
    const { page } = session;
    let shots = 0;
    try {
      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
          for (const [screen, path] of screens) {
            await page.goto(`${web.origin}${path}`);
            await page.getByRole("heading", { level: 1 }).waitFor();
            await page.waitForLoadState("networkidle");
            await page.screenshot({
              path: join(OUT, `${screen}-${scheme}-${String(width)}.png`),
              fullPage: true,
            });
            shots += 1;
          }
        }
      }
      // The palette and the contextual help, once each, light and wide.
      await page.emulateMedia({ colorScheme: "light" });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${web.origin}${webPath("secrets", at)}`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.keyboard.press("Control+k");
      await page.keyboard.type("cred");
      await page.screenshot({ path: join(OUT, "palette-light-1440.png") });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Help for this page" }).click();
      await page.getByRole("dialog").waitFor();
      await page.screenshot({ path: join(OUT, "context-help-light-1440.png") });
      expect(shots).toBe(screens.length * WIDTHS.length * SCHEMES.length);
    } finally {
      await session.close();
    }
  }, 600_000);
});
