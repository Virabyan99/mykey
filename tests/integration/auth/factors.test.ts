// Run 2.3 Task D: the product-owned second factor (P-24, D-19).
import { errorEnvelopeSchema } from "@mykey/contracts";
import {
  codeAt,
  elevateWithRecoveryCode,
  elevateWithTotp,
  regenerateRecoveryCodes,
  requireMfaComplete,
  sessionVerifier,
  stepAt,
} from "@mykey/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../database/setup.ts";
import {
  authFixture,
  cookieOf,
  enrolledUser,
  factorDeps,
  tokenOf,
  type AuthFixture,
  type EnrolledUser,
} from "./fixture.ts";

let fixture: AuthFixture;
let owner: EnrolledUser;

beforeAll(async () => {
  fixture = await authFixture();
  owner = await enrolledUser(fixture);
});

afterAll(async () => {
  await fixture.close();
});

/** A new session that has passed the password only. */
const passwordSession = async (): Promise<{ cookie: string; token: string }> => {
  const cookie = await fixture.signIn(owner);
  return { cookie, token: tokenOf(cookie) };
};

const resolves = async (cookie: string): Promise<boolean> => {
  const response = await fixture.request("GET", "/v1/auth/get-session", { cookie });
  return (await response.json()) !== null;
};

const pairOf = (setCookie: string): string => setCookie.split(";")[0] ?? "";

describe("elevation with TOTP", () => {
  it("is required by a product route, and rotates the bearer when it succeeds", async () => {
    const { cookie, token } = await passwordSession();
    const headers = new Headers({ cookie });
    const refused = await requireMfaComplete(fixture.auth, headers, fixture.pool);
    expect(refused?.status).toBe(401);
    expect(errorEnvelopeSchema.parse(await refused?.json()).error.code).toBe("mfa_incomplete");

    const before = await run<{ authenticated_at: Date }>(
      fixture.pool,
      "SELECT authenticated_at FROM auth.session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [owner.id],
    );
    const now = new Date(Date.now() + 90_000);
    const result = await elevateWithTotp(factorDeps(fixture), {
      sessionToken: token,
      code: codeAt(owner.seed, stepAt(now)),
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const elevated = pairOf(result.setCookie);
    expect(result.setCookie).toMatch(/HttpOnly/);
    expect(result.setCookie).toMatch(/Secure/);
    expect(await resolves(cookie)).toBe(false);
    expect(await resolves(elevated)).toBe(true);
    expect(
      await requireMfaComplete(fixture.auth, new Headers({ cookie: elevated }), fixture.pool),
    ).toBeNull();
    const after = await run<{
      authenticated_at: Date;
      totp_verified_at: Date | null;
      phase: string;
    }>(
      fixture.pool,
      "SELECT authenticated_at, totp_verified_at, phase FROM auth.session WHERE token = $1",
      [sessionVerifier(fixture.keys.sessionLookup, tokenOf(elevated))],
    );
    expect(after[0]?.phase).toBe("mfa_complete");
    expect(after[0]?.authenticated_at).toEqual(before[0]?.authenticated_at);
    expect(after[0]?.totp_verified_at).toEqual(now);
  });

  // Run 2.10 review finding I4 (Doc 10 §4.1 rule 5: checked on every request, from current
  // database state): the guard reads the account, not only the session's phase.
  it("the product-route guard ends an elevated session of a disabled account or an older epoch", async () => {
    const { token } = await passwordSession();
    const now = new Date(Date.now() + 180_000);
    const result = await elevateWithTotp(factorDeps(fixture), {
      sessionToken: token,
      code: codeAt(owner.seed, stepAt(now)),
      now,
    });
    if (!result.ok) throw new Error(`elevation: ${result.reason}`);
    const headers = new Headers({ cookie: pairOf(result.setCookie) });
    // Control: elevated and active.
    expect(await requireMfaComplete(fixture.auth, headers, fixture.pool)).toBeNull();
    const [original] = await run<{ auth_epoch: string }>(
      fixture.pool,
      "SELECT auth_epoch FROM auth.account_state WHERE user_id = $1",
      [owner.id],
    );
    try {
      await run(
        fixture.pool,
        "UPDATE auth.account_state SET state = 'disabled' WHERE user_id = $1",
        [owner.id],
      );
      const disabled = await requireMfaComplete(fixture.auth, headers, fixture.pool);
      expect(disabled?.status).toBe(401);
      await run(fixture.pool, "UPDATE auth.account_state SET state = 'active' WHERE user_id = $1", [
        owner.id,
      ]);
      expect(await requireMfaComplete(fixture.auth, headers, fixture.pool)).toBeNull();
      await run(
        fixture.pool,
        "UPDATE auth.account_state SET auth_epoch = auth_epoch + 1 WHERE user_id = $1",
        [owner.id],
      );
      const older = await requireMfaComplete(fixture.auth, headers, fixture.pool);
      expect(older?.status).toBe(401);
    } finally {
      await run(
        fixture.pool,
        "UPDATE auth.account_state SET state = 'active', auth_epoch = $2 WHERE user_id = $1",
        [owner.id, original?.auth_epoch ?? "0"],
      );
    }
  });

  it("accepts the steps next to now and refuses those two away", async () => {
    const now = new Date(Date.now() + 240_000);
    const outcome = async (delta: number): Promise<boolean | string> => {
      const { token } = await passwordSession();
      const result = await elevateWithTotp(factorDeps(fixture), {
        sessionToken: token,
        code: codeAt(owner.seed, stepAt(now) + delta),
        now,
      });
      return result.ok || result.reason;
    };
    expect(await outcome(-1)).toBe(true);
    expect(await outcome(1)).toBe(true);
    expect(await outcome(-2)).toBe("invalid");
    expect(await outcome(2)).toBe("invalid");
  });

  it("refuses the same code a second time, also after a restart and with the clock set back", async () => {
    const now = new Date(Date.now() - 120_000);
    const code = codeAt(owner.seed, stepAt(now));
    const first = await passwordSession();
    expect(
      (await elevateWithTotp(factorDeps(fixture), { sessionToken: first.token, code, now })).ok,
    ).toBe(true);
    const second = await passwordSession();
    expect(
      await elevateWithTotp(factorDeps(fixture), { sessionToken: second.token, code, now }),
    ).toEqual({ ok: false, reason: "replayed" });

    // A new process: new connections and a new Better Auth instance over the same database.
    fixture.rebuild({ keys: fixture.keys });
    const third = await passwordSession();
    const setBack = new Date(now.getTime() - 30_000);
    expect(
      await elevateWithTotp(factorDeps(fixture), { sessionToken: third.token, code, now: setBack }),
    ).toEqual({ ok: false, reason: "replayed" });
    // The session that was refused is still waiting for its factor.
    expect(await resolves(third.cookie)).toBe(true);
  });

  it("refuses a client asking to trust its device", async () => {
    const { cookie } = await passwordSession();
    const response = await fixture.request("POST", "/v1/auth/totp/verify", {
      cookie,
      body: { code: codeAt(owner.seed, stepAt(new Date())), trustDevice: true },
    });
    expect(response.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe("malformed_request");
    expect(response.headers.getSetCookie().filter((value) => value.includes("trust"))).toEqual([]);
  });

  it("elevates over HTTP with a valid code (control)", async () => {
    const { cookie } = await passwordSession();
    const now = new Date();
    // A step this suite has not used yet: the activation used stepAt(now) at setup.
    const response = await fixture.request("POST", "/v1/auth/totp/verify", {
      cookie,
      body: { code: codeAt(owner.seed, stepAt(now) + 1) },
    });
    expect(response.status).toBe(200);
    const elevated = cookieOf(response);
    expect(elevated).toBeDefined();
    expect(await resolves(elevated ?? "")).toBe(true);
    expect(await resolves(cookie)).toBe(false);
  });
});

describe("recovery codes", () => {
  it("elevate once without setting totp_verified_at, and are invalid the second time", async () => {
    const code = owner.recoveryCodes[0] ?? "";
    const first = await passwordSession();
    const result = await elevateWithRecoveryCode(factorDeps(fixture), {
      sessionToken: first.token,
      code,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const elevated = tokenOf(pairOf(result.setCookie));
    const rows = await run<{ phase: string; totp_verified_at: Date | null }>(
      fixture.pool,
      "SELECT phase, totp_verified_at FROM auth.session WHERE token = $1",
      [sessionVerifier(fixture.keys.sessionLookup, elevated)],
    );
    expect(rows[0]).toEqual({ phase: "mfa_complete", totp_verified_at: null });

    const second = await passwordSession();
    expect(
      await elevateWithRecoveryCode(factorDeps(fixture), { sessionToken: second.token, code }),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("are all replaced by a regeneration before the new ones are returned", async () => {
    const old = owner.recoveryCodes.slice(1);
    const regenerated = await regenerateRecoveryCodes(factorDeps(fixture), {
      sessionToken: tokenOf(owner.elevatedCookie),
    });
    expect(regenerated.ok).toBe(true);
    if (!regenerated.ok) return;
    expect(regenerated.recoveryCodes).toHaveLength(10);
    const unused = await run<{ count: string }>(
      fixture.pool,
      `SELECT count(*) FROM auth.recovery_code r JOIN auth.totp_enrollment e ON e.id = r.enrollment_id
        WHERE e.user_id = $1 AND r.consumed_at IS NULL`,
      [owner.id],
    );
    expect(unused[0]?.count).toBe("10");
    for (const code of old.slice(0, 3)) {
      const session = await passwordSession();
      expect(
        await elevateWithRecoveryCode(factorDeps(fixture), { sessionToken: session.token, code }),
        code,
      ).toEqual({ ok: false, reason: "invalid" });
    }
    // Control: a new code works.
    const session = await passwordSession();
    expect(
      (
        await elevateWithRecoveryCode(factorDeps(fixture), {
          sessionToken: session.token,
          code: regenerated.recoveryCodes[0] ?? "",
        })
      ).ok,
    ).toBe(true);
  });
});
