// Run 3.2 Task C: password sign-in on the pipeline, bound to account state and
// epochs (FR-1.01, Doc 06 §4.2). Every failure is the same 401 with no cookie.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relayNative, signInWithPassword } from "@mykey/auth";
import { errorResponse } from "@mykey/api";
import { seedOwner, startTestApi, type TestApi } from "../../harness/api.ts";

const COOKIE = "__Secure-better-auth.session_token";

let api: TestApi;
let owner: Awaited<ReturnType<typeof seedOwner>>;

beforeAll(async () => {
  // Each request from its own source (the harness's peer is the trusted edge
  // here): this suite tests sign-in, not the per-source limit (throttle.test.ts).
  api = await startTestApi({ config: { trustedProxy: "127.0.0.1" } });
  owner = await seedOwner(api);
});

afterAll(async () => {
  await api.close();
});

let sources = 0;
const signIn = (email: string, password: string): Promise<Response> => {
  sources += 1;
  return api.request("POST", "/v1/auth/sign-in/email", {
    body: { email, password },
    headers: { "x-forwarded-for": `198.51.100.${String(sources)}` },
  });
};

async function sessionCount(): Promise<number> {
  const result = await api.superuser.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM auth.session",
  );
  return result.rows[0]?.n ?? -1;
}

async function setState(userId: string, state: string): Promise<void> {
  await api.superuser.query("UPDATE auth.account_state SET state = $2 WHERE user_id = $1", [
    userId,
    state,
  ]);
}

/** Status, header names and body of a refusal, with the request id removed. */
async function refusal(response: Response): Promise<unknown> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  return {
    status: response.status,
    headers: [...response.headers.keys()].filter((name) => name !== "date").sort(),
    body: { error: { ...body.error, requestId: "" } },
  };
}

describe("sign-in", () => {
  it("is refused before the owner exists", async () => {
    const response = await signIn(
      `nobody-${randomBytes(4).toString("hex")}@mykey.invalid`,
      "x".repeat(16),
    );
    expect(response.status).toBe(401);
  });

  it("the owner signs in: 200, one Secure HttpOnly SameSite=Strict host-only cookie, the phase only", async () => {
    const before = await sessionCount();
    const response = await signIn(owner.email, owner.password);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"phase":"password_verified"}');
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const parts = (cookies[0] ?? "").split("; ");
    expect(parts[0]?.startsWith(`${COOKIE}=`)).toBe(true);
    expect(parts.slice(1).sort()).toEqual(
      ["HttpOnly", "Max-Age=43200", "Path=/", "SameSite=Strict", "Secure"].sort(),
    );
    expect(parts.some((part) => part.toLowerCase().startsWith("domain="))).toBe(false);
    expect(await sessionCount()).toBe(before + 1);
    // The database holds a verifier, never the cookie's token.
    const value = decodeURIComponent((parts[0] ?? "").slice(COOKIE.length + 1));
    const token = value.slice(0, value.lastIndexOf("."));
    const stored = await api.superuser.query<{ token: string; phase: string }>(
      "SELECT token, phase FROM auth.session WHERE user_id = $1",
      [owner.userId],
    );
    expect(stored.rows.some((row) => row.token === token)).toBe(false);
    expect(stored.rows.every((row) => row.token.startsWith("v1."))).toBe(true);
    expect(stored.rows.at(-1)?.phase).toBe("password_verified");
  });

  it("unknown e-mail, wrong password, disabled and recovery_pending answer alike, with no cookie and no session", async () => {
    const answers: unknown[] = [];
    const before = await sessionCount();
    const unknown = await signIn(
      `nobody-${randomBytes(4).toString("hex")}@mykey.invalid`,
      owner.password,
    );
    expect(unknown.headers.getSetCookie()).toEqual([]);
    answers.push(await refusal(unknown));
    const wrong = await signIn(owner.email, `${owner.password}x`);
    expect(wrong.headers.getSetCookie()).toEqual([]);
    answers.push(await refusal(wrong));
    for (const state of ["disabled", "recovery_pending"]) {
      await setState(owner.userId, state);
      const response = await signIn(owner.email, owner.password);
      expect(response.headers.getSetCookie(), state).toEqual([]);
      answers.push(await refusal(response));
    }
    await setState(owner.userId, "enrollment_pending");
    expect(await sessionCount()).toBe(before);
    expect(answers[0]).toMatchObject({ status: 401, body: { error: { code: "unauthenticated" } } });
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    // Control: the same owner, back in its state, signs in.
    expect((await signIn(owner.email, owner.password)).status).toBe(200);
  });

  it("an epoch moved between verification and commit is refused and leaves no session", async () => {
    const before = await sessionCount();
    const result = await signInWithPassword(
      {
        auth: api.auth,
        pool: api.pool,
        keys: api.keys,
        afterVerify: async () => {
          await api.superuser.query(
            "UPDATE auth.account_state SET auth_epoch = auth_epoch + 1 WHERE user_id = $1",
            [owner.userId],
          );
        },
      },
      { email: owner.email, password: owner.password, headers: new Headers(), requestId: null },
    );
    expect(result).toMatchObject({ ok: false, reason: "epoch" });
    expect(await sessionCount()).toBe(before);
    // Control: without the hook the same call succeeds.
    const control = await signInWithPassword(
      { auth: api.auth, pool: api.pool, keys: api.keys },
      { email: owner.email, password: owner.password, headers: new Headers(), requestId: null },
    );
    expect(control.ok).toBe(true);
  });

  it("each sign-in writes one auth.sign_in audit row, without the e-mail", async () => {
    const rows = await api.superuser.query<Record<string, unknown>>(
      "SELECT * FROM audit.event WHERE action = 'auth.sign_in' ORDER BY occurred_at",
    );
    const outcomes = rows.rows.map((row) => row.outcome);
    expect(outcomes).toContain("success");
    expect(outcomes).toContain("failure");
    for (const row of rows.rows) {
      const text = JSON.stringify(row);
      expect(text.includes(owner.email)).toBe(false);
      expect(text.includes("@mykey.invalid")).toBe(false);
      expect(text.includes(owner.password)).toBe(false);
    }
    const success = rows.rows.find((row) => row.outcome === "success");
    expect(success).toMatchObject({ actor_kind: "user", actor_id: owner.userId });
  });
});

describe("native relay (M16)", () => {
  it("a 2xx native answer that is not JSON becomes dependency_unavailable, not a crash", async () => {
    const response = await relayNative(
      new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }),
      { respondError: errorResponse },
      "6f1c4c4e-2a52-4c4b-9a39-2c1f3a1d4e5f",
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "dependency_unavailable",
    );
    // Control: JSON is relayed, without any token field.
    const json = await relayNative(
      Response.json({ session: { id: "s", token: "t" } }),
      { respondError: errorResponse },
      "6f1c4c4e-2a52-4c4b-9a39-2c1f3a1d4e5f",
    );
    expect(await json.json()).toEqual({ session: { id: "s" } });
  });
});
