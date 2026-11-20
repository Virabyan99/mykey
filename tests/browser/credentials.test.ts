// Run 7.7 (FR-1.41 to FR-1.44, FR-1.91, P-138): machine credentials in the
// page, over real OpenBao. A token is shown once, from the answer that made
// it, through the forgetting holder, and is gone when the owner leaves. The
// inventory shows what the server knows and says "not known" for the rest.
// A token never appears in an assertion's message: tests compare booleans.
import { randomBytes } from "node:crypto";
import { codeAt, stepAt } from "@mykey/auth";
import { webPath } from "@mykey/contracts";
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
  // Five issuances a minute per person (P-115): each test starts with an empty counter.
  await web.api.superuser.query("DELETE FROM app.rate_limit");
  await web.f.freshen();
});

afterEach(async () => {
  await clearCredentials(web.f, web.tenants.a.env1a);
});

const newName = (): string => `deploy ${randomBytes(4).toString("hex")}`;
const at = () => ({
  org: web.tenants.a.organizationId,
  project: web.tenants.a.project1,
  env: web.tenants.a.env1a,
});

async function openCredentials(page: Page): Promise<void> {
  await page.goto(`${web.origin}${webPath("credentials", at())}`);
  await page.getByRole("heading", { level: 1, name: "Machine credentials" }).waitFor();
}

const rowOf = (page: Page, name: string): Locator =>
  page
    .getByRole("table", { name: "Machine credentials" })
    .locator("tbody tr")
    .filter({ has: page.getByRole("rowheader", { name, exact: true }) });

async function fillIssue(page: Page, name: string, days?: string): Promise<void> {
  await page.getByRole("button", { name: "New credential" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  if (days !== undefined) await page.getByLabel("Lifetime in days").fill(days);
}

const issueButton = (page: Page): Locator =>
  page.getByRole("button", { name: "Issue credential", exact: true });

/** Whether the page shows `secret` anywhere: its markup or what its fields hold. */
async function shows(page: Page, secret: string): Promise<boolean> {
  const fields = await page.evaluate(`
    Array.from(document.querySelectorAll("input, textarea, output")).map((field) => field.value).join("\\n")
  `);
  return `${await page.content()}\n${String(fields)}`.includes(secret);
}

/**
 * A credential issued through the product (the inventory lists only those),
 * then put by the superuser into what a test needs.
 */
async function seedRow(
  name: string,
  state: string,
  expiresInSeconds: number | null,
  lastUsed: boolean,
): Promise<void> {
  const issued = await issueFor(web.f, "env1a", { name, ttlSeconds: 3600 });
  await web.api.superuser.query(
    `UPDATE app.machine_credential
        SET state = $2,
            effective_expires_at = now() + make_interval(secs => $3::double precision),
            last_used_at = CASE WHEN $4 THEN now() - interval '2 hours' END
      WHERE id = $1`,
    [issued.credentialId, state, expiresInSeconds, lastUsed],
  );
}

describe("machine credentials", () => {
  it("issue asks for a fresh code, shows the token once, and the token works against machine.keys", async () => {
    const credentials = web.tenants.credentials("adminA");
    const mine = await signInComplete(web.api, credentials);
    // The page's session verified its code more than ten minutes ago.
    await web.api.superuser.query(
      "UPDATE auth.session SET totp_verified_at = now() - interval '20 minutes' WHERE id = $1",
      [mine.sessionId],
    );
    const session = await web.withCookie(mine.cookie);
    const { page } = session;
    const name = newName();
    const answers: number[] = [];
    page.on("response", (response) => {
      if (response.request().method() === "POST" && response.url().endsWith("/credentials")) {
        answers.push(response.status());
      }
    });
    try {
      await page.clock.install();
      await openCredentials(page);
      await fillIssue(page, name);
      // The default lifetime is the maximum.
      expect(await page.getByLabel("Lifetime in days").inputValue()).toBe("30");
      await issueButton(page).click();
      const code = page.getByRole("dialog", { name: "Confirm with your authenticator" });
      await code.waitFor();
      await code
        .getByLabel("Code from your authenticator app")
        .fill(codeAt(credentials.seed, stepAt(new Date()) + 1));
      await code.getByRole("button", { name: "Confirm" }).click();
      await code.waitFor({ state: "hidden" });
      // The page does not issue by itself: the owner asks again, with the form as it was.
      await page.getByText("Confirmed. Issue the credential again.").waitFor();
      expect(answers).toEqual([403]);
      expect(await page.getByLabel("Name", { exact: true }).inputValue()).toBe(name);

      await issueButton(page).click();
      const panel = page.getByRole("region", { name: "The token, shown once" });
      await panel.waitFor({ timeout: 60_000 });
      expect(answers).toEqual([403, 201]);
      expect(await panel.textContent()).toMatch(/cannot be shown again/);
      expect(await panel.textContent()).toMatch(/Hidden in \d+ s/);
      const token = (await panel.getByLabel("Token").textContent()) ?? "";
      expect(token.length > 20).toBe(true);
      await panel.getByRole("button", { name: "Copy token" }).waitFor();

      const row = rowOf(page, name);
      await row.waitFor();
      expect(await row.textContent()).toMatch(/active/);
      expect(await row.textContent()).toContain("(you)");

      const keys = await machineCall(web.f, "keys", { env: "env1a", token });
      expect(keys.status).toBe(200);
      expect(keys.body.complete).toBe(true);

      // 120 seconds, and not a second more.
      await page.clock.fastForward(121_000);
      await panel.waitFor({ state: "detached" });
      expect(await shows(page, token)).toBe(false);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("after navigating away and back the token is not in the page, the history state or any storage", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openCredentials(page);
      await fillIssue(page, newName(), "1");
      await issueButton(page).click();
      const panel = page.getByRole("region", { name: "The token, shown once" });
      await panel.waitFor({ timeout: 60_000 });
      const token = (await panel.getByLabel("Token").textContent()) ?? "";
      expect(token.length > 20).toBe(true);
      expect(await shows(page, token)).toBe(true);

      await page
        .getByRole("navigation", { name: "Sections" })
        .getByRole("link", { name: "Secrets" })
        .click();
      await page.getByRole("heading", { level: 1, name: "Secrets" }).waitFor();
      expect(await shows(page, token)).toBe(false);
      await page.goBack();
      await page.getByRole("heading", { level: 1, name: "Machine credentials" }).waitFor();
      await page.getByRole("table", { name: "Machine credentials" }).waitFor();
      expect(await page.getByRole("region", { name: "The token, shown once" }).count()).toBe(0);
      expect(await shows(page, token)).toBe(false);
      const kept = String(
        await page.evaluate(`JSON.stringify({
          local: Object.entries(window["local" + "Storage"]),
          session: Object.entries(window["session" + "Storage"]),
          state: history.state,
          cookie: document.cookie,
        })`),
      );
      expect(kept.includes(token)).toBe(false);
      expect(JSON.parse(kept)).toMatchObject({ local: [], session: [], state: null });
    } finally {
      await session.close();
    }
  }, 240_000);

  it("the same request replayed (the harness sends the same key) shows credential_not_replayable with its explanation", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const name = newName();
    const first: number[] = [];
    // The first answer is lost on its way: the server issued, the page heard nothing.
    await page.route("**/credentials", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || first.length > 0) return route.fallback();
      const answer = await web.f.send("POST", `${web.f.env("env1a").path}/credentials`, {
        body: request.postDataJSON() as Record<string, unknown>,
        key: (await request.allHeaders())["idempotency-key"] ?? "",
      });
      first.push(answer.status);
      await route.abort("connectionreset");
    });
    try {
      await openCredentials(page);
      await fillIssue(page, name, "2");
      await issueButton(page).click();
      const lost = page.getByRole("alert").first();
      await lost.waitFor({ timeout: 60_000 });
      expect(first).toEqual([201]);
      expect(await page.getByRole("region", { name: "The token, shown once" }).count()).toBe(0);

      // The same press again is the same request: the server will not make a second token.
      await issueButton(page).click();
      const refused = page
        .getByRole("alert")
        .filter({ has: page.getByRole("heading", { name: "This token cannot be shown again" }) });
      await refused.waitFor({ timeout: 60_000 });
      expect(await refused.textContent()).toMatch(
        /already delivered once, or its delivery was lost/,
      );
      expect(await refused.textContent()).toMatch(/Revoke that credential and issue a new one/);
      expect(await page.getByRole("region", { name: "The token, shown once" }).count()).toBe(0);
      // One credential, not two, and it is in the list to be revoked.
      const stored = await web.api.superuser.query(
        "SELECT 1 FROM app.machine_credential WHERE environment_id = $1 AND name = $2",
        [web.tenants.a.env1a, name],
      );
      expect(stored.rowCount).toBe(1);
      await rowOf(page, name).getByRole("button", { name: "Revoke" }).waitFor();
    } finally {
      await session.close();
    }
  }, 240_000);

  it("revoke asks for confirmation, the row becomes revoked, and the token is refused by machine.keys", async () => {
    const name = newName();
    const issued = await issueFor(web.f, "env1a", { name, ttlSeconds: 3600 });
    expect((await machineCall(web.f, "keys", { env: "env1a", token: issued.token })).status).toBe(
      200,
    );
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openCredentials(page);
      const row = rowOf(page, name);
      await row.getByRole("button", { name: "Revoke" }).click();
      const dialog = page.getByRole("dialog", { name: `Revoke ${name}` });
      await dialog.waitFor();
      const confirm = dialog.getByRole("button", { name: "Revoke", exact: true });
      expect(await confirm.isDisabled()).toBe(true);
      // Nothing happened yet.
      expect((await machineCall(web.f, "keys", { env: "env1a", token: issued.token })).status).toBe(
        200,
      );
      await dialog.getByLabel("Type the name to confirm").fill(name);
      await confirm.click();
      await page.getByText(`${name} is revoked.`, { exact: false }).waitFor({ timeout: 60_000 });
      await row.locator(".badge", { hasText: "revoked" }).waitFor();
      expect(await row.getByRole("button").count()).toBe(0);
      expect((await machineCall(web.f, "keys", { env: "env1a", token: issued.token })).status).toBe(
        401,
      );
    } finally {
      await session.close();
    }
  }, 240_000);

  it('a credential within 7 days of expiry carries the warning text; one with no known last use says "not known"', async () => {
    await seedRow("ends soon", "active", 3 * 24 * 3600, false);
    await seedRow("ends later", "active", 20 * 24 * 3600, true);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openCredentials(page);
      const soon = rowOf(page, "ends soon");
      await soon.waitFor();
      expect(await soon.textContent()).toMatch(/Expires within 7 days/);
      const cells = async (row: Locator): Promise<Record<string, string>> => {
        const heads = await page
          .getByRole("table", { name: "Machine credentials" })
          .locator("thead th")
          .allTextContents();
        const values = await row.locator("th, td").allTextContents();
        return Object.fromEntries(heads.map((head, index) => [head, values[index] ?? ""]));
      };
      expect((await cells(soon))["Last used"]).toBe("not known");
      expect((await cells(soon)).Scope).toBe("Project One / dev");

      const later = rowOf(page, "ends later");
      expect(await later.textContent()).not.toMatch(/Expires within 7 days/);
      expect((await cells(later))["Last used"]).not.toBe("not known");
      expect(await later.locator("time").count()).toBeGreaterThanOrEqual(2);
      // The fixed help: replace, do not renew; a restore revokes every token.
      const main = (await page.getByRole("main").textContent()) ?? "";
      expect(main).toMatch(/cannot be renewed/);
      expect(main).toMatch(/restored from a backup, every token is revoked/);
    } finally {
      await session.close();
    }
  });

  it("a needs_review row offers no issue button", async () => {
    await seedRow("outcome open", "needs_review", null, false);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openCredentials(page);
      const row = rowOf(page, "outcome open");
      await row.waitFor();
      expect(await row.textContent()).toMatch(/An operator settles this/);
      expect(await row.getByRole("button").count()).toBe(0);
      // And the environment issues nothing until it is settled.
      expect(await page.getByRole("button", { name: "New credential" }).count()).toBe(0);
      expect(await issueButton(page).count()).toBe(0);
      await page.getByText(/No credential can be issued for this environment until/).waitFor();
    } finally {
      await session.close();
    }
  });

  it("expired, revoking and issuing rows say what they are and offer no button", async () => {
    await seedRow("lapsed", "active", -3600, true);
    await seedRow("closing", "revoking", 3600, false);
    await seedRow("in flight", "issuing", null, false);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openCredentials(page);
      // Past its expiry and not swept yet: the page says expired, as the server does.
      const lapsed = rowOf(page, "lapsed");
      await lapsed.locator(".badge", { hasText: "expired" }).waitFor();
      expect(await lapsed.getByRole("button").count()).toBe(0);
      const closing = rowOf(page, "closing");
      await closing.locator(".badge", { hasText: "revoking" }).waitFor();
      expect(await closing.textContent()).toMatch(/An operator settles this/);
      expect(await closing.textContent()).toMatch(/still accepted/);
      expect(await closing.getByRole("button").count()).toBe(0);
      const flying = rowOf(page, "in flight");
      await flying.locator(".badge", { hasText: "issuing" }).waitFor();
      expect(await flying.getByRole("button").count()).toBe(0);
      // An issuance without an end closes the environment for the next one.
      expect(await page.getByRole("button", { name: "New credential" }).count()).toBe(0);
      await page
        .getByText(/No credential can be issued for this environment until in flight/)
        .waitFor();
    } finally {
      await session.close();
    }
  });

  it("the overview shows the organization's credentials by state and the ones that expire soon", async () => {
    await seedRow("ends soon", "active", 3 * 24 * 3600, false);
    await seedRow("ends later", "active", 20 * 24 * 3600, true);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${webPath("overview", { org: at().org })}`);
      const section = page.getByRole("region", { name: "Machine credentials" });
      await section.waitFor();
      const counts = Object.fromEntries(
        await Promise.all(
          (
            await section
              .getByRole("table", { name: "Credentials by state" })
              .locator("tbody tr")
              .all()
          ).map(
            async (row) =>
              [
                // The badge is a shape and a word: the word is the state.
                ((await row.getByRole("rowheader").textContent()) ?? "").replace(/^\S+\s/, ""),
                (await row.getByRole("cell").textContent()) ?? "",
              ] as const,
          ),
        ),
      );
      const stored = await web.api.superuser.query<{ active: string; revoked: string }>(
        `SELECT count(*) FILTER (WHERE state = 'active' AND effective_expires_at > now()) AS active,
                count(*) FILTER (WHERE state = 'revoked') AS revoked
           FROM app.machine_credential WHERE organization_id = $1`,
        [at().org],
      );
      expect(counts.active).toBe(stored.rows[0]?.active);
      expect(counts.revoked).toBe(stored.rows[0]?.revoked);
      expect(Object.keys(counts)).toHaveLength(6);
      const expiring = section
        .getByRole("list", { name: "Expiring within 7 days" })
        .locator("> li");
      expect(await expiring.count()).toBe(1);
      expect(await expiring.first().textContent()).toMatch(/^ends soon/);
      expect(await expiring.first().getByRole("link").getAttribute("href")).toBe(
        webPath("credentials", at()),
      );
    } finally {
      await session.close();
    }
  });
});
