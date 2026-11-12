// Run 3.5 Task B (P-49, D-29): the product-owned password change. One
// transaction: fresh TOTP, the rule, the current password, the new hash,
// credential epoch + 1, every other session gone, the audit row; this session
// keeps its token and phase.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { changePassword, signInWithPassword } from "@mykey/auth";
import {
  enrollOwner,
  seedOwner,
  sessionCookieOf,
  signInComplete,
  startTestApi,
  type EnrolledOwner,
  type TestApi,
} from "../../harness/api.ts";

let api: TestApi;
let owner: EnrolledOwner;
let sources = 0;
const from = (): Record<string, string> => {
  sources += 1;
  return { "x-forwarded-for": `198.51.100.${String(sources % 250)}` };
};

beforeAll(async () => {
  api = await startTestApi({ stubs: true, config: { trustedProxy: "127.0.0.1" } });
  owner = await enrollOwner(api, await seedOwner(api), { source: "198.51.100.251" });
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  await api.superuser.query("DELETE FROM app.rate_limit");
});

const complete = () => signInComplete(api, owner, { source: "198.51.100.252" });
const product = (cookie: string) =>
  api.request("GET", "/v1/organizations", { cookie, headers: from() });
const change = (cookie: string, currentPassword: string, newPassword: string) =>
  api.request("POST", "/v1/auth/change-password", {
    body: { currentPassword, newPassword },
    cookie,
    headers: from(),
  });
const signIn = (password: string) =>
  api.request("POST", "/v1/auth/sign-in/email", {
    body: { email: owner.email, password },
    headers: from(),
  });

async function snapshot(): Promise<{ hash: string; epoch: number; sessions: number }> {
  const result = await api.superuser.query<{ hash: string; epoch: number; sessions: number }>(
    `SELECT a.password AS hash, s.credential_epoch::int AS epoch,
            (SELECT count(*)::int FROM auth.session WHERE user_id = $1) AS sessions
       FROM auth.account a JOIN auth.account_state s ON s.user_id = a.user_id
      WHERE a.user_id = $1`,
    [owner.userId],
  );
  return result.rows[0]!;
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("password change", () => {
  it("without fresh TOTP: 403 and nothing changes — for an aged verification and for a recovery-code session", async () => {
    const aged = await complete();
    const other = await complete();
    await api.superuser.query(
      "UPDATE auth.session SET totp_verified_at = now() - interval '601 seconds' WHERE id = $1",
      [aged.sessionId],
    );
    const before = await snapshot();
    const response = await change(aged.cookie, owner.password, "a-new-password-1");
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("fresh_verification_required");
    expect(await snapshot()).toEqual(before);
    expect((await product(other.cookie)).status).toBe(204);

    const signedIn = await signIn(owner.password);
    const byRecovery = await api.request("POST", "/v1/auth/recovery/verify", {
      body: { code: owner.recoveryCodes[0] },
      cookie: sessionCookieOf(signedIn),
      headers: from(),
    });
    expect(byRecovery.status).toBe(200);
    const recoveryResponse = await change(
      sessionCookieOf(byRecovery),
      owner.password,
      "a-new-password-2",
    );
    expect(recoveryResponse.status).toBe(403);
    const after = await snapshot();
    expect(after.hash).toBe(before.hash);
    expect(after.epoch).toBe(before.epoch);
  });

  it("a wrong current password: 401, counted, nothing changes", async () => {
    const session = await complete();
    const before = await snapshot();
    const response = await change(session.cookie, `${owner.password}x`, "a-new-password-3");
    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe("unauthenticated");
    const after = await snapshot();
    expect(after.hash).toBe(before.hash);
    expect(after.epoch).toBe(before.epoch);
    const counted = await api.superuser.query(
      "SELECT 1 FROM app.rate_limit WHERE scope = 'fail:password'",
    );
    expect(counted.rowCount).toBe(1);
  });

  it("a new password of 11 characters: 422 validation_failed", async () => {
    const session = await complete();
    const response = await change(session.cookie, owner.password, "x".repeat(11));
    expect(response.status).toBe(422);
    expect(await codeOf(response)).toBe("validation_failed");
  });

  it("success: the new password signs in, the old does not; epoch + 1; other sessions gone; this one stays", async () => {
    const mine = await complete();
    const other = await complete();
    const before = await snapshot();
    const fresh = `new-${randomBytes(12).toString("base64url")}`;
    const response = await change(mine.cookie, owner.password, fresh);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { revokedSessions: number };
    expect(body.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(response.headers.getSetCookie()).toEqual([]);
    const after = await snapshot();
    expect(after.hash).not.toBe(before.hash);
    expect(after.epoch).toBe(before.epoch + 1);
    expect(after.sessions).toBe(1);
    expect((await product(other.cookie)).status).toBe(401);
    expect((await product(mine.cookie)).status).toBe(204);
    expect((await signIn(owner.password)).status).toBe(401);
    expect((await signIn(fresh)).status).toBe(200);
    owner = { ...owner, password: fresh };
  });

  it("a sign-in that verified the old password before the change and commits after it is refused", async () => {
    const mine = await complete();
    const old = owner.password;
    const fresh = `new-${randomBytes(12).toString("base64url")}`;
    const result = await signInWithPassword(
      {
        auth: api.auth,
        pool: api.pool,
        keys: api.keys,
        afterVerify: async () => {
          const response = await change(mine.cookie, old, fresh);
          expect(response.status).toBe(200);
        },
      },
      { email: owner.email, password: old, headers: new Headers(), requestId: null },
    );
    expect(result).toMatchObject({ ok: false, reason: "epoch" });
    owner = { ...owner, password: fresh };
  });

  it("a failure injected before commit leaves the old password and every session", async () => {
    const mine = await complete();
    const other = await complete();
    const before = await snapshot();
    await expect(
      changePassword(
        {
          auth: api.auth,
          pool: api.pool,
          beforeCommit: () => Promise.reject(new Error("killed before commit")),
        },
        {
          sessionId: mine.sessionId,
          currentPassword: owner.password,
          newPassword: "another-new-password",
          requestId: null,
        },
      ),
    ).rejects.toThrow("killed before commit");
    expect(await snapshot()).toEqual(before);
    expect((await product(other.cookie)).status).toBe(204);
  });

  it("five wrong current passwords lock the password phase", async () => {
    const session = await complete();
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await change(session.cookie, `wrong-${String(i)}-password`, "a-new-password-9")).status,
      ).toBe(401);
    }
    const locked = await change(session.cookie, owner.password, "a-new-password-9");
    expect(locked.status).toBe(429);
    expect((await signIn(owner.password)).status).toBe(429);
  });
});
