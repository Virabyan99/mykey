// Run 3.5 (FR-1.05, FR-1.06, AC-1.04): one validity decision for a session,
// on database time — 12 hours absolute, 30 minutes idle — and an activity
// signal that only a real user action sends. Rows are aged through the
// superuser; every limit is tested on both sides.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

/** GET organizations.list: a human route whose stub answers 204 once every check passed. */
const product = (cookie: string) =>
  api.request("GET", "/v1/organizations", { cookie, headers: from() });
const getSession = async (cookie: string): Promise<unknown> =>
  (await api.request("GET", "/v1/auth/get-session", { cookie, headers: from() })).json();
const signal = (cookie: string) =>
  api.request("POST", "/v1/session/activity", { cookie, headers: from() });

async function age(sessionId: string, column: string, seconds: number): Promise<void> {
  // Column names are fixed literals of this file.
  await api.superuser.query(
    `UPDATE auth.session SET ${column} = now() - make_interval(secs => $2) WHERE id = $1`,
    [sessionId, seconds],
  );
}

async function exists(sessionId: string): Promise<boolean> {
  const result = await api.superuser.query("SELECT 1 FROM auth.session WHERE id = $1", [sessionId]);
  return result.rowCount === 1;
}

async function activityText(sessionId: string): Promise<string> {
  const result = await api.superuser.query<{ text: string }>(
    "SELECT last_user_activity_at::text AS text FROM auth.session WHERE id = $1",
    [sessionId],
  );
  return result.rows[0]?.text ?? "";
}

describe("one validity decision (Task A)", () => {
  it("absolute: at 12 h − 5 s a product route answers; at 12 h + 1 s it is 401 and the row is gone", async () => {
    const live = await complete();
    await age(live.sessionId, "authenticated_at", 43_200 - 5);
    expect((await product(live.cookie)).status).toBe(204);
    const dead = await complete();
    await age(dead.sessionId, "authenticated_at", 43_200 + 1);
    // Only the absolute limit can be the reason: activity is fresh.
    await age(dead.sessionId, "last_user_activity_at", 0);
    const response = await product(dead.cookie);
    expect(response.status).toBe(401);
    expect(await exists(dead.sessionId)).toBe(false);
    expect(await getSession(dead.cookie)).toBeNull();
  });

  it("idle: at 30 min − 5 s it answers; at 30 min + 1 s it is 401 and the row is gone", async () => {
    const live = await complete();
    await age(live.sessionId, "last_user_activity_at", 1_800 - 5);
    expect((await product(live.cookie)).status).toBe(204);
    const dead = await complete();
    await age(dead.sessionId, "last_user_activity_at", 1_800 + 1);
    expect((await product(dead.cookie)).status).toBe(401);
    expect(await exists(dead.sessionId)).toBe(false);
    expect(await getSession(dead.cookie)).toBeNull();
  });

  it("polling does not extend a session", async () => {
    const session = await complete();
    await age(session.sessionId, "last_user_activity_at", 600);
    const before = await activityText(session.sessionId);
    for (let i = 0; i < 20; i += 1) {
      expect((await product(session.cookie)).status).toBe(204);
      expect(await getSession(session.cookie)).not.toBeNull();
    }
    expect(await activityText(session.sessionId)).toBe(before);
    // It still dies on time.
    await age(session.sessionId, "last_user_activity_at", 1_800 + 1);
    expect((await product(session.cookie)).status).toBe(401);
  });

  it("the activity signal extends idle and never absolute", async () => {
    const session = await complete();
    await age(session.sessionId, "last_user_activity_at", 29 * 60);
    await age(session.sessionId, "authenticated_at", 11 * 3600 + 59 * 60);
    const answer = await signal(session.cookie);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { idleExpiresAt: string; absoluteExpiresAt: string };
    const idleLeft = Date.parse(body.idleExpiresAt) - Date.now();
    const absoluteLeft = Date.parse(body.absoluteExpiresAt) - Date.now();
    expect(idleLeft).toBeGreaterThan(29 * 60_000);
    expect(absoluteLeft).toBeLessThan(2 * 60_000);
    // Past twelve hours it dies although it just signalled.
    await age(session.sessionId, "authenticated_at", 43_200 + 1);
    expect((await product(session.cookie)).status).toBe(401);
  });

  it("an expired session cannot signal; a password-only session cannot signal", async () => {
    const dead = await complete();
    await age(dead.sessionId, "last_user_activity_at", 1_800 + 1);
    const expired = await signal(dead.cookie);
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe(
      "unauthenticated",
    );
    const signedIn = await api.request("POST", "/v1/auth/sign-in/email", {
      body: { email: owner.email, password: owner.password },
      headers: from(),
    });
    const passwordOnly = await signal(sessionCookieOf(signedIn));
    expect(passwordOnly.status).toBe(401);
    expect(((await passwordOnly.json()) as { error: { code: string } }).error.code).toBe(
      "mfa_incomplete",
    );
  });

  it("two signals inside a minute write once", async () => {
    const session = await complete();
    await age(session.sessionId, "last_user_activity_at", 120);
    expect((await signal(session.cookie)).status).toBe(200);
    const xmin = async () =>
      (
        await api.superuser.query<{ xmin: string }>(
          "SELECT xmin::text AS xmin FROM auth.session WHERE id = $1",
          [session.sessionId],
        )
      ).rows[0]?.xmin;
    const first = await xmin();
    expect((await signal(session.cookie)).status).toBe(200);
    expect(await xmin()).toBe(first);
  });

  it("sign-out, a disabled account and a raised epoch each end the session for the next request", async () => {
    const out = await complete();
    expect(
      (
        await api.request("POST", "/v1/auth/sign-out", {
          body: {},
          cookie: out.cookie,
          headers: from(),
        })
      ).status,
    ).toBe(200);
    expect((await product(out.cookie)).status).toBe(401);

    const disabled = await complete();
    await api.superuser.query(
      "UPDATE auth.account_state SET state = 'disabled' WHERE user_id = $1",
      [owner.userId],
    );
    try {
      expect((await product(disabled.cookie)).status).toBe(401);
      expect(await getSession(disabled.cookie)).toBeNull();
    } finally {
      await api.superuser.query(
        "UPDATE auth.account_state SET state = 'active' WHERE user_id = $1",
        [owner.userId],
      );
    }

    const epoch = await complete();
    await api.superuser.query(
      "UPDATE auth.account_state SET auth_epoch = auth_epoch + 1 WHERE user_id = $1",
      [owner.userId],
    );
    expect((await product(epoch.cookie)).status).toBe(401);
    expect(await getSession(epoch.cookie)).toBeNull();
    // Control: a new sign-in works on the new epoch.
    expect((await product((await complete()).cookie)).status).toBe(204);
  });
});
