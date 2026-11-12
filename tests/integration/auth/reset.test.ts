// Run 3.6 Task B (FR-1.04, AC-1.03, P-51): completing an operator reset.
// `password` kind: token + new password + a factor code → the account is
// active again and signs in afresh. `mfa` kind: token + new password → a
// challenge session that can only enroll; activation makes the account active.
// Every failure is the same 401; the token reaches no log.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { codeAt, createThrottle, stepAt } from "@mykey/auth";
import { initiateReset, type ResetKind } from "@mykey/auth/operator";
import * as OTPAuth from "otpauth";
import { postgresLog } from "../../harness/stack.ts";
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
const since = new Date(Date.now() - 5_000).toISOString();
const tokensUsed: string[] = [];
let sources = 0;
const from = (): Record<string, string> => {
  sources += 1;
  return { "x-forwarded-for": `198.51.100.${String(sources % 250)}` };
};
let steps = 0;
/** A step of its own for every code this suite sends, far from the present. */
const future = (): Date => {
  steps += 1;
  return new Date(Date.now() + (500 + steps) * 120_000);
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

async function issue(kind: ResetKind): Promise<string> {
  const pool = api.database.pool("maintenance");
  const result = await initiateReset(
    { pool, keys: api.keys, throttle: createThrottle({ pool, ring: api.keys.rateLimit }) },
    { email: owner.email, kind },
  );
  if (result.outcome !== "issued") throw new Error(`reset ${result.outcome}`);
  tokensUsed.push(result.token);
  return result.token;
}

function complete(body: Record<string, unknown>, now?: Date): Promise<Response> {
  return api.request("POST", "/v1/auth/reset/complete", {
    body,
    headers: { ...from(), ...(now === undefined ? {} : { "x-test-now": now.toISOString() }) },
  });
}

const signIn = (password: string) =>
  api.request("POST", "/v1/auth/sign-in/email", {
    body: { email: owner.email, password },
    headers: from(),
  });

async function state(): Promise<string> {
  const result = await api.superuser.query<{ state: string }>(
    "SELECT state FROM auth.account_state WHERE user_id = $1",
    [owner.userId],
  );
  return result.rows[0]!.state;
}

async function refusal(response: Response): Promise<unknown> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  return {
    status: response.status,
    cookies: response.headers.getSetCookie().length,
    error: { ...body.error, requestId: "" },
  };
}

const newPassword = (): string => `reset-${randomBytes(12).toString("base64url")}`;

async function ageToken(token: string, seconds: number): Promise<void> {
  // expires_at moves back: the link is `seconds` old (it lives 900 s).
  await api.superuser.query(
    `UPDATE auth.reset_token SET created_at = created_at - make_interval(secs => $1),
                                 expires_at = expires_at - make_interval(secs => $1)
      WHERE consumed_at IS NULL AND superseded_at IS NULL`,
    [seconds],
  );
  expect(token.length).toBe(43);
}

describe("password kind", () => {
  it("token + new password + TOTP code: next sign_in, no cookie; the new password signs in, the old does not; the factor is unchanged", async () => {
    const enrollmentBefore = await api.superuser.query(
      "SELECT id FROM auth.totp_enrollment WHERE user_id = $1 AND state = 'active'",
      [owner.userId],
    );
    const token = await issue("password");
    const fresh = newPassword();
    const now = future();
    const response = await complete(
      { token, newPassword: fresh, code: codeAt(owner.seed, stepAt(now)) },
      now,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "sign_in" });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await state()).toBe("active");
    expect((await signIn(owner.password)).status).toBe(401);
    owner = { ...owner, password: fresh };
    const session = await signInComplete(api, owner, { source: "198.51.100.252" });
    expect(session.cookie.length).toBeGreaterThan(40);
    const enrollmentAfter = await api.superuser.query(
      "SELECT id FROM auth.totp_enrollment WHERE user_id = $1 AND state = 'active'",
      [owner.userId],
    );
    expect(enrollmentAfter.rows).toEqual(enrollmentBefore.rows);
  });

  it("the same with a recovery code, which is then consumed", async () => {
    const token = await issue("password");
    const fresh = newPassword();
    const code = owner.recoveryCodes.shift()!;
    const response = await complete({ token, newPassword: fresh, code });
    expect(response.status).toBe(200);
    owner = { ...owner, password: fresh };
    // The code is spent: a password-only session cannot use it again.
    const signedIn = await signIn(fresh);
    const reused = await api.request("POST", "/v1/auth/recovery/verify", {
      body: { code },
      cookie: sessionCookieOf(signedIn),
      headers: from(),
    });
    expect(reused.status).toBe(401);
  });

  it("no code, a wrong code and a replayed step answer alike; the token still redeems afterwards", async () => {
    const used = future();
    // A step spent by an elevation, then replayed below.
    await signInComplete(api, owner, { source: "198.51.100.253" });
    const replayNow = future();
    const signedIn = await signIn(owner.password);
    const spend = await api.request("POST", "/v1/auth/totp/verify", {
      body: { code: codeAt(owner.seed, stepAt(replayNow)) },
      cookie: sessionCookieOf(signedIn),
      headers: { ...from(), "x-test-now": replayNow.toISOString() },
    });
    expect(spend.status).toBe(200);
    const token = await issue("password");
    const fresh = newPassword();
    const answers = [
      await refusal(await complete({ token, newPassword: fresh })),
      await refusal(
        await complete(
          { token, newPassword: fresh, code: codeAt(owner.seed, stepAt(used) + 7) },
          used,
        ),
      ),
      await refusal(
        await complete(
          { token, newPassword: fresh, code: codeAt(owner.seed, stepAt(replayNow)) },
          replayNow,
        ),
      ),
    ];
    expect(answers[0]).toMatchObject({
      status: 401,
      cookies: 0,
      error: { code: "unauthenticated" },
    });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    const now = future();
    const ok = await complete(
      { token, newPassword: fresh, code: codeAt(owner.seed, stepAt(now)) },
      now,
    );
    expect(ok.status).toBe(200);
    owner = { ...owner, password: fresh };
  });

  it("five wrong codes lock the factor phase: the right code is then 429", async () => {
    const token = await issue("password");
    const fresh = newPassword();
    for (let i = 0; i < 5; i += 1) {
      const now = future();
      const wrong = await complete(
        { token, newPassword: fresh, code: codeAt(owner.seed, stepAt(now) + 9) },
        now,
      );
      expect(wrong.status).toBe(401);
    }
    const now = future();
    const right = await complete(
      { token, newPassword: fresh, code: codeAt(owner.seed, stepAt(now)) },
      now,
    );
    expect(right.status).toBe(429);
    // Leave the account usable for the next cases.
    await api.superuser.query("DELETE FROM app.rate_limit");
    const again = await complete(
      { token, newPassword: fresh, code: codeAt(owner.seed, stepAt(now)) },
      now,
    );
    expect(again.status).toBe(200);
    owner = { ...owner, password: fresh };
  });
});

describe("mfa kind", () => {
  it("enroll anew: the old factor is dead, the challenge can only enroll, the new password waits for activation", async () => {
    const oldSeed = owner.seed;
    const oldCodes = [...owner.recoveryCodes];
    const token = await issue("mfa");
    const fresh = newPassword();
    const response = await complete({ token, newPassword: fresh });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: "enroll" });
    const challenge = sessionCookieOf(response);
    expect(await state()).toBe("recovery_pending");
    // The old seed is gone from the table; the old codes are consumed.
    const retired = await api.superuser.query<{ seed: string; state: string }>(
      "SELECT seed_jwe AS seed, state FROM auth.totp_enrollment WHERE user_id = $1",
      [owner.userId],
    );
    expect(retired.rows.every((row) => row.state === "retired" && row.seed === "")).toBe(true);
    const open = await api.superuser.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth.recovery_code r JOIN auth.totp_enrollment e ON e.id = r.enrollment_id
        WHERE e.user_id = $1 AND r.consumed_at IS NULL`,
      [owner.userId],
    );
    expect(open.rows[0]?.n).toBe(0);
    // The new password does not sign in before activation; neither does the old.
    expect((await signIn(fresh)).status).toBe(401);
    expect((await signIn(owner.password)).status).toBe(401);
    // The challenge reaches no other auth route and no product route.
    for (const [method, path, body] of [
      ["POST", "/v1/auth/totp/verify", { code: "123456" }],
      ["POST", "/v1/auth/recovery/verify", { code: oldCodes[0] }],
      ["POST", "/v1/auth/totp/step-up", { code: "123456" }],
      ["POST", "/v1/auth/recovery/regenerate", {}],
      ["GET", "/v1/auth/sessions", undefined],
      ["GET", "/v1/auth/get-session", undefined],
      ["POST", "/v1/auth/change-password", { currentPassword: fresh, newPassword: newPassword() }],
      ["POST", "/v1/auth/revoke-sessions", {}],
      ["GET", "/v1/organizations", undefined],
      ["POST", "/v1/session/activity", undefined],
    ] as const) {
      const answer = await api.request(method, path, {
        ...(body === undefined ? {} : { body }),
        cookie: challenge,
        headers: from(),
      });
      expect(answer.status, `${method} ${path}`).toBe(401);
    }
    // Enroll and activate with the challenge.
    const enrolled = await api.request("POST", "/v1/auth/totp/enroll", {
      body: {},
      cookie: challenge,
      headers: from(),
    });
    expect(enrolled.status).toBe(200);
    const seed = OTPAuth.Secret.fromBase32(
      ((await enrolled.json()) as { secret: string }).secret,
    ).bytes;
    expect(Buffer.from(seed).equals(Buffer.from(oldSeed))).toBe(false);
    const now = future();
    const activated = await api.request("POST", "/v1/auth/totp/activate", {
      body: { code: codeAt(seed, stepAt(now)) },
      cookie: challenge,
      headers: { ...from(), "x-test-now": now.toISOString() },
    });
    expect(activated.status).toBe(200);
    const { recoveryCodes } = (await activated.json()) as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    expect(activated.headers.getSetCookie()).toEqual([]);
    expect(await state()).toBe("active");
    // The challenge has ended; the user signs in afresh with the new password and the new factor.
    expect(
      (
        await api.request("POST", "/v1/auth/totp/enroll", {
          body: {},
          cookie: challenge,
          headers: from(),
        })
      ).status,
    ).toBe(401);
    owner = { ...owner, password: fresh, seed, recoveryCodes };
    await signInComplete(api, owner, { source: "198.51.100.254" });
  });
});

describe("expiry and failures", () => {
  it("an expired link leaves the account blocked; at 895 s it still redeems", async () => {
    const token = await issue("password");
    const fresh = newPassword();
    await ageToken(token, 901);
    const now = future();
    const expired = await complete(
      { token, newPassword: fresh, code: codeAt(owner.seed, stepAt(now)) },
      now,
    );
    expect(expired.status).toBe(401);
    expect(await state()).toBe("recovery_pending");
    expect((await signIn(owner.password)).status).toBe(401);
    // A re-issued link, 895 s old, redeems.
    const second = await issue("password");
    await ageToken(second, 895);
    const later = future();
    const ok = await complete(
      { token: second, newPassword: fresh, code: codeAt(owner.seed, stepAt(later)) },
      later,
    );
    expect(ok.status).toBe(200);
    owner = { ...owner, password: fresh };
  });

  it("the challenge ends with the link: enroll is 401 after the token's expiry; a re-issued link works", async () => {
    const token = await issue("mfa");
    await ageToken(token, 840);
    const fresh = newPassword();
    const response = await complete({ token, newPassword: fresh });
    expect(response.status).toBe(200);
    const challenge = sessionCookieOf(response);
    // Past the token's expiry (the challenge's own ten minutes are not over).
    await api.superuser.query(
      "UPDATE auth.reset_token SET expires_at = now() - interval '1 second' WHERE user_id = $1 AND consumed_at IS NOT NULL",
      [owner.userId],
    );
    const enroll = await api.request("POST", "/v1/auth/totp/enroll", {
      body: {},
      cookie: challenge,
      headers: from(),
    });
    expect(enroll.status).toBe(401);
    expect(await state()).toBe("recovery_pending");
    // A re-issued mfa link works end to end.
    const again = await complete({ token: await issue("mfa"), newPassword: fresh });
    expect(again.status).toBe(200);
    const next = sessionCookieOf(again);
    const enrolled = await api.request("POST", "/v1/auth/totp/enroll", {
      body: {},
      cookie: next,
      headers: from(),
    });
    expect(enrolled.status).toBe(200);
    const seed = OTPAuth.Secret.fromBase32(
      ((await enrolled.json()) as { secret: string }).secret,
    ).bytes;
    const now = future();
    const activated = await api.request("POST", "/v1/auth/totp/activate", {
      body: { code: codeAt(seed, stepAt(now)) },
      cookie: next,
      headers: { ...from(), "x-test-now": now.toISOString() },
    });
    expect(activated.status).toBe(200);
    const { recoveryCodes } = (await activated.json()) as { recoveryCodes: string[] };
    owner = { ...owner, password: fresh, seed, recoveryCodes };
  });

  it("every failure looks alike: unknown, expired, superseded, consumed, wrong code, an active account's token", async () => {
    const fresh = newPassword();
    const now = future();
    const right = codeAt(owner.seed, stepAt(now));
    const answers: unknown[] = [];
    // unknown
    answers.push(
      await refusal(
        await complete(
          { token: randomBytes(32).toString("base64url"), newPassword: fresh, code: right },
          now,
        ),
      ),
    );
    // superseded
    const superseded = await issue("password");
    const current = await issue("password");
    answers.push(
      await refusal(await complete({ token: superseded, newPassword: fresh, code: right }, now)),
    );
    // wrong code
    answers.push(
      await refusal(await complete({ token: current, newPassword: fresh, code: "000000" }, now)),
    );
    // expired
    await ageToken(current, 901);
    answers.push(
      await refusal(await complete({ token: current, newPassword: fresh, code: right }, now)),
    );
    // consumed
    const consumed = await issue("password");
    const later = future();
    expect(
      (
        await complete(
          { token: consumed, newPassword: fresh, code: codeAt(owner.seed, stepAt(later)) },
          later,
        )
      ).status,
    ).toBe(200);
    owner = { ...owner, password: fresh };
    const third = future();
    answers.push(
      await refusal(
        await complete(
          { token: consumed, newPassword: newPassword(), code: codeAt(owner.seed, stepAt(third)) },
          third,
        ),
      ),
    );
    // a token of an active account (issued, then the account set active by the superuser)
    const stray = await issue("password");
    await api.superuser.query("UPDATE auth.account_state SET state = 'active' WHERE user_id = $1", [
      owner.userId,
    ]);
    const fourth = future();
    answers.push(
      await refusal(
        await complete(
          { token: stray, newPassword: newPassword(), code: codeAt(owner.seed, stepAt(fourth)) },
          fourth,
        ),
      ),
    );
    expect(answers[0]).toMatchObject({
      status: 401,
      cookies: 0,
      error: { code: "unauthenticated" },
    });
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    // The consumed token's verifier is NULL.
    const verifiers = await api.superuser.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth.reset_token WHERE consumed_at IS NOT NULL AND verifier IS NOT NULL",
    );
    expect(verifiers.rows[0]?.n).toBe(0);
  });

  it("completion cannot create an account or start a reset", async () => {
    const counts = async () =>
      (
        await api.superuser.query<{ users: number; tokens: number }>(
          `SELECT (SELECT count(*)::int FROM auth."user") AS users, (SELECT count(*)::int FROM auth.reset_token) AS tokens`,
        )
      ).rows[0];
    const before = await counts();
    const response = await complete({
      token: randomBytes(32).toString("base64url"),
      newPassword: newPassword(),
      code: "123456",
    });
    expect(response.status).toBe(401);
    expect(await counts()).toEqual(before);
  });

  it("no token is in any log: the API's, PostgreSQL's or the audit table", async () => {
    expect(tokensUsed.length).toBeGreaterThan(5);
    const apiLog = JSON.stringify(api.logs);
    const pgLog = await postgresLog(api.database.stack, since);
    const audit = await api.superuser.query<{ text: string }>(
      "SELECT row_to_json(e)::text AS text FROM audit.event e",
    );
    const auditText = audit.rows.map((row) => row.text).join("\n");
    for (const token of tokensUsed) {
      expect(apiLog.includes(token)).toBe(false);
      expect(pgLog.includes(token)).toBe(false);
      expect(auditText.includes(token)).toBe(false);
    }
    expect(auditText.includes("auth.reset_complete")).toBe(true);
    expect(auditText.includes("auth.reset_failed")).toBe(true);
  });
});
