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

/** GET reference.get: a human route without scope whose stub answers 204 once every check passed. */
const product = (cookie: string) =>
  api.request("GET", "/v1/reference", { cookie, headers: from() });
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

describe("list and revoke (Task B)", () => {
  interface Listed {
    id: string;
    createdAt: string;
    lastActivityAt: string;
    client: string;
    current: boolean;
  }
  const list = async (cookie: string): Promise<Response> =>
    api.request("GET", "/v1/auth/sessions", { cookie, headers: from() });
  const revoke = (cookie: string, sessionId: string): Promise<Response> =>
    api.request("POST", "/v1/auth/sessions/revoke", {
      body: { sessionId },
      cookie,
      headers: from(),
    });

  it("lists this user's sessions with creation, last activity and client, marks the current one, and holds no token", async () => {
    const mine = await complete();
    const other = await complete();
    const response = await list(mine.cookie);
    expect(response.status).toBe(200);
    const text = await response.text();
    const value = mine.cookie.slice(mine.cookie.indexOf("=") + 1);
    expect(text.includes(decodeURIComponent(value).split(".")[0] ?? "x")).toBe(false);
    expect(text.includes("v1.")).toBe(false);
    const { sessions } = JSON.parse(text) as { sessions: Listed[] };
    const current = sessions.filter((session) => session.current);
    expect(current.map((session) => session.id)).toEqual([mine.sessionId]);
    expect(sessions.map((session) => session.id)).toContain(other.sessionId);
    for (const session of sessions) {
      expect(Object.keys(session).sort()).toEqual([
        "client",
        "createdAt",
        "current",
        "id",
        "lastActivityAt",
      ]);
      expect(session.client.length).toBeLessThanOrEqual(120);
      expect(Number.isNaN(Date.parse(session.createdAt))).toBe(false);
    }
  });

  it("revoking another session ends it for its next request and leaves this one", async () => {
    const mine = await complete();
    const other = await complete();
    expect((await revoke(mine.cookie, other.sessionId)).status).toBe(200);
    expect((await product(other.cookie)).status).toBe(401);
    expect((await product(mine.cookie)).status).toBe(204);
  });

  it("an id of another user is the same 404 as an absent one, and ends nothing", async () => {
    const stranger = await enrollOwner(api, await anotherUser(), { source: "198.51.100.253" });
    const theirs = await signInComplete(api, stranger, { source: "198.51.100.254" });
    const mine = await complete();
    const foreign = await revoke(mine.cookie, theirs.sessionId);
    const absent = await revoke(mine.cookie, "6f1c4c4e-2a52-4c4b-9a39-2c1f3a1d4e5f");
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    const body = async (response: Response) => {
      const parsed = (await response.json()) as { error: Record<string, unknown> };
      return { ...parsed.error, requestId: "" };
    };
    expect(await body(foreign)).toEqual(await body(absent));
    // Control: the stranger's session still answers.
    expect((await product(theirs.cookie)).status).toBe(204);
  });

  it("revoke-all ends every session, this one included", async () => {
    const mine = await complete();
    const other = await complete();
    const response = await api.request("POST", "/v1/auth/revoke-sessions", {
      body: {},
      cookie: mine.cookie,
      headers: from(),
    });
    expect(response.status).toBe(200);
    expect((await product(mine.cookie)).status).toBe(401);
    expect((await product(other.cookie)).status).toBe(401);
  });

  it("a password-only session can neither list nor revoke", async () => {
    const victim = await complete();
    const signedIn = await api.request("POST", "/v1/auth/sign-in/email", {
      body: { email: owner.email, password: owner.password },
      headers: from(),
    });
    const passwordOnly = sessionCookieOf(signedIn);
    const listed = await list(passwordOnly);
    expect(listed.status).toBe(401);
    expect(((await listed.json()) as { error: { code: string } }).error.code).toBe(
      "mfa_incomplete",
    );
    expect((await revoke(passwordOnly, victim.sessionId)).status).toBe(401);
    expect((await product(victim.cookie)).status).toBe(204);
  });
});

/** Another account with its own enrollment (the bootstrap allows one owner). */
async function anotherUser(): Promise<{
  userId: string;
  organizationId: string;
  email: string;
  password: string;
}> {
  const email = `other-${String(Date.now())}@mykey.invalid`;
  const password = `pw-${String(Date.now())}-long-enough`;
  const hash = await (await api.auth.$context).password.hash(password);
  const operator = api.database.pool("maintenance");
  const user = await operator.query<{ id: string }>(
    `INSERT INTO auth."user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'Other', $1, true) RETURNING id`,
    [email],
  );
  const userId = user.rows[0]!.id;
  await operator.query(
    "INSERT INTO auth.account (id, account_id, provider_id, user_id, password) VALUES (gen_random_uuid(), $1, 'credential', $2, $3)",
    [userId, userId, hash],
  );
  await operator.query(
    "INSERT INTO auth.account_state (user_id, state) VALUES ($1, 'enrollment_pending')",
    [userId],
  );
  return { userId, organizationId: "", email, password };
}
