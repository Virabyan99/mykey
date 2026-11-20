// Run 7.6 (FR-1.31 to FR-1.37, P-138): import, export and the first-run guide
// in the page, over real OpenBao. The file's bytes stay in the import screen's
// memory and go when the screen does. A preview shows the server's
// classification and never a value; a result is never called done when an
// entry was not written. An export is offered for saving only after the whole
// answer was read and its digest checked. Values are run-time canaries.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeAt, stepAt } from "@mykey/auth";
import { matchWebRoute, webPath } from "@mykey/contracts";
import type { Locator, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signInComplete } from "../harness/api.ts";
import { startWebWithStores, type StoresWeb } from "../harness/web.ts";

let web: StoresWeb;
const REPO = resolve(import.meta.dirname, "../..");

beforeAll(async () => {
  web = await startWebWithStores();
}, 600_000);

afterAll(async () => {
  await web.close();
});

beforeEach(async () => {
  // Five imports and exports a minute per person (P-115): each test starts with an empty counter.
  await web.api.superuser.query("DELETE FROM app.rate_limit");
});

afterEach(() => {
  web.f.setImportBudget(null);
});

const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
const valueOf = (label: string): string => `${mark}-${label}-${randomBytes(4).toString("hex")}`;
const newName = (prefix = "IMP"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const fileOf = (...entries: [string, string][]): string =>
  entries.map(([name, value]) => `${name}=${value}\n`).join("");

const at = () => ({
  org: web.tenants.a.organizationId,
  project: web.tenants.a.project1,
  env: web.tenants.a.env1a,
});
const importPath = (): string => webPath("import", at());

async function seed(name: string, value: string): Promise<{ version: number; stateTag: string }> {
  const answer = await web.f.create("env1a", name, value);
  expect(answer.status, answer.text).toBe(201);
  return answer.body.result as { version: number; stateTag: string };
}

async function stored(name: string): Promise<{ version: number; digest: string | null } | null> {
  const found = await web.f.backend("env1a", name);
  if (found === null) return null;
  const current = found.versions.find((entry) => entry.version === found.currentVersion);
  return { version: found.currentVersion, digest: current?.digest ?? null };
}

/** Everything of the page a value could be read from: its markup and what its fields hold. */
async function everythingShown(page: Page): Promise<string> {
  const fields = await page.evaluate(`
    Array.from(document.querySelectorAll("input:not([type=file]), textarea, output")).map((field) => field.value).join("\\n")
  `);
  return `${await page.content()}\n${String(fields)}`;
}

async function openImport(page: Page): Promise<void> {
  await page.goto(`${web.origin}${importPath()}`);
  await page.getByRole("heading", { level: 1, name: "Import and export" }).waitFor();
}

async function preview(page: Page, text: string): Promise<void> {
  await page.getByLabel("Or paste the text of the file").fill(text);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("heading", { level: 3, name: "Preview" }).waitFor();
}

const previewRows = (page: Page): Locator =>
  page.getByRole("table", { name: "Preview of the import" }).locator("tbody tr");
const resultRows = (page: Page): Locator =>
  page.getByRole("table", { name: "Result of the import" }).locator("tbody tr");
const resultOf = async (page: Page): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(
      (await resultRows(page).all()).map(async (row) => {
        const name = (await row.getByRole("rowheader").textContent()) ?? "";
        const outcome = (await row.getByRole("cell").last().textContent()) ?? "";
        return [name, outcome] as const;
      }),
    ),
  );

async function environmentName(): Promise<string> {
  const found = await web.api.superuser.query<{ name: string }>(
    "SELECT name FROM app.environment WHERE id = $1",
    [web.tenants.a.env1a],
  );
  return found.rows[0]?.name ?? "";
}

async function confirmExport(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Export this environment" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: /^Export / }).waitFor();
  expect(await dialog.textContent()).toContain("outside MyKey");
  const confirm = dialog.getByRole("button", { name: "Export", exact: true });
  expect(await confirm.isDisabled()).toBe(true);
  await dialog.getByLabel("Type the name to confirm").fill(await environmentName());
  await confirm.click();
}

describe("import", () => {
  it("a 12-line file with one invalid name cannot be applied and the page names the line and the rule; without that line it previews as 8 new, 2 changed and 1 unchanged, and apply writes exactly the ten", async () => {
    const fresh = Array.from({ length: 8 }, () => [newName(), valueOf("new")] as [string, string]);
    const changed = [newName(), newName()];
    const same = newName();
    const sameValue = valueOf("same");
    for (const name of changed) await seed(name, valueOf("old"));
    await seed(same, sameValue);
    const good: [string, string][] = [
      ...fresh,
      [changed[0] ?? "", valueOf("changed")],
      [changed[1] ?? "", valueOf("changed")],
      [same, sameValue],
    ];
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openImport(page);
      await preview(page, `${fileOf(...good)}not_a_name=${valueOf("invalid")}\n`);
      await page.getByText(/This file cannot be applied/).waitFor();
      const problems = page.getByRole("list", { name: "Problems in the file" }).locator("> li");
      expect(await problems.count()).toBe(1);
      expect(await problems.first().textContent()).toMatch(/^Line 12: .*invalid_name/);
      expect(await page.getByRole("table", { name: "Preview of the import" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Apply import" }).count()).toBe(0);
      // The server names no invalid entry, and the page shows no value.
      const shown = await everythingShown(page);
      expect(shown).not.toContain("not_a_name");
      expect(shown).not.toContain(mark);
      expect(await stored(fresh[0]?.[0] ?? "")).toBeNull();

      await page.getByRole("button", { name: "Start over" }).click();
      await preview(page, fileOf(...good));
      await page.getByText("8 new, 2 changed, 1 unchanged").waitFor();
      expect(await previewRows(page).count()).toBe(11);
      expect(await page.getByRole("list", { name: "Problems in the file" }).count()).toBe(0);
      await page.getByRole("button", { name: "Apply import" }).click();
      await page.getByText("State of the import: succeeded").waitFor({ timeout: 60_000 });

      const result = await resultOf(page);
      expect(Object.keys(result)).toHaveLength(11);
      for (const [name, value] of fresh) {
        expect(result[name], name).toBe("created");
        expect(await stored(name), name).toEqual({ version: 1, digest: digest(value) });
      }
      for (const name of changed) {
        expect(result[name], name).toBe("updated");
        const value = good.find(([entry]) => entry === name)?.[1] ?? "";
        expect(await stored(name), name).toEqual({ version: 2, digest: digest(value) });
      }
      expect(result[same]).toBe("unchanged");
      expect(await stored(same)).toEqual({ version: 1, digest: digest(sameValue) });
      expect(await everythingShown(page)).not.toContain(mark);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("an import that ends partial lists the written and the unwritten keys and shows the state partial", async () => {
    const [moved, fresh] = [newName(), newName()];
    const current = await seed(moved, valueOf("start"));
    const other = valueOf("other-writer");
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openImport(page);
      await preview(page, fileOf([moved, valueOf("import")], [fresh, valueOf("fresh")]));
      await page.getByText("1 new, 1 changed").waitFor();
      // Another writer, between the preview and the apply.
      expect((await web.f.update("env1a", moved, other, current)).status).toBe(200);
      await page.getByRole("button", { name: "Apply import" }).click();
      await page.getByText("State of the import: partial").waitFor({ timeout: 60_000 });
      expect(await resultOf(page)).toEqual({
        [moved]: "conflict: not written",
        [fresh]: "created",
      });
      await page.getByText("1 of 2 entries was written. 1 was not.").waitFor();
      expect(await page.getByText("succeeded").count()).toBe(0);
      expect((await stored(moved))?.digest).toBe(digest(other));
      expect((await stored(fresh))?.version).toBe(1);
    } finally {
      await session.close();
    }
  }, 240_000);

  // Run 8.0 Task C (Session 7's Minor 5): the sentence above the rows.
  it('an import with an uncertain entry: the summary sentence counts it as uncertain, not as "not written"', async () => {
    const [written, unknown, refused] = [newName(), newName(), newName()];
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const operationId = randomUUID();
    try {
      await openImport(page);
      await preview(
        page,
        fileOf([written, valueOf("1")], [unknown, valueOf("2")], [refused, valueOf("3")]),
      );
      await page.getByText("3 new").waitFor();
      // The contract's answer for an import that ended with one entry not known.
      await page.route(/\/import\/[^/]+\/apply$/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json; charset=utf-8",
          headers: { "x-request-id": randomUUID() },
          body: JSON.stringify({
            operationId,
            state: "uncertain",
            statusUrl: `/v1/organizations/${web.tenants.a.organizationId}/operations/${operationId}`,
            replayExpiresAt: null,
            result: {
              entries: [
                { ordinal: 1, name: written, outcome: "created" },
                { ordinal: 2, name: unknown, outcome: "uncertain" },
                { ordinal: 3, name: refused, outcome: "rejected" },
              ],
            },
          }),
        });
      });
      await page.getByRole("button", { name: "Apply import" }).click();
      await page.getByText("State of the import: uncertain").waitFor();
      const summary = page.getByText(/^1 of 3 entries was written\./);
      await summary.waitFor();
      expect(await summary.textContent()).toBe(
        "1 of 3 entries was written. For 1 it is not known whether it was written. 1 was not.",
      );
      expect(await resultOf(page)).toEqual({
        [written]: "created",
        [unknown]: "uncertain: whether it was written is not known",
        [refused]: "rejected: not written",
      });
    } finally {
      await session.close();
    }
  }, 240_000);

  it("an import waiting for input offers resume, and resume with the same file finishes it; with another file the server's refusal is shown", async () => {
    const entries: [string, string][] = [
      [newName(), valueOf("1")],
      [newName(), valueOf("2")],
      [newName(), valueOf("3")],
    ];
    const text = fileOf(...entries);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openImport(page);
      await preview(page, text);
      web.f.setImportBudget(0);
      await page.getByRole("button", { name: "Apply import" }).click();
      await page.getByText("State of the import: awaiting input").waitFor({ timeout: 60_000 });
      web.f.setImportBudget(null);
      // The page kept nothing: it asks for the file.
      await page.getByText(/The page did not keep the file/).waitFor();
      expect(await everythingShown(page)).not.toContain(mark);
      expect(await stored(entries[0]?.[0] ?? "")).not.toBeNull();
      expect(await stored(entries[2]?.[0] ?? "")).toBeNull();

      const waiting = page.getByRole("region", { name: "Imports waiting for their file" });
      await waiting.getByLabel("Or paste the text of the file").fill(`${text}EXTRA_LINE=1\n`);
      await waiting.getByRole("button", { name: "Resume" }).click();
      await waiting.getByText(/is not the file this import was started with/).waitFor();
      await waiting.getByRole("alert").first().waitFor();
      expect(await stored(entries[2]?.[0] ?? "")).toBeNull();

      await page.reload();
      const again = page.getByRole("region", { name: "Imports waiting for their file" });
      await again.getByLabel("Or paste the text of the file").fill(text);
      await again.getByRole("button", { name: "Resume" }).click();
      await page.getByText("State of the import: succeeded").waitFor({ timeout: 60_000 });
      const result = await resultOf(page);
      for (const [name, value] of entries) {
        expect(result[name], name).toBe("created");
        expect(await stored(name), name).toEqual({ version: 1, digest: digest(value) });
      }
      expect(
        await page.getByRole("region", { name: "Imports waiting for their file" }).count(),
      ).toBe(0);
    } finally {
      await session.close();
    }
  }, 300_000);

  it("after leaving the import screen its bytes are in no storage and not in the DOM", async () => {
    const text = fileOf([newName(), valueOf("leave")], [newName(), valueOf("leave")]);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openImport(page);
      // Chosen as a file this time.
      await page
        .getByLabel("Dotenv file")
        .setInputFiles({ name: "leave.env", mimeType: "text/plain", buffer: Buffer.from(text) });
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await page.getByText("2 new").waitFor();
      expect(await everythingShown(page)).not.toContain(mark);

      await page
        .getByRole("navigation", { name: "Sections" })
        .getByRole("link", { name: "Secrets" })
        .click();
      await page.getByRole("heading", { level: 1, name: "Secrets" }).waitFor();
      expect(await everythingShown(page)).not.toContain(mark);
      const kept = await page.evaluate(`JSON.stringify({
        local: Object.keys(window["local" + "Storage"]).length,
        session: Object.keys(window["session" + "Storage"]).length,
        state: history.state,
      })`);
      expect(JSON.parse(String(kept))).toEqual({ local: 0, session: 0, state: null });

      await page.goBack();
      await page.getByRole("heading", { level: 1, name: "Import and export" }).waitFor();
      expect(await page.getByRole("table", { name: "Preview of the import" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Apply import" }).count()).toBe(0);
      expect(await everythingShown(page)).not.toContain(mark);
    } finally {
      await session.close();
    }
  });

  it("a file over 1 MiB is refused in the form with the limit named, and nothing is sent", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openImport(page);
      await page.getByLabel("Dotenv file").setInputFiles({
        name: "big.env",
        mimeType: "text/plain",
        buffer: Buffer.alloc(1_048_577, "A"),
      });
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: /at most 1,048,576 bytes/ })
        .waitFor();
      expect(session.requested.some((url) => url.endsWith("/import/preview"))).toBe(false);
    } finally {
      await session.close();
    }
  });
});

describe("export", () => {
  it("export asks for a fresh code and a confirmation; the downloaded file's digest equals the digest of the same set read through the API", async () => {
    await seed(newName("EXP"), valueOf("export"));
    const credentials = web.tenants.credentials("adminA");
    const mine = await signInComplete(web.api, credentials);
    // The page's session verified its code more than ten minutes ago.
    await web.api.superuser.query(
      "UPDATE auth.session SET totp_verified_at = now() - interval '20 minutes' WHERE id = $1",
      [mine.sessionId],
    );
    const session = await web.withCookie(mine.cookie);
    const { page } = session;
    const answers: number[] = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.endsWith("/export")) answers.push(response.status());
    });
    try {
      await openImport(page);
      await confirmExport(page);
      const code = page.getByRole("dialog", { name: "Confirm with your authenticator" });
      await code.waitFor();
      await code
        .getByLabel("Code from your authenticator app")
        .fill(codeAt(credentials.seed, stepAt(new Date()) + 1));
      await code.getByRole("button", { name: "Confirm" }).click();
      await code.waitFor({ state: "hidden" });
      // The page does not send the export by itself: the owner asks again.
      await page.getByText("Confirmed. Export again.").waitFor();
      expect(answers).toEqual([403]);

      await confirmExport(page);
      await page.getByText(/The export is complete/).waitFor({ timeout: 60_000 });
      expect(answers).toEqual([403, 200]);
      expect(await everythingShown(page)).not.toContain(mark);
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Save the file" }).click();
      const saved = await download;
      expect(saved.suggestedFilename()).toBe(`mykey-${await environmentName()}.env`);
      const bytes = readFileSync(await saved.path());
      expect(bytes.toString("utf8")).toContain(mark);
      // Once saved, the page has let go of it.
      await page.getByText(/The file is saved by your browser/).waitFor();
      expect(await page.getByRole("button", { name: "Save the file" }).count()).toBe(0);

      // The same set, read through the API.
      await web.api.superuser.query("UPDATE auth.session SET totp_verified_at = now()");
      const direct = await web.api.request("POST", `${web.f.env("env1a").path}/export`, {
        cookie: await web.tenants.cookie("ownerA"),
        body: { confirmed: true },
      });
      expect(direct.status).toBe(200);
      expect(digest(bytes)).toBe(digest(Buffer.from(await direct.arrayBuffer())));
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("a cut export answer saves nothing and says incomplete", async () => {
    await seed(newName("EXP"), valueOf("cut"));
    const session = await web.signedIn("ownerA");
    const { page } = session;
    await web.api.superuser.query("UPDATE auth.session SET totp_verified_at = now()");
    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });
    // The answer keeps its headers and loses the second half of its body.
    const real: number[] = [];
    await page.route("**/export", async (route) => {
      // The real answer, read by the harness (the test host's name resolves only inside Chromium).
      const answer = await web.api.request("POST", `${web.f.env("env1a").path}/export`, {
        cookie: await web.tenants.cookie("ownerA"),
        body: { confirmed: true },
      });
      real.push(answer.status);
      const body = Buffer.from(await answer.arrayBuffer());
      await route.fulfill({
        status: answer.status,
        headers: Object.fromEntries(answer.headers),
        body: body.subarray(0, Math.floor(body.length / 2)),
      });
    });
    try {
      await openImport(page);
      await confirmExport(page);
      const alert = page.getByRole("alert").filter({ hasText: /incomplete/ });
      await alert.waitFor({ timeout: 60_000 });
      expect(await alert.textContent()).toContain("Nothing was saved");
      expect(real).toEqual([200]);
      expect(await page.getByRole("button", { name: "Save the file" }).count()).toBe(0);
      expect(await everythingShown(page)).not.toContain(mark);
      expect(downloads).toBe(0);
    } finally {
      await session.close();
    }
  }, 240_000);
});

describe("the first-run guide", () => {
  it("the guide's six steps link only to paths of WEB_ROUTES, /v1/reference and files that exist", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}/help`);
      await page.getByRole("heading", { level: 1, name: "Help" }).waitFor();
      const steps = page.getByRole("list", { name: "First run" }).locator("> li");
      expect(await steps.count()).toBe(6);

      const links = await page.locator("main a[href]").evaluateAll(
        // No DOM types in the tests' TypeScript.
        (anchors) => anchors.map((anchor) => (anchor as unknown as { href: string }).href),
      );
      expect(links.length).toBeGreaterThan(2);
      for (const link of links) {
        const url = new URL(link);
        expect(url.origin, link).toBe(web.origin);
        const known = url.pathname === "/v1/reference" || matchWebRoute(url.pathname) !== null;
        expect(known, link).toBe(true);
      }
      expect(links.some((link) => new URL(link).pathname === "/v1/reference")).toBe(true);

      const files = (await page.locator("main code").allTextContents()).filter((text) =>
        text.startsWith("docs/"),
      );
      expect(files).toEqual(
        expect.arrayContaining([
          "docs/runbooks/consumer-local.md",
          "docs/runbooks/machine-credentials.md",
          "docs/runbooks/known-limits.md",
        ]),
      );
      for (const file of files) expect(existsSync(resolve(REPO, file)), file).toBe(true);
      // Nothing of a real deployment: no address, no token.
      expect(await page.locator("main").textContent()).not.toMatch(/https?:\/\//);
    } finally {
      await session.close();
    }
  });
});
