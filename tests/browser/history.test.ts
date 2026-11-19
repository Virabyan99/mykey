// Run 7.5 (FR-1.26 to FR-1.29): a secret's history and the three changes that
// are not an edit, over real OpenBao. The history shows who wrote each
// version as the server gives it; a version nobody of the product wrote says
// "unknown". Delete, undelete and restore sit behind the typed confirmation,
// name the version they expect, and a stale one offers reload or cancel.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { webPath } from "@mykey/contracts";
import { secretPath as backendPath } from "@mykey/openbao";
import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FixtureUser } from "../harness/tenants.ts";
import { startWebWithStores, type StoresWeb } from "../harness/web.ts";

let web: StoresWeb;

beforeAll(async () => {
  web = await startWebWithStores();
}, 600_000);

afterAll(async () => {
  await web.close();
});

const canary = (): string =>
  ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
const newName = (): string => `HIS_${randomBytes(5).toString("hex").toUpperCase()}`;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

const at = () => ({
  org: web.tenants.a.organizationId,
  project: web.tenants.a.project1,
  env: web.tenants.a.env1a,
});
const listPath = (): string => webPath("secrets", at());
const secretPath = (name: string): string => webPath("secret", { ...at(), name });

interface Written {
  version: number;
  stateTag: string;
}

async function create(name: string, value: string, user: FixtureUser = "ownerA"): Promise<Written> {
  const answer = await web.f.create("env1a", name, value, { user });
  expect(answer.status, answer.text).toBe(201);
  return answer.body.result as Written;
}

async function update(
  name: string,
  value: string,
  expected: Written,
  user: FixtureUser = "ownerA",
): Promise<Written> {
  const answer = await web.f.update("env1a", name, value, expected, { user });
  expect(answer.status, answer.text).toBe(200);
  return answer.body.result as Written;
}

async function backend(name: string) {
  const stored = await web.f.backend("env1a", name);
  if (stored === null) throw new Error(`no such secret in OpenBao: ${name}`);
  return stored;
}

const versions = (page: Page): Locator => page.getByRole("table", { name: "Versions" });
const versionRow = (page: Page, version: number): Locator =>
  versions(page)
    .locator("tbody tr")
    .filter({ has: page.getByRole("rowheader", { name: String(version), exact: true }) });
const shown = (page: Page): Locator => page.getByLabel("Value", { exact: true });
const status = (page: Page, text: string | RegExp): Locator =>
  page.getByRole("status").filter({ hasText: text });

async function openSecret(page: Page, name: string): Promise<void> {
  await page.goto(`${web.origin}${secretPath(name)}`);
  await page.getByRole("heading", { level: 1, name }).waitFor();
  await versions(page).waitFor();
}

async function confirmTyped(dialog: Locator, name: string, button: string): Promise<void> {
  const confirm = dialog.getByRole("button", { name: button, exact: true });
  const typed = dialog.getByLabel("Type the name to confirm");
  expect(await confirm.isDisabled()).toBe(true);
  await typed.fill(name);
  expect(await confirm.isDisabled()).toBe(false);
  await confirm.click();
}

describe("a secret's history and its changes", () => {
  it("three writes show three versions, newest first, each with its author", async () => {
    const name = newName();
    const first = await create(name, canary(), "ownerA");
    const second = await update(name, canary(), first, "adminA");
    await update(name, canary(), second, "ownerA");
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openSecret(page, name);
      await versionRow(page, 3).waitFor();
      expect(await versions(page).getByRole("rowheader").allTextContents()).toEqual([
        "3",
        "2",
        "1",
      ]);
      const expected: [number, string, FixtureUser][] = [
        [3, "updated", "ownerA"],
        [2, "updated", "adminA"],
        [1, "created", "ownerA"],
      ];
      for (const [version, action, user] of expected) {
        const text = (await versionRow(page, version).textContent()) ?? "";
        expect(text, String(version)).toContain(action);
        expect(text, String(version)).toContain(web.tenants.userId(user));
      }
      expect(await versionRow(page, 3).textContent()).toContain("current");
      expect(await versionRow(page, 2).textContent()).not.toContain("current");
      // The history is read without a value: none was asked for.
      expect(session.requested.some((url) => url.endsWith("/reveal"))).toBe(false);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('a history row whose actor is unknown says "unknown"', async () => {
    const name = newName();
    const first = await create(name, canary());
    // A version written past the product, as Session 4's history test does.
    const place = web.f.env("env1a");
    const outside = await web.f
      .operatorBao()
      .kvWrite(
        backendPath(place.projectId, place.environmentId, name),
        { value: `synthetic-${randomUUID()}`, operation_id: randomUUID(), format: 1 },
        first.version,
        { operationId: randomUUID(), dispatchId: randomUUID() },
      );
    expect(outside.ok).toBe(true);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openSecret(page, name);
      const row = versionRow(page, 2);
      await row.waitFor();
      const cells = await row.getByRole("cell").allTextContents();
      // Written, action, by: the action and the actor are both unknown, and neither is blank.
      expect(cells[1]).toBe("unknown");
      expect(cells[2]).toBe("unknown");
      expect(await row.textContent()).not.toContain(web.tenants.userId("ownerA"));
      expect(await versionRow(page, 1).textContent()).toContain(web.tenants.userId("ownerA"));
    } finally {
      await session.close();
    }
  });

  it("delete asks for confirmation; the list then shows the name as deleted and offers undelete; undelete brings it back at the same version", async () => {
    const name = newName();
    const value = canary();
    await create(name, value);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openSecret(page, name);
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("heading", { name: `Delete ${name}` }).waitFor();
      // Nothing happened yet.
      expect((await backend(name)).versions[0]?.deleted).toBe(false);
      await confirmTyped(dialog, name, "Delete");
      await status(page, `${name} is deleted`).waitFor();
      expect((await backend(name)).versions[0]?.deleted).toBe(true);
      expect(await page.getByRole("button", { name: "Reveal", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Edit value" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Delete", exact: true }).count()).toBe(0);
      await versionRow(page, 1).getByText("deleted", { exact: false }).first().waitFor();

      await page
        .getByRole("navigation", { name: "Sections" })
        .getByRole("link", { name: "Secrets" })
        .click();
      await page.waitForURL(`${web.origin}${listPath()}`);
      const listed = page
        .getByRole("table", { name: "Secrets" })
        .locator("tbody tr")
        .filter({ has: page.getByRole("rowheader", { name, exact: true }) });
      await listed.waitFor();
      expect(await listed.getByRole("cell").first().textContent()).toContain("deleted");
      await listed.getByRole("link", { name }).click();
      await page.waitForURL(`${web.origin}${secretPath(name)}`);

      await page.getByRole("button", { name: "Undelete", exact: true }).click();
      const again = page.getByRole("dialog");
      await again.getByRole("heading", { name: `Undelete ${name}` }).waitFor();
      await confirmTyped(again, name, "Undelete");
      await status(page, `${name} is live again at version 1`).waitFor();
      const stored = await backend(name);
      expect(stored.currentVersion).toBe(1);
      expect(stored.versions).toHaveLength(1);
      expect(stored.versions[0]).toMatchObject({ deleted: false, digest: digest(value) });
      await page.getByRole("button", { name: "Reveal", exact: true }).waitFor();
      await versionRow(page, 1).getByText("undeleted", { exact: false }).first().waitFor();
      expect(await everythingShown(page)).not.toContain(value);
    } finally {
      await session.close();
    }
  });

  it("restore version 1 creates version N+1 with version 1's value (compared by revealing both), and the history says it was restored", async () => {
    const name = newName();
    const old = canary();
    const first = await create(name, old);
    await update(name, canary(), first);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openSecret(page, name);
      await versionRow(page, 1).getByRole("button", { name: "Restore version 1" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("heading", { name: `Restore version 1 of ${name}` }).waitFor();
      // The confirmation names the version it copies and the version it comes after.
      const text = (await dialog.textContent()) ?? "";
      expect(text).toMatch(/version 1\b/);
      expect(text).toMatch(/version 2\b/);
      expect(text).not.toContain(old);
      await confirmTyped(dialog, name, "Restore");
      await status(page, "Version 1 was restored as version 3").waitFor();

      const row = versionRow(page, 3);
      await row.waitFor();
      expect(await row.textContent()).toContain("restored from an earlier version");
      expect(await row.textContent()).toContain("current");
      const stored = await backend(name);
      expect(stored.currentVersion).toBe(3);
      expect(stored.versions.find((entry) => entry.version === 3)?.digest).toBe(digest(old));

      // Both values, one after the other in the one place a value is shown.
      await page.getByRole("button", { name: "Reveal", exact: true }).click();
      await shown(page).waitFor();
      expect(await shown(page).textContent()).toBe(old);
      await page.getByText(/Version 3\. Hidden again in/).waitFor();
      await versionRow(page, 1).getByRole("button", { name: "Reveal version 1" }).click();
      await page.getByText(/Version 1\. Hidden again in/).waitFor();
      expect(await shown(page).textContent()).toBe(old);
      expect(await shown(page).count()).toBe(1);
    } finally {
      await session.close();
    }
  });

  it("a stale restore (the secret changed in another tab) shows the conflict with reload and cancel", async () => {
    const name = newName();
    const first = await create(name, canary());
    const second = await update(name, canary(), first);
    const latest = canary();
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openSecret(page, name);
      await versionRow(page, 2).waitFor();
      // Meanwhile, elsewhere.
      await update(name, latest, second, "adminA");
      await versionRow(page, 1).getByRole("button", { name: "Restore version 1" }).click();
      await confirmTyped(page.getByRole("dialog"), name, "Restore");

      const conflict = page.getByRole("alert").filter({
        has: page.getByRole("heading", { name: "The secret changed since you opened it" }),
      });
      await conflict.waitFor();
      expect(await page.getByRole("dialog").count()).toBe(0);
      expect(await conflict.getByRole("button").allTextContents()).toEqual(["Reload", "Cancel"]);
      const stored = await backend(name);
      expect(stored.currentVersion).toBe(3);
      expect(stored.versions.find((entry) => entry.version === 3)?.digest).toBe(digest(latest));

      await conflict.getByRole("button", { name: "Reload" }).click();
      await versionRow(page, 3).waitFor();
      expect(await page.getByRole("alert").count()).toBe(0);
      expect(await versionRow(page, 3).textContent()).toContain(web.tenants.userId("adminA"));
      expect((await backend(name)).currentVersion).toBe(3);
    } finally {
      await session.close();
    }
  });

  it("a key under review shows its state and offers no write", async () => {
    const name = newName();
    const first = await create(name, canary());
    await update(name, canary(), first);
    await web.api.superuser.query(
      "UPDATE app.secret_index SET state = 'needs_review' WHERE environment_id = $1 AND name = $2",
      [web.tenants.a.env1a, name],
    );
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${secretPath(name)}`);
      await page.getByRole("heading", { level: 1, name }).waitFor();
      await page.getByText("needs review").first().waitFor();
      await page
        .getByText(/An earlier change to this secret has an outcome that is not known/)
        .waitFor();
      // Whatever the page has finished reading, it offers nothing that changes or reads a value.
      await page.getByRole("heading", { level: 2, name: "History" }).waitFor();
      await page.waitForLoadState("networkidle");
      expect(await page.locator("main").getByRole("button").allTextContents()).toEqual([]);
    } finally {
      await web.api.superuser.query(
        "UPDATE app.secret_index SET state = 'live' WHERE environment_id = $1 AND name = $2",
        [web.tenants.a.env1a, name],
      );
      await session.close();
    }
  });
});

/** Everything of the page a value could be read from: its markup and what its fields hold. */
async function everythingShown(page: Page): Promise<string> {
  const fields = await page.evaluate(`
    Array.from(document.querySelectorAll("input, textarea, output")).map((field) => field.value).join("\\n")
  `);
  return `${await page.content()}\n${String(fields)}`;
}
