// Session 7 gate (Doc 10 §4.5; FR-1.89, PO-12): the owner's workspace on
// staging, in Chromium, through the public name, as the staging owner. The
// journey's core: sign in with the form, a project of its own, a secret
// written and revealed, a token issued, used and revoked, sign out. Every step
// asserts what the server then says, asked over the API with a second session
// or with the machine token.
//
// The project is `s7-web-<6 hex>`; projects cannot be deleted, so it is
// archived in `finally` (which revokes its credentials) and its id is in the
// evidence file. Values are synthetic and never printed: digests are compared.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import * as OTPAuth from "otpauth";
import { chromium, type Locator, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { registerSecret } from "../harness/staging.ts";
import { machineRequest } from "../harness/staging-machine.ts";
import {
  STAGING_ORIGIN,
  STAGING_OWNER_EMAIL,
  freshCode,
  publicRequest,
  readCustody,
  stagingOwnerSession,
  type PublicAnswer,
} from "../harness/staging-owner.ts";

/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const ENVIRONMENT = "development";
const EVIDENCE = "docs/evidence/session-7/run-7.10-staging.json";
const evidence: Record<string, unknown> = {};
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const heading = (page: Page, name: string): Locator =>
  page.getByRole("heading", { level: 1, name });
const section = (page: Page, name: string): Locator =>
  page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name, exact: true });

function custody(name: string): string {
  const value = readCustody(name);
  if (value === null) throw new Error(`no ${name} in workstation custody`);
  registerSecret(value);
  return value;
}

async function confirmTyped(dialog: Locator, name: string, button: string): Promise<void> {
  await dialog.waitFor();
  await dialog.getByLabel("Type the name to confirm").fill(name);
  await dialog.getByRole("button", { name: button, exact: true }).click();
}

describe("the workspace on staging", () => {
  it("in Chromium as the staging owner: sign in, a project, a secret written and revealed, a token issued, used and revoked, sign out", async () => {
    const password = custody("owner-password");
    const seed = new Uint8Array(OTPAuth.Secret.fromBase32(custody("owner-totp-seed")).bytes);
    const project = `s7-web-${randomBytes(3).toString("hex")}`;
    const name = `WEB_${randomBytes(4).toString("hex").toUpperCase()}`;
    const value = `synthetic-${randomUUID()}`;
    const credential = `s7-web-${randomBytes(3).toString("hex")}`;
    const organization = `/v1/organizations/${ORGANIZATION}`;
    let projectId = "";
    /** A second session of the owner: what the server says, asked outside the page. */
    let cookie = "";

    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    context.setDefaultTimeout(30_000);
    const elsewhere: string[] = [];
    const said: string[] = [];
    context.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith("data:") && new URL(url).origin !== STAGING_ORIGIN) {
        elsewhere.push(new URL(url).origin);
      }
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") said.push(message.text().slice(0, 200));
    });
    try {
      // --- the page and its policy, as staging's edge sends them -------------
      const document = await page.goto(`${STAGING_ORIGIN}/`);
      const headers = document?.headers() ?? {};
      expect(document?.status()).toBe(200);
      const policy = headers["content-security-policy"] ?? "";
      for (const part of [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ]) {
        expect(policy.split("; ").includes(part), part).toBe(true);
      }
      expect(policy).not.toContain("unsafe");
      expect(headers["referrer-policy"]).toBe("no-referrer");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["cache-control"]).toBe("no-store");
      expect(headers["strict-transport-security"] ?? "").toContain("max-age=");

      // --- sign in by the form ----------------------------------------------
      await heading(page, "Sign in").waitFor();
      await page.getByLabel("E-mail address").fill(STAGING_OWNER_EMAIL);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await heading(page, "Enter your code").waitFor();
      await page.getByLabel("Code from your authenticator app").fill(await freshCode(seed));
      await page.getByRole("button", { name: "Verify" }).click();
      await page.getByRole("navigation", { name: "Scope" }).waitFor();
      ({ cookie } = await stagingOwnerSession());

      // --- a project of its own ---------------------------------------------
      await heading(page, "Overview").waitFor();
      await page.getByRole("button", { name: "New project" }).click();
      await page.getByLabel("Project name").fill(project);
      await page.getByRole("button", { name: "Create project" }).click();
      const region = page.getByRole("region", { name: project });
      await region.waitFor();
      const projects = await publicRequest("GET", `${organization}/projects?limit=100`, { cookie });
      expect(projects.status).toBe(200);
      const all = (json(projects).projects ?? []) as { id: string; name: string }[];
      projectId = all.find((row) => row.name === project)?.id ?? "";
      expect(projectId, "the server has the project").toMatch(/^[0-9a-f-]{36}$/);
      const projectPath = `${organization}/projects/${projectId}`;
      // The real provisioner makes its first environment.
      let environmentId = "";
      for (const deadline = Date.now() + 180_000; ;) {
        const listed = await publicRequest("GET", `${projectPath}/environments`, { cookie });
        const rows = (json(listed).environments ?? []) as {
          id: string;
          name: string;
          state: string;
        }[];
        const own = rows.find((row) => row.name === ENVIRONMENT);
        if (own?.state === "active") {
          environmentId = own.id;
          break;
        }
        if (Date.now() > deadline) throw new Error(`environment stayed ${String(own?.state)}`);
        await sleep(3000);
      }
      const environmentPath = `${projectPath}/environments/${environmentId}`;
      record("project", { name: project, id: projectId, environment: environmentId });

      // --- a secret, written and revealed -----------------------------------
      // The overview learns by its own schedule that the environment is active.
      await region.getByRole("link", { name: ENVIRONMENT, exact: true }).click({ timeout: 90_000 });
      await heading(page, "Secrets").waitFor();
      await page.getByRole("button", { name: "New secret" }).click();
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByLabel("Value", { exact: true }).fill(value);
      await page.getByRole("button", { name: "Create secret" }).click();
      await page
        .getByRole("status")
        .filter({ hasText: `${name} is created at version 1` })
        .waitFor({ timeout: 60_000 });
      const secrets = await publicRequest("GET", `${environmentPath}/secrets?limit=100`, {
        cookie,
      });
      const listed = (json(secrets).secrets ?? []) as {
        name: string;
        version: number;
        state: string;
      }[];
      expect(listed.map((row) => [row.name, row.version, row.state])).toEqual([[name, 1, "live"]]);

      await page
        .getByRole("table", { name: "Secrets" })
        .getByRole("link", { name, exact: true })
        .click();
      await heading(page, name).waitFor();
      await page.getByRole("button", { name: "Reveal", exact: true }).click();
      const shown = page.getByLabel("Value", { exact: true });
      await shown.waitFor();
      expect(digest((await shown.textContent()) ?? "") === digest(value)).toBe(true);

      // --- a token: issued, used, revoked -----------------------------------
      await section(page, "Machine credentials").click();
      await heading(page, "Machine credentials").waitFor();
      await page.getByRole("button", { name: "New credential" }).click();
      await page.getByLabel("Name", { exact: true }).fill(credential);
      const issue = page.getByRole("button", { name: "Issue credential", exact: true });
      await issue.click();
      const panel = page.getByRole("region", { name: "The token, shown once" });
      const stepUp = page.getByRole("dialog", { name: "Confirm with your authenticator" });
      await panel.or(stepUp).first().waitFor({ timeout: 60_000 });
      if (await stepUp.isVisible()) {
        await stepUp.getByLabel("Code from your authenticator app").fill(await freshCode(seed));
        await stepUp.getByRole("button", { name: "Confirm" }).click();
        await stepUp.waitFor({ state: "hidden" });
        await issue.click();
        await panel.waitFor({ timeout: 60_000 });
      }
      const token = (await panel.getByLabel("Token").textContent()) ?? "";
      registerSecret(token);
      const resolved = await machineRequest("resolve", projectId, ENVIRONMENT, token);
      expect(resolved.status).toBe(200);
      const entries = (json(resolved).entries ?? []) as { name: string; value: string }[];
      expect(entries.map((entry) => [entry.name, digest(entry.value)])).toEqual([
        [name, digest(value)],
      ]);

      const row = page
        .getByRole("table", { name: "Machine credentials" })
        .locator("tbody tr")
        .filter({ has: page.getByRole("rowheader", { name: credential, exact: true }) });
      await row.getByRole("button", { name: "Revoke" }).click();
      await confirmTyped(page.getByRole("dialog"), credential, "Revoke");
      await row.locator(".badge", { hasText: "revoked" }).waitFor({ timeout: 60_000 });
      expect((await machineRequest("keys", projectId, ENVIRONMENT, token)).status).toBe(401);

      // --- sign out ---------------------------------------------------------
      const held = (await context.cookies()).find(
        (kept) => kept.name === "__Secure-better-auth.session_token",
      );
      if (held === undefined) throw new Error("the browser holds no session cookie");
      registerSecret(held.value);
      const browserCookie = `${held.name}=${held.value}`;
      expect(
        (await publicRequest("GET", "/v1/organizations", { cookie: browserCookie })).status,
      ).toBe(200);
      await page.getByRole("button", { name: "Sign out" }).click();
      await heading(page, "Sign in").waitFor();
      expect(
        (await publicRequest("GET", "/v1/organizations", { cookie: browserCookie })).status,
      ).toBe(401);

      // The page asked nobody else, and the browser refused nothing of it.
      expect(elsewhere).toEqual([]);
      expect(said).toEqual([]);
      record("journey", { secret: name, credential, afterRevoke: 401, afterSignOut: 401 });
    } finally {
      await browser.close();
      if (projectId !== "") {
        // Archiving revokes whatever credential is left and closes the project.
        if (cookie === "") ({ cookie } = await stagingOwnerSession());
        const archived = await publicRequest(
          "POST",
          `${organization}/projects/${projectId}/archive`,
          { body: { confirmed: true }, cookie, headers: { "idempotency-key": randomUUID() } },
        );
        record("archive", { status: archived.status });
      }
    }
  }, 900_000);
});
