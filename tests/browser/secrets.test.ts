// Run 7.4 (FR-1.18 to FR-1.23, P-138, D-60, Review focus 1): secrets in the
// page, over real OpenBao. A value is on the screen only after an explicit
// Reveal and only until the holder forgets it: after 30 seconds, when the tab
// is hidden, on a change of address, at sign-out. An edit names the version
// it was opened on, and a conflict offers reload or cancel and nothing else.
// Every value here is a canary assembled at run time.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LIMITS, webPath } from "@mykey/contracts";
import type { Locator, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { signInComplete } from "../harness/api.ts";
import { archive, newProject } from "../harness/lifecycle-fixture.ts";
import { startWebWithStores, type StoresWeb } from "../harness/web.ts";

let web: StoresWeb;

beforeAll(async () => {
  web = await startWebWithStores();
}, 600_000);

afterAll(async () => {
  await web.close();
});

afterEach(async () => {
  web.api.setCapacity("ok");
  await captureMode("idle");
});

const canary = (): string =>
  ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
const newName = (): string => `WEB_${randomBytes(5).toString("hex").toUpperCase()}`;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

const at = () => ({
  org: web.tenants.a.organizationId,
  project: web.tenants.a.project1,
  env: web.tenants.a.env1a,
});
const listPath = (): string => webPath("secrets", at());
const secretPath = (name: string): string => webPath("secret", { ...at(), name });

async function captureMode(mode: "idle" | "draining"): Promise<void> {
  await web.api.database
    .pool("maintenance")
    .query(
      "UPDATE app.service_control SET capture_mode = $1, owner = $2, pair_id = NULL, updated_at = now()",
      [mode, mode === "idle" ? null : "browser-test"],
    );
}

/** A secret written through the API, and the canary it holds. */
async function seeded(): Promise<{ name: string; value: string }> {
  const name = newName();
  const value = canary();
  const created = await web.f.create("env1a", name, value);
  expect(created.status, created.text).toBe(201);
  return { name, value };
}

const backendDigest = async (name: string): Promise<{ version: number; digest: string | null }> => {
  const stored = await web.f.backend("env1a", name);
  if (stored === null) throw new Error(`no such secret in OpenBao: ${name}`);
  const current = stored.versions.find((row) => row.version === stored.currentVersion);
  return { version: stored.currentVersion, digest: current?.digest ?? null };
};

/** Everything of the page a value could be read from: its markup and what its fields hold. */
async function everythingShown(page: Page): Promise<string> {
  const fields = await page.evaluate(`
    Array.from(document.querySelectorAll("input, textarea, output")).map((field) => field.value).join("\\n")
  `);
  return `${await page.content()}\n${String(fields)}`;
}

const secrets = (page: Page): Locator => page.getByRole("table", { name: "Secrets" });
const rowOf = (page: Page, name: string): Locator =>
  secrets(page)
    .locator("tbody tr")
    .filter({ has: page.getByRole("rowheader", { name, exact: true }) });
const shown = (page: Page): Locator => page.getByLabel("Value", { exact: true });

async function openSecret(page: Page, name: string): Promise<void> {
  await page.goto(`${web.origin}${secretPath(name)}`);
  await page.getByRole("heading", { level: 1, name }).waitFor();
  await page.getByRole("button", { name: "Reveal" }).waitFor();
}

async function reveal(page: Page, value: string): Promise<void> {
  await page.getByRole("button", { name: "Reveal" }).click();
  await shown(page).waitFor();
  expect(await shown(page).textContent()).toBe(value);
}

describe("secrets in the workspace", () => {
  it("create a secret, then the list shows its name and version 1 and no value anywhere in the page", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const name = newName();
    const value = canary();
    try {
      await page.goto(`${web.origin}${listPath()}`);
      await page.getByRole("heading", { level: 1, name: "Secrets" }).waitFor();
      await page.getByRole("button", { name: "New secret" }).click();
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByLabel("Value", { exact: true }).fill(value);
      await page.getByRole("button", { name: "Create secret" }).click();

      const row = rowOf(page, name);
      await row.waitFor();
      expect(await row.textContent()).toContain("live");
      expect(await row.getByRole("cell").nth(1).textContent()).toBe("1");
      await page
        .getByRole("status")
        .filter({ hasText: `${name} is created at version 1` })
        .waitFor();
      // The server has it, and the page has let go of it.
      expect(await backendDigest(name)).toEqual({ version: 1, digest: digest(value) });
      expect(await everythingShown(page)).not.toContain(value);
      expect(await page.getByLabel("Value", { exact: true }).count()).toBe(0);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("reveal shows the value; after 30 s (page.clock) it is gone from the DOM", async () => {
    const { name, value } = await seeded();
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.clock.install();
      await openSecret(page, name);
      // Masked until asked: the page has not read the value at all.
      expect(await everythingShown(page)).not.toContain(value);
      expect(session.requested.some((url) => url.endsWith("/reveal"))).toBe(false);
      await reveal(page, value);
      await page.getByText(/Hidden again in \d+ s/).waitFor();

      await page.clock.fastForward(29_000);
      expect(await shown(page).textContent()).toBe(value);
      await page.clock.fastForward(2_000);
      await page.getByRole("button", { name: "Reveal" }).waitFor();
      expect(await shown(page).count()).toBe(0);
      expect(await everythingShown(page)).not.toContain(value);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("reveal, then hide the tab: gone", async () => {
    const { name, value } = await seeded();
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openSecret(page, name);
      await reveal(page, value);
      await page.evaluate(`
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      `);
      await page.getByRole("button", { name: "Reveal" }).waitFor();
      expect(await everythingShown(page)).not.toContain(value);
      // Coming back does not bring it back.
      await page.evaluate(`
        Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      `);
      expect(await everythingShown(page)).not.toContain(value);
    } finally {
      await session.close();
    }
  });

  it("reveal, then navigate to the list: gone, and back does not bring it back", async () => {
    const { name, value } = await seeded();
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openSecret(page, name);
      await reveal(page, value);
      await page
        .getByRole("navigation", { name: "Sections" })
        .getByRole("link", { name: "Secrets" })
        .click();
      await page.waitForURL(`${web.origin}${listPath()}`);
      await rowOf(page, name).waitFor();
      expect(await everythingShown(page)).not.toContain(value);

      await page.goBack();
      await page.waitForURL(`${web.origin}${secretPath(name)}`);
      await page.getByRole("button", { name: "Reveal" }).waitFor();
      expect(await everythingShown(page)).not.toContain(value);
      expect(await page.evaluate("JSON.stringify(history.state)")).not.toContain(value);
      // One reveal was asked for, and no other was sent behind the owner's back.
      expect(session.requested.filter((url) => url.endsWith("/reveal"))).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it("reveal, then sign out: gone", async () => {
    const { name, value } = await seeded();
    // adminA's own session, so that ending it ends nobody else's.
    const mine = await signInComplete(web.api, web.tenants.credentials("adminA"));
    const session = await web.withCookie(mine.cookie);
    const { page } = session;
    try {
      await page.goto(`${web.origin}${listPath()}`);
      await rowOf(page, name).getByRole("link", { name }).click();
      await page.waitForURL(`${web.origin}${secretPath(name)}`);
      await reveal(page, value);
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.getByRole("heading", { level: 1, name: "Sign in" }).waitFor();
      expect(await everythingShown(page)).not.toContain(value);
      // Back and forward stay in the page: neither brings the value or the workspace back.
      await page.goBack();
      await page.waitForURL(`${web.origin}${listPath()}`);
      await page.getByRole("heading", { level: 1, name: "Sign in" }).waitFor();
      await page.goForward();
      await page.waitForURL(`${web.origin}${secretPath(name)}`);
      await page.getByRole("heading", { level: 1, name: "Sign in" }).waitFor();
      expect(await everythingShown(page)).not.toContain(value);
      expect(session.requested.filter((url) => url.endsWith("/reveal"))).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it("copy puts the value on the clipboard and shows the warning", async () => {
    const { name, value } = await seeded();
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await session.context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: web.origin,
      });
      await openSecret(page, name);
      // Nothing is copied by revealing.
      await page.evaluate(`navigator.clipboard.writeText("before")`);
      await reveal(page, value);
      expect(await page.evaluate("navigator.clipboard.readText()")).toBe("before");
      await page.getByRole("button", { name: "Copy value" }).click();
      await page
        .getByRole("status")
        .filter({
          hasText:
            "The clipboard is outside MyKey: other programs can read it, and MyKey cannot take it back.",
        })
        .waitFor();
      expect(await page.evaluate("navigator.clipboard.readText()")).toBe(value);
      await page.evaluate(`navigator.clipboard.writeText("after")`);
    } finally {
      await session.close();
    }
  });

  it("two tabs edit the same secret: the second save shows the conflict with reload and cancel, and no third choice; after reload the form holds the new version and an empty value", async () => {
    const { name } = await seeded();
    const first = canary();
    const second = canary();
    const session = await web.signedIn("ownerA");
    const one = session.page;
    const two = await session.context.newPage();
    try {
      for (const page of [one, two]) {
        await openSecret(page, name);
        await page.getByRole("button", { name: "Edit value" }).click();
        await page.getByText("This form was opened on version 1.").waitFor();
      }
      await one.getByLabel("New value").fill(first);
      await one.getByRole("button", { name: "Save" }).click();
      await one.getByRole("status").filter({ hasText: "Saved as version 2" }).waitFor();
      expect(await everythingShown(one)).not.toContain(first);

      await two.getByLabel("New value").fill(second);
      await two.getByRole("button", { name: "Save" }).click();
      const conflict = two.getByRole("alert").filter({
        has: two.getByRole("heading", { name: "The secret changed since you opened it" }),
      });
      await conflict.waitFor();
      expect(await conflict.getByRole("button").allTextContents()).toEqual(["Reload", "Cancel"]);
      // Nothing on the page can send the stale change again.
      expect(await two.getByRole("button", { name: "Save" }).count()).toBe(0);
      expect(await two.getByLabel("New value").count()).toBe(0);
      expect(await everythingShown(two)).not.toContain(second);
      expect(await backendDigest(name)).toEqual({ version: 2, digest: digest(first) });

      await conflict.getByRole("button", { name: "Reload" }).click();
      await two.getByText("This form was opened on version 2.").waitFor();
      expect(await two.getByLabel("New value").inputValue()).toBe("");
      expect(await two.getByRole("alert").count()).toBe(0);
      expect(await backendDigest(name)).toEqual({ version: 2, digest: digest(first) });
    } finally {
      await session.close();
    }
  });

  it("a name that breaks the rule and a value over 65,536 bytes are refused in the form with the field's own message, and the server's 422 is shown the same way", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const posts = (): number =>
      session.requested.filter((url) => new URL(url).pathname.endsWith("/secrets")).length;
    const nameRule = /upper-case letters, digits and underscores/;
    try {
      await page.goto(`${web.origin}${listPath()}`);
      await page.getByRole("button", { name: "New secret" }).click();
      const before = posts();
      const name = page.getByLabel("Name", { exact: true });
      const value = page.getByLabel("Value", { exact: true });

      await name.fill("lower-case");
      await value.fill("v");
      await page.getByRole("button", { name: "Create secret" }).click();
      await page.getByRole("alert").filter({ hasText: nameRule }).waitFor();

      await name.fill(newName());
      await value.fill("x".repeat(65_537));
      await page.getByRole("button", { name: "Create secret" }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: /at most 65,536 bytes/ })
        .waitFor();
      expect(await page.getByRole("alert").filter({ hasText: nameRule }).count()).toBe(0);
      // Neither was sent.
      expect(posts()).toBe(before);

      // The server's own refusal: the request leaves valid and arrives with a name the server refuses.
      const good = newName();
      await page.route("**/secrets", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
        await route.continue({ postData: JSON.stringify({ ...body, name: "not a name" }) });
      });
      await name.fill(good);
      await value.fill("v");
      const answered = page.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().endsWith("/secrets"),
      );
      await page.getByRole("button", { name: "Create secret" }).click();
      expect((await answered).status()).toBe(422);
      await page.getByRole("alert").filter({ hasText: nameRule }).waitFor();
      await page
        .getByRole("alert")
        .filter({ hasText: /at most 65,536 bytes/ })
        .waitFor();
      expect(await web.f.backend("env1a", good)).toBeNull();
    } finally {
      await session.close();
    }
  });

  it("507 capacity_exceeded and 503 busy on a write show their texts and leave the form's value in place for the owner", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const name = newName();
    const value = canary();
    const answer = () =>
      page.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().endsWith("/secrets"),
      );
    try {
      await page.goto(`${web.origin}${listPath()}`);
      await page.getByRole("button", { name: "New secret" }).click();
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByLabel("Value", { exact: true }).fill(value);
      const panel = page.getByRole("alert");

      web.api.setCapacity("low");
      let seen = answer();
      await page.getByRole("button", { name: "Create secret" }).click();
      expect((await seen).status()).toBe(507);
      await panel.getByRole("heading", { name: "No room for this" }).waitFor();
      expect(await page.getByLabel("Value", { exact: true }).inputValue()).toBe(value);
      expect(await web.f.backend("env1a", name)).toBeNull();

      web.api.setCapacity("ok");
      await captureMode("draining");
      seen = answer();
      await page.getByRole("button", { name: "Create secret" }).click();
      expect((await seen).status()).toBe(503);
      await panel.getByRole("heading", { name: "The service is busy" }).waitFor();
      expect(await page.getByLabel("Value", { exact: true }).inputValue()).toBe(value);
      expect(await page.getByLabel("Name", { exact: true }).inputValue()).toBe(name);
      expect(await web.f.backend("env1a", name)).toBeNull();

      // The same form, sent again by the owner when the service is back.
      await captureMode("idle");
      await page.getByRole("button", { name: "Create secret" }).click();
      await rowOf(page, name).waitFor();
      expect(await backendDigest(name)).toEqual({ version: 1, digest: digest(value) });
      expect(await everythingShown(page)).not.toContain(value);
    } finally {
      await session.close();
    }
  });

  it("an archived environment's secrets can be listed and revealed, and nothing offers a write", async () => {
    const place = await newProject(web.f);
    const name = newName();
    const value = canary();
    const created = await web.f.send("POST", `${place.path}/secrets`, {
      body: { name, value },
      key: randomUUID(),
    });
    expect(created.status, created.text).toBe(201);
    const archived = await archive(web.f, place.path);
    expect(archived.status, archived.text).toBe(200);
    const here = {
      org: web.tenants.a.organizationId,
      project: place.projectId,
      env: place.environmentId,
    };
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      // The control: an active environment offers both writes.
      await page.goto(`${web.origin}${listPath()}`);
      await page.getByRole("button", { name: "New secret" }).waitFor();

      await page.goto(`${web.origin}${webPath("secrets", here)}`);
      await page.getByText(/This environment is archived/).waitFor();
      await rowOf(page, name).waitFor();
      expect(await page.getByRole("button", { name: "New secret" }).count()).toBe(0);

      await rowOf(page, name).getByRole("link", { name }).click();
      await page.waitForURL(`${web.origin}${webPath("secret", { ...here, name })}`);
      await page.getByRole("button", { name: "Reveal" }).waitFor();
      expect(await page.getByRole("button", { name: "Edit value" }).count()).toBe(0);
      await reveal(page, value);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("a prefix narrows the list, More reads the next page, and a list that changed in between is read again from the start and says so", async () => {
    const prefix = `PG${randomBytes(3).toString("hex").toUpperCase()}`;
    // Two more names than a page holds; index rows only, no value is needed for a list.
    const names = Array.from(
      { length: LIMITS.listing.defaultLimit + 2 },
      (_unused, i) => `${prefix}_${String(i).padStart(2, "0")}`,
    );
    await web.f.seedIndex("env1a", names);
    const late = `${prefix}_99`;
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const rows = (): Promise<number> => secrets(page).locator("tbody tr").count();
    try {
      await page.goto(`${web.origin}${listPath()}`);
      await page.getByLabel("Name starts with").fill(prefix);
      await page.getByRole("button", { name: "Search" }).click();
      await rowOf(page, names[0] ?? "").waitFor();
      expect(await rows()).toBe(LIMITS.listing.defaultLimit);
      // The search never left the page's memory for the address.
      expect(page.url()).toBe(`${web.origin}${listPath()}`);

      // A write between the two pages.
      expect((await web.f.create("env1a", late, canary())).status).toBe(201);
      await page.getByRole("button", { name: "More" }).click();
      await page
        .getByRole("status")
        .filter({
          hasText: "The list changed while it was being read. It was read again from the start.",
        })
        .waitFor();
      expect(await rows()).toBe(LIMITS.listing.defaultLimit);
      await page.getByRole("button", { name: "More" }).click();
      await rowOf(page, late).waitFor();
      expect(await rows()).toBe(names.length + 1);
      expect(await page.getByRole("button", { name: "More" }).count()).toBe(0);
    } finally {
      await web.f.unseedIndex("env1a", names);
      await session.close();
    }
  });
});
