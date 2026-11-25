// Run 11.6 (spec §2.3; P-138, D-60, D-82): the two new credentials in the
// page, over real stores. An automation credential's secret and a runtime
// credential's client secret are each on the screen once, from the answer
// that made them, through the forgetting holder; after navigation neither is
// in an element, a storage, a cookie, the history or an address. A secret
// never appears in an assertion's message: tests compare booleans and names
// of places.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { codeAt, stepAt } from "@mykey/auth";
import { webPath } from "@mykey/contracts";
import type { Locator, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signInComplete } from "../harness/api.ts";
import { clearAutomation, issueAutomationFor, LOOPBACK } from "../harness/automation.ts";
import { clearCredentials } from "../harness/credentials-fixture.ts";
import { holders, keptBy } from "../harness/kept.ts";
import { exchangeCall, machineCall, machineFetch } from "../harness/machine.ts";
import { startWebWithStores, type StoresWeb, type WebSession } from "../harness/web.ts";

let web: StoresWeb;

beforeAll(async () => {
  web = await startWebWithStores();
}, 600_000);

afterAll(async () => {
  await web.close();
});

beforeEach(async () => {
  // Five issuances a minute per person: each test starts with an empty counter.
  await web.api.superuser.query("DELETE FROM app.rate_limit");
  await web.f.freshen();
});

afterEach(async () => {
  await clearCredentials(web.f, web.tenants.a.env1a);
  await clearAutomation(web.f);
});

const newName = (what: string): string => `${what} ${randomBytes(4).toString("hex")}`;
const org = () => ({ org: web.tenants.a.organizationId });
const env = () => ({ ...org(), project: web.tenants.a.project1, env: web.tenants.a.env1a });

async function openAutomation(page: Page): Promise<void> {
  await page.goto(`${web.origin}${webPath("automation", org())}`);
  await page.getByRole("heading", { level: 1, name: "Automation" }).waitFor();
}

const automationRow = (page: Page, name: string): Locator =>
  page
    .getByRole("table", { name: "Automation credentials" })
    .locator("tbody tr")
    .filter({ has: page.getByRole("rowheader", { name, exact: true }) });

const SECRET_PANEL = "The secret, shown once";
const CLIENT_SECRET_PANEL = "The client secret, shown once";

/** Whether the page shows `secret` anywhere: its markup or what its fields hold. */
async function shows(page: Page, secret: string): Promise<boolean> {
  const fields = await page.evaluate(`
    Array.from(document.querySelectorAll("input, textarea, output")).map((field) => field.value).join("\\n")
  `);
  return `${await page.content()}\n${String(fields)}`.includes(secret);
}

/** The API as a script reaches it: the listener and its own CA. */
const api = () => ({
  port: web.api.port,
  ca: readFileSync(web.f.stack.api.certAuthorityPath),
});

/** Leaves the page by a link, comes back by the history, and names every place that holds `secret`. */
async function leaveAndSearch(
  session: WebSession,
  secret: string,
  back: { heading: string; table: string },
): Promise<string[]> {
  const { page } = session;
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: "Audit", exact: true })
    .click();
  await page.getByRole("heading", { level: 1, name: "Audit" }).waitFor();
  const away = holders(await keptBy(session), secret);
  await page.goBack();
  await page.getByRole("heading", { level: 1, name: back.heading }).waitFor();
  await page.getByRole("table", { name: back.table }).waitFor();
  return [...away, ...holders(await keptBy(session), secret)];
}

describe("automation credentials", () => {
  it("the owner issues an automation credential with a fresh code: the secret is on the screen once, and after navigation it is in no element, no storage, no cookie, no history state and no address", async () => {
    const credentials = web.tenants.credentials("ownerA");
    const mine = await signInComplete(web.api, credentials);
    // The page's session verified its code more than ten minutes ago.
    await web.api.superuser.query(
      "UPDATE auth.session SET totp_verified_at = now() - interval '20 minutes' WHERE id = $1",
      [mine.sessionId],
    );
    const session = await web.withCookie(mine.cookie);
    const { page } = session;
    const name = newName("provisioner");
    const answers: number[] = [];
    page.on("response", (response) => {
      if (
        response.request().method() === "POST" &&
        response.url().endsWith("/automation-credentials")
      ) {
        answers.push(response.status());
      }
    });
    try {
      await openAutomation(page);
      // One click from the organization's menu.
      expect(
        await page
          .getByRole("navigation", { name: "Sections" })
          .getByRole("link", { name: "Automation", exact: true })
          .getAttribute("aria-current"),
      ).toBe("page");
      await page.getByRole("button", { name: "New automation credential" }).click();
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByLabel("Create projects and environments").check();
      await page.getByLabel("Manage runtime credentials").check();
      // A week by default.
      expect(await page.getByLabel("Lifetime in days").inputValue()).toBe("7");
      await page.getByLabel("Networks it may call from").fill(LOOPBACK.join("\n"));
      const issue = page.getByRole("button", { name: "Issue automation credential", exact: true });
      await issue.click();

      const code = page.getByRole("dialog", { name: "Confirm with your authenticator" });
      await code.waitFor();
      await code
        .getByLabel("Code from your authenticator app")
        .fill(codeAt(credentials.seed, stepAt(new Date()) + 1));
      await code.getByRole("button", { name: "Confirm" }).click();
      await code.waitFor({ state: "hidden" });
      await page.getByText("Confirmed. Issue the credential again.").waitFor();
      expect(answers).toEqual([403]);
      // The form is as it was: the owner asks again.
      expect(await page.getByLabel("Name", { exact: true }).inputValue()).toBe(name);
      expect(await page.getByLabel("Manage runtime credentials").isChecked()).toBe(true);

      await issue.click();
      const panel = page.getByRole("region", { name: SECRET_PANEL });
      await panel.waitFor({ timeout: 60_000 });
      expect(answers).toEqual([403, 201]);
      expect(await panel.textContent()).toMatch(/cannot be shown again/);
      expect(await panel.textContent()).toMatch(/keyed digest/);
      const secret = (await panel.getByLabel("Secret", { exact: true }).textContent()) ?? "";
      expect(secret.startsWith("mkac.") && secret.length > 60).toBe(true);
      await panel.getByRole("button", { name: "Copy secret" }).waitFor();
      expect(await shows(page, secret)).toBe(true);

      const row = automationRow(page, name);
      await row.waitFor();
      const text = (await row.textContent()) ?? "";
      expect(text).toMatch(/active/);
      expect(text).toContain("Create projects and environments");
      expect(text).toContain("Manage runtime credentials");
      expect(text).not.toContain("Create secrets");
      expect(text).toContain(LOOPBACK[0]);
      expect(text).toContain("never");

      // It is a working credential: the script's first read answers.
      const listed = await machineFetch(api(), "GET", "/v1/automation/projects", {
        token: secret,
      });
      expect(listed.status).toBe(200);

      const found = await leaveAndSearch(session, secret, {
        heading: "Automation",
        table: "Automation credentials",
      });
      expect(found).toEqual([]);
      expect(await page.getByRole("region", { name: SECRET_PANEL }).count()).toBe(0);
      expect(await shows(page, secret)).toBe(false);
      // Control: the search reads the page. The credential's name is found, in the document only.
      expect(holders(await keptBy(session), name)).toEqual(["the document"]);
      expect(session.thirdParty).toEqual([]);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("the secret is gone after its time and when the tab is hidden, and the page says it cannot be shown again", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.clock.install();
      await openAutomation(page);
      for (const how of ["time", "hidden"] as const) {
        const name = newName(how);
        await page.getByRole("button", { name: "New automation credential" }).click();
        await page.getByLabel("Name", { exact: true }).fill(name);
        await page.getByLabel("Create secrets").check();
        await page.getByLabel("Networks it may call from").fill(LOOPBACK.join("\n"));
        await page.getByRole("button", { name: "Issue automation credential" }).click();
        const panel = page.getByRole("region", { name: SECRET_PANEL });
        await panel.waitFor({ timeout: 60_000 });
        const secret = (await panel.getByLabel("Secret", { exact: true }).textContent()) ?? "";
        expect(secret.startsWith("mkac.")).toBe(true);
        if (how === "time") {
          expect(await panel.textContent()).toMatch(/Hidden in \d+ s/);
          await page.clock.fastForward(121_000);
        } else {
          await page.evaluate(`(() => {
            Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
            document.dispatchEvent(new Event("visibilitychange"));
            Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
          })()`);
        }
        await panel.waitFor({ state: "detached" });
        expect(await shows(page, secret)).toBe(false);
        await page.getByText(/is no longer shown, and it cannot be shown again/).waitFor();
      }
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("issuing a runtime credential from the credentials page shows the client secret once, the list then shows kind runtime, and the secret is exchanged for a token that reads", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const name = newName("server");
    try {
      await page.goto(`${web.origin}${webPath("credentials", env())}`);
      await page.getByRole("heading", { level: 1, name: "Machine credentials" }).waitFor();
      await page.getByRole("button", { name: "New credential" }).click();
      // A choice of two, each with its sentence; the token is the one chosen first.
      const token = page.getByRole("radio", { name: /^A 30-day token: for a workstation/ });
      const runtime = page.getByRole("radio", {
        name: /^A runtime credential: for a server that must start by itself/,
      });
      expect(await token.isChecked()).toBe(true);
      expect(await page.getByLabel("Lifetime in days").inputValue()).toBe("30");
      await runtime.check();
      // A year by default, and the networks are a choice.
      expect(await page.getByLabel("Lifetime in days").inputValue()).toBe("365");
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByLabel("Networks it may call from (optional)").fill(LOOPBACK.join("\n"));
      await page.getByRole("button", { name: "Issue credential", exact: true }).click();

      const panel = page.getByRole("region", { name: CLIENT_SECRET_PANEL });
      await panel.waitFor({ timeout: 60_000 });
      expect(await page.getByRole("region", { name: "The token, shown once" }).count()).toBe(0);
      expect(await panel.textContent()).toMatch(/cannot be shown again/);
      const secret = (await panel.getByLabel("Client secret", { exact: true }).textContent()) ?? "";
      expect(secret.startsWith("mkrc.") && secret.length > 60).toBe(true);
      await panel.getByRole("button", { name: "Copy client secret" }).waitFor();

      const row = page
        .getByRole("table", { name: "Machine credentials" })
        .locator("tbody tr")
        .filter({ has: page.getByRole("rowheader", { name, exact: true }) });
      await row.waitFor();
      const text = (await row.textContent()) ?? "";
      expect(text).toMatch(/active/);
      expect(text).toContain("runtime credential");
      expect(text).toContain(LOOPBACK[0]);
      expect(text).toContain("(you)");

      const exchanged = await exchangeCall(web.f, { secret });
      expect(exchanged.status).toBe(200);
      const keys = await machineCall(web.f, "keys", {
        env: "env1a",
        token: String(exchanged.body.token),
      });
      expect(keys.status).toBe(200);

      const found = await leaveAndSearch(session, secret, {
        heading: "Machine credentials",
        table: "Machine credentials",
      });
      expect(found).toEqual([]);
      expect(await page.getByRole("region", { name: CLIENT_SECRET_PANEL }).count()).toBe(0);
      expect(await shows(page, secret)).toBe(false);
      // The exchanged token was never the page's.
      expect(holders(await keptBy(session), String(exchanged.body.token))).toEqual([]);
      expect(session.thirdParty).toEqual([]);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("revoke asks, says what stays, and the row reads revoked; the secret is then refused", async () => {
    const name = newName("retired");
    const issued = await issueAutomationFor(web.f, { name });
    expect(
      (await machineFetch(api(), "GET", "/v1/automation/projects", { token: issued.secret }))
        .status,
    ).toBe(200);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await openAutomation(page);
      const row = automationRow(page, name);
      await row.getByRole("button", { name: "Revoke" }).click();
      const dialog = page.getByRole("dialog", { name: `Revoke ${name}` });
      await dialog.waitFor();
      const said = (await dialog.textContent()) ?? "";
      expect(said).toContain(
        "The projects its chain manages, their secrets and every runtime credential it issued keep working",
      );
      expect(said).toContain("cannot be undone");
      const confirm = dialog.getByRole("button", { name: "Revoke", exact: true });
      expect(await confirm.isDisabled()).toBe(true);
      await dialog.getByLabel("Type the name to confirm").fill(name);
      await confirm.click();
      await dialog.waitFor({ state: "detached", timeout: 60_000 });
      await page.getByText(`${name} is revoked.`, { exact: false }).waitFor();
      await expect.poll(async () => (await row.textContent()) ?? "").toMatch(/revoked/);
      expect(await row.getByRole("button", { name: "Revoke" }).count()).toBe(0);
      const refused = await machineFetch(api(), "GET", "/v1/automation/projects", {
        token: issued.secret,
      });
      expect([refused.status, refused.code]).toEqual([401, "unauthenticated"]);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("a network the server refuses is explained in words, with no code on the screen, and nothing is issued", async () => {
    const session = await web.signedIn("ownerA");
    const { page } = session;
    const name = newName("refused");
    const answers: number[] = [];
    page.on("response", (response) => {
      if (
        response.request().method() === "POST" &&
        response.url().endsWith("/automation-credentials")
      ) {
        answers.push(response.status());
      }
    });
    try {
      await openAutomation(page);
      await page.getByRole("button", { name: "New automation credential" }).click();
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByLabel("Create secrets").check();
      // Host bits are set: the contract refuses it (the page does not check a network itself).
      await page.getByLabel("Networks it may call from").fill("192.0.2.7/24");
      await page.getByRole("button", { name: "Issue automation credential" }).click();
      const alert = page
        .getByRole("alert")
        .filter({ has: page.getByRole("heading", { name: "A value is not valid" }) });
      await alert.waitFor({ timeout: 60_000 });
      expect(answers).toEqual([422]);
      await page.getByText(/The service refused a network/).waitFor();
      const shown = (await page.locator("main").textContent()) ?? "";
      expect(shown).not.toContain("validation_failed");
      expect(shown).not.toMatch(/\b422\b/);
      expect(await page.getByRole("region", { name: SECRET_PANEL }).count()).toBe(0);
      const stored = await web.api.superuser.query(
        "SELECT 1 FROM app.automation_credential WHERE name = $1",
        [name],
      );
      expect(stored.rowCount).toBe(0);
      // What the form itself refuses never reaches the server: no right, and no network.
      await page.getByLabel("Create secrets").uncheck();
      await page.getByLabel("Networks it may call from").fill("");
      await page.getByRole("button", { name: "Issue automation credential" }).click();
      await page.getByText("Choose at least one right.").waitFor();
      await page.getByText(/Name one to 8 networks/).waitFor();
      expect(answers).toEqual([422]);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("a project made by automation says so on its page, with the name of the chain's first credential", async () => {
    const name = newName("chain");
    const issued = await issueAutomationFor(web.f, { name });
    await web.api.superuser.query("UPDATE app.project SET managed_by = $2 WHERE id = $1", [
      web.tenants.a.project2,
      issued.ownerId,
    ]);
    const session = await web.signedIn("ownerA");
    const { page } = session;
    try {
      await page.goto(
        `${web.origin}${webPath("project", { ...org(), project: web.tenants.a.project2 })}`,
      );
      await page.getByText(`Managed by automation: ${name}`).waitFor();
      // The automation page counts it.
      await openAutomation(page);
      const row = automationRow(page, name);
      await row.waitFor();
      expect(await row.getByRole("cell").nth(5).textContent()).toBe("1");
      // A project a person made says nothing of it.
      await page.goto(
        `${web.origin}${webPath("project", { ...org(), project: web.tenants.a.project1 })}`,
      );
      await page.getByRole("table", { name: "Environments" }).waitFor();
      expect(await page.getByText(/Managed by automation/).count()).toBe(0);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("a member is not shown the page's link, and the server tells the page nothing; no request of this file left the test origin", async () => {
    const session = await web.signedIn("editorA");
    const { page } = session;
    try {
      await page.goto(`${web.origin}${webPath("overview", org())}`);
      await page.getByRole("navigation", { name: "Sections" }).waitFor();
      await page.getByRole("link", { name: "Home", exact: true }).first().waitFor();
      expect(
        await page
          .getByRole("navigation", { name: "Sections" })
          .getByRole("link", { name: "Automation", exact: true })
          .count(),
      ).toBe(0);
      await page.goto(`${web.origin}${webPath("automation", org())}`);
      await page.getByRole("alert").first().waitFor();
      expect(await page.getByRole("table", { name: "Automation credentials" }).count()).toBe(0);
      expect(session.thirdParty).toEqual([]);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  }, 240_000);
});
