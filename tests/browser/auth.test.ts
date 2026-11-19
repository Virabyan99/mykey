// Run 7.2 (P-137, P-138; FR-1.01 to FR-1.08; Doc 10 §4.1 rules 2 and 6): the
// sign-in and security screens in Chromium against the real auth module.
// Codes come from the fixture's seeds; nothing is mocked.
import { setTimeout as sleep } from "node:timers/promises";
import { codeAt, createThrottle, stepAt } from "@mykey/auth";
import { initiateReset } from "@mykey/auth/operator";
import { WEB_ROUTES, webPath } from "@mykey/contracts";
import * as OTPAuth from "otpauth";
import type { Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sessionCookieOf, signInComplete } from "../harness/api.ts";
import type { FixtureUser } from "../harness/tenants.ts";
import { startWeb, type Web, type WebSession } from "../harness/web.ts";

let web: Web;
/** Steps a seed's codes were used at: a code works once per step (the server refuses a replay). */
const used = new Map<string, Set<number>>();
const fixtureSteps: number[] = [];

beforeAll(async () => {
  const before = stepAt(new Date());
  web = await startWeb();
  // Every fixture user was activated at some step between these two.
  for (let step = before - 1; step <= stepAt(new Date()) + 1; step += 1) fixtureSteps.push(step);
}, 300_000);

afterAll(async () => {
  await web.close();
});

beforeEach(async () => {
  // Five sign-ins a minute from one address (P-48): each test starts with an empty counter.
  await web.api.superuser.query("DELETE FROM app.rate_limit");
});

/** A code of `seed` at a step that was not used yet (the server accepts the steps around now). */
async function codeOf(seed: Uint8Array, fixture = true): Promise<string> {
  const key = Buffer.from(seed).toString("hex");
  const taken = used.get(key) ?? new Set(fixture ? fixtureSteps : []);
  used.set(key, taken);
  for (;;) {
    const now = stepAt(new Date());
    const step = [now, now + 1, now - 1].find((candidate) => !taken.has(candidate));
    if (step !== undefined) {
      taken.add(step);
      return codeAt(seed, step);
    }
    await sleep(5_000);
  }
}

const codeFor = (user: FixtureUser): Promise<string> => codeOf(web.tenants.credentials(user).seed);

const heading = (page: Page, name: string) => page.getByRole("heading", { name, level: 1 });
const overview = (): string => webPath("overview", { org: web.tenants.a.organizationId });

async function signInWithPassword(page: Page, email: string, password: string): Promise<void> {
  await heading(page, "Sign in").waitFor();
  await page.getByLabel("E-mail address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Everything the page could have kept: both storages, the history entry's state, the cookies. */
async function kept(session: WebSession): Promise<string> {
  const inPage = await session.page.evaluate(() => {
    const scope = globalThis as unknown as Record<string, Record<string, unknown>>;
    const dump = (name: string): string => JSON.stringify(Object.entries(scope[name] ?? {}));
    return [
      dump("localStorage"),
      dump("sessionStorage"),
      JSON.stringify((scope.history as { state?: unknown }).state ?? null),
      String((scope.location as { href?: unknown }).href),
    ].join("\n");
  });
  const cookies = (await session.context.cookies()).map((cookie) => cookie.value).join("\n");
  return `${inPage}\n${cookies}`;
}

describe("sign-in and the security screens", () => {
  it("password, then TOTP, lands on the overview; the address bar never held the password or the code", async () => {
    const session = await web.anonymous();
    const { page } = session;
    const { email, password } = web.tenants.credentials("editorA");
    const addresses: string[] = [];
    page.on("framenavigated", (frame) => addresses.push(frame.url()));
    try {
      await page.goto(`${web.origin}/`);
      await signInWithPassword(page, email, password);
      await heading(page, "Enter your code").waitFor();
      const code = await codeFor("editorA");
      await page.getByLabel("Code from your authenticator app").fill(code);
      await page.getByRole("button", { name: "Verify" }).click();
      await page.waitForURL(`${web.origin}${overview()}`);
      await page.getByRole("navigation", { name: "Scope" }).waitFor();

      addresses.push(page.url());
      for (const address of [...addresses, ...session.requested]) {
        expect(address).not.toContain(password);
        expect(address).not.toContain(encodeURIComponent(email));
        expect(address).not.toContain(code);
      }
      expect(await kept(session)).not.toContain(password);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("a password-only session cannot render any workspace route", async () => {
    const { email, password } = web.tenants.credentials("readerA");
    const signedIn = await web.api.request("POST", "/v1/auth/sign-in/email", {
      body: { email, password },
    });
    expect(signedIn.status).toBe(200);
    const session = await web.withCookie(sessionCookieOf(signedIn));
    const { a } = web.tenants;
    const params = { org: a.organizationId, project: a.project1, env: a.env1a, name: "API_KEY" };
    try {
      // The paths of signing in are not workspace routes.
      const workspace = WEB_ROUTES.filter((route) => !["reset", "enroll"].includes(route.id));
      for (const route of workspace) {
        await session.page.goto(`${web.origin}${webPath(route.id, params)}`);
        await heading(session.page, "Enter your code").waitFor();
        expect(
          await session.page.getByRole("navigation", { name: "Scope" }).count(),
          route.id,
        ).toBe(0);
        expect(await session.page.getByText("Project One").count(), route.id).toBe(0);
      }
      // The page asked for nothing of the workspace …
      const asked = session.requested.map((url) => new URL(url).pathname);
      expect(asked.filter((path) => path.startsWith("/v1/organizations"))).toEqual([]);
      // … and the server would have refused it: the same cookie, from the page itself.
      const refused = await session.page.evaluate(async () => {
        const response = await fetch("/v1/organizations", { credentials: "same-origin" });
        const body = (await response.json()) as { error?: { code?: string } };
        return { status: response.status, code: body.error?.code };
      });
      expect(refused).toEqual({ status: 401, code: "mfa_incomplete" });
    } finally {
      await session.close();
    }
  });

  it("a wrong password and an unknown address show the same text", async () => {
    const session = await web.anonymous();
    const { page } = session;
    const { email } = web.tenants.credentials("editorA");
    const alert = page.getByRole("alert");
    try {
      await page.goto(`${web.origin}/sign-in`);
      await signInWithPassword(page, email, "not-the-password-0000");
      await alert.waitFor();
      const wrongPassword = await alert.textContent();
      expect(await page.getByLabel("Password", { exact: true }).inputValue()).toBe("");

      await page.reload();
      await signInWithPassword(page, "nobody-here@mykey.invalid", "not-the-password-0000");
      await alert.waitFor();
      const unknownAddress = await alert.textContent();

      expect(wrongPassword).toBe(unknownAddress);
      expect(wrongPassword).toContain("not accepted");
      // Session 6: after a restore every account needs an operator's reset.
      expect(wrongPassword).toContain("restore");
      expect(await heading(page, "Sign in").count()).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('enrolment shows the key and the recovery codes once: after "I saved them", back and forward do not show them again, and they are in no storage', async () => {
    const account = await web.pendingUser();
    const session = await web.anonymous();
    const { page } = session;
    try {
      await page.goto(`${web.origin}/`);
      await signInWithPassword(page, account.email, account.password);
      await heading(page, "Enter your code").waitFor();
      await page.getByRole("button", { name: "Set up an authenticator" }).click();
      await heading(page, "Set up your authenticator").waitFor();
      await page.getByRole("button", { name: "Create a setup key" }).click();
      const shown = (await page.getByLabel("Setup key").textContent()) ?? "";
      const key = shown.replaceAll(/\s/g, "");
      expect(key).toMatch(/^[A-Z2-7]{16,}$/);
      expect(await page.getByLabel("Address for an authenticator app").textContent()).toContain(
        "otpauth://totp/",
      );

      const seed = new Uint8Array(OTPAuth.Secret.fromBase32(key).bytes);
      await page.getByLabel("Code from your authenticator app").fill(await codeOf(seed, false));
      await page.getByRole("button", { name: "Activate" }).click();
      const list = page.getByRole("list", { name: "Recovery codes" });
      await list.waitFor();
      const codes = (await list.getByRole("listitem").allTextContents()).map((code) => code.trim());
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      // The key is gone as soon as it has done its work.
      expect(await page.getByLabel("Setup key").count()).toBe(0);

      await page.getByRole("button", { name: "I saved them" }).click();
      await page.getByRole("navigation", { name: "Scope" }).waitFor();
      const secrets = [key, shown.trim(), ...codes];
      const nowhere = async (): Promise<void> => {
        const text = `${(await page.locator("body").textContent()) ?? ""}\n${await kept(session)}`;
        for (const secret of secrets) expect(text).not.toContain(secret);
      };
      await nowhere();
      await page.goBack();
      await page.waitForTimeout(500);
      await nowhere();
      expect(await page.getByRole("list", { name: "Recovery codes" }).count()).toBe(0);
      await page.goForward();
      await page.waitForTimeout(500);
      await nowhere();
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("a reset link's fragment is gone from the address bar and the history before the form is shown; completing it leads to enrolment", async () => {
    const { email } = web.tenants.credentials("ungrantedA");
    const pool = web.api.database.pool("maintenance");
    const issued = await initiateReset(
      {
        pool,
        keys: web.api.keys,
        throttle: createThrottle({ pool, ring: web.api.keys.rateLimit }),
      },
      { email, kind: "mfa" },
    );
    if (issued.outcome !== "issued") throw new Error(`reset ${issued.outcome}`);
    const session = await web.anonymous();
    const { page } = session;
    const addresses: string[] = [];
    page.on("framenavigated", (frame) => addresses.push(frame.url()));
    try {
      await page.goto(`${web.origin}/reset#t=${issued.token}&k=mfa`);
      await heading(page, "Reset your account").waitFor();
      await page.getByLabel("New password", { exact: true }).waitFor();
      expect(page.url()).toBe(`${web.origin}/reset`);
      expect(await kept(session)).not.toContain(issued.token);

      const password = "a new synthetic password 7.2";
      await page.getByLabel("New password", { exact: true }).fill(password);
      await page.getByLabel("New password again").fill(password);
      await page.getByRole("button", { name: "Set the new password" }).click();
      await heading(page, "Set up your authenticator").waitFor();
      expect(page.url()).toBe(`${web.origin}/enroll`);
      // The reset's own session can enrol, and nothing else.
      await page.getByRole("button", { name: "Create a setup key" }).click();
      await page.getByLabel("Setup key").waitFor();

      // Back: the entry of the link holds no fragment, and the token was never sent in an address.
      await page.goBack();
      await page.waitForURL(`${web.origin}/reset`);
      expect(await kept(session)).not.toContain(issued.token);
      for (const address of session.requested) expect(address).not.toContain(issued.token);
      expect(addresses.filter((address) => address.includes("#")).length).toBeLessThanOrEqual(1);
      expect(await session.violations()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("the session list shows this session as current; revoking another session removes it; revoking the current one signs out", async () => {
    const credentials = web.tenants.credentials("envEditorA");
    const mine = await signInComplete(web.api, credentials);
    await signInComplete(web.api, credentials);
    const session = await web.withCookie(mine.cookie);
    const { page } = session;
    try {
      await page.goto(`${web.origin}/account`);
      await heading(page, "Account").waitFor();
      const rows = page.getByRole("table", { name: "Sessions" }).locator("tbody tr");
      await rows.first().waitFor();
      // The fixture's own session, the page's and the second sign-in.
      expect(await rows.count()).toBe(3);
      const current = rows.filter({ hasText: "this session" });
      expect(await current.count()).toBe(1);

      const others = rows.filter({ hasNotText: "this session" });
      await others.first().getByRole("button", { name: "End session" }).click();
      await expect.poll(() => rows.count()).toBe(2);
      expect(await current.count()).toBe(1);

      await current.getByRole("button", { name: "End session" }).click();
      await heading(page, "Sign in").waitFor();
      expect(await page.getByRole("table", { name: "Sessions" }).count()).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("a password change asks for a fresh code, then succeeds, and says how many other sessions ended", async () => {
    const credentials = web.tenants.credentials("adminA");
    const mine = await signInComplete(web.api, credentials);
    await signInComplete(web.api, credentials);
    // The page's session verified its code more than ten minutes ago.
    const stale = await web.api.superuser.query(
      "UPDATE auth.session SET totp_verified_at = now() - interval '20 minutes' WHERE id = $1",
      [mine.sessionId],
    );
    expect(stale.rowCount).toBe(1);
    const session = await web.withCookie(mine.cookie);
    const { page } = session;
    const changes: number[] = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/v1/auth/change-password") {
        changes.push(response.status());
      }
    });
    try {
      await page.goto(`${web.origin}/account`);
      await heading(page, "Account").waitFor();
      const newPassword = "another synthetic password 7.2";
      await page.getByLabel("Current password").fill(credentials.password);
      await page.getByLabel("New password", { exact: true }).fill(newPassword);
      await page.getByRole("button", { name: "Change password" }).click();

      const dialog = page.getByRole("dialog", { name: "Confirm with your authenticator" });
      await dialog.waitFor();
      await dialog.getByLabel("Code from your authenticator app").fill(await codeFor("adminA"));
      await dialog.getByRole("button", { name: "Confirm" }).click();
      await dialog.waitFor({ state: "hidden" });
      // The page does not send the change by itself: the owner's click does, once.
      await page.getByText("Confirmed. Send the change again.").waitFor();
      expect(changes).toEqual([403]);

      await page.getByRole("button", { name: "Change password" }).click();
      await page.getByText("The password is changed.").waitFor();
      // The fixture's session and the second sign-in.
      expect(await page.getByRole("status").allTextContents()).toContain(
        "The password is changed. 2 other sessions ended.",
      );
      expect(changes).toEqual([403, 200]);
      expect(await page.getByLabel("Current password").inputValue()).toBe("");
      expect(await page.getByLabel("New password", { exact: true }).inputValue()).toBe("");
      expect(await kept(session)).not.toContain(newPassword);
    } finally {
      await session.close();
    }
  });

  it("sign-out clears the page: the back button shows the sign-in screen, not the overview", async () => {
    const mine = await signInComplete(web.api, web.tenants.credentials("readerA"));
    const session = await web.withCookie(mine.cookie);
    const { page } = session;
    try {
      await page.goto(`${web.origin}/`);
      await page.waitForURL(`${web.origin}${overview()}`);
      await page
        .getByRole("navigation", { name: "Scope" })
        .getByLabel("Project", { exact: true })
        .locator("option", { hasText: "Project One" })
        .waitFor({ state: "attached" });
      await page.getByRole("link", { name: "Account" }).click();
      await heading(page, "Account").waitFor();

      await page.getByRole("button", { name: "Sign out" }).click();
      await heading(page, "Sign in").waitFor();
      await page.goBack();
      await page.waitForTimeout(500);
      await heading(page, "Sign in").waitFor();
      expect(await page.getByRole("navigation", { name: "Scope" }).count()).toBe(0);
      expect(await page.getByText("Project One").count()).toBe(0);
      // The cookie is gone with the session.
      expect((await session.context.cookies()).filter((cookie) => cookie.value !== "")).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
