// Run 2.3 Task C: session tokens are stored only as keyed verifiers (P-26).
import { UnsupportedTokenOperation, sessionVerifier, type KeyRing } from "@mykey/auth";
import type { BetterAuthOptions } from "better-auth";
import { makeSignature } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../database/setup.ts";
import {
  COOKIE_NAME,
  cookieOf,
  authFixture,
  keyRing,
  tokenOf,
  type AuthFixture,
  type SeededUser,
} from "./fixture.ts";

let fixture: AuthFixture;
let user: SeededUser;

beforeAll(async () => {
  fixture = await authFixture();
  user = await fixture.seedUser();
});

afterAll(async () => {
  await fixture.close();
});

const storedTokens = async (userId: string): Promise<string[]> =>
  (
    await run<{ token: string }>(
      fixture.pool,
      "SELECT token FROM auth.session WHERE user_id = $1",
      [userId],
    )
  ).map((row) => row.token);

const sessionOf = async (cookie: string): Promise<{ user: { id: string } } | null> => {
  const response = await fixture.request("GET", "/v1/auth/get-session", { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as { user: { id: string } } | null;
};

/** A cookie for `value`, signed as Better Auth signs its session cookie. */
const signedCookie = async (value: string): Promise<string> =>
  `${COOKIE_NAME}=${encodeURIComponent(`${value}.${await makeSignature(value, fixture.keys.cookieSecret)}`)}`;

/** Marks the user's newest session as having completed the second factor (Task D does it properly). */
const elevateNewest = async (userId: string): Promise<void> => {
  await run(
    fixture.db.pool("superuser"),
    "UPDATE auth.session SET phase = 'mfa_complete' WHERE id = (SELECT id FROM auth.session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)",
    [userId],
  );
};

describe("stored sessions", () => {
  it("hold the verifier of the cookie's token, never the token", async () => {
    const cookie = await fixture.signIn(user);
    const token = tokenOf(cookie);
    expect(token.length).toBeGreaterThanOrEqual(32);
    const stored = await storedTokens(user.id);
    expect(stored).toContain(sessionVerifier(fixture.keys.sessionLookup, token));
    expect(stored.filter((value) => value.includes(token))).toEqual([]);
    expect(await sessionOf(cookie)).toMatchObject({ user: { id: user.id } });
  });

  it("a stored value is not a session, even when signed with the cookie secret", async () => {
    const cookie = await fixture.signIn(user);
    const token = tokenOf(cookie);
    // Control: the signing helper reproduces a working cookie from the raw token.
    expect(await sessionOf(await signedCookie(token))).toMatchObject({ user: { id: user.id } });
    const verifier = sessionVerifier(fixture.keys.sessionLookup, token);
    expect(await sessionOf(await signedCookie(verifier))).toBeNull();
  });

  it("sign-out removes the row; change-password keeps one; revoke-sessions keeps none", async () => {
    const other = await fixture.seedUser();
    const first = await fixture.signIn(other);
    expect(await storedTokens(other.id)).toHaveLength(1);
    expect((await fixture.request("POST", "/v1/auth/sign-out", { cookie: first })).status).toBe(
      200,
    );
    expect(await storedTokens(other.id)).toEqual([]);

    await fixture.signIn(other);
    await fixture.signIn(other);
    const current = await fixture.signIn(other);
    await elevateNewest(other.id);
    expect(await storedTokens(other.id)).toHaveLength(3);
    const newPassword = `${other.password}-2`;
    const changed = await fixture.request("POST", "/v1/auth/change-password", {
      cookie: current,
      body: { currentPassword: other.password, newPassword, revokeOtherSessions: true },
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).not.toHaveProperty("token");
    expect(await storedTokens(other.id)).toHaveLength(1);
    // Observed on 1.7.19 (D-19): the caller's session is replaced by a new one,
    // which has passed the password only. The owner must pass the factor again.
    expect(cookieOf(changed)).toBeDefined();
    expect(await sessionOf(current)).toBeNull();
    const kept = await run<{ phase: string }>(
      fixture.pool,
      "SELECT phase FROM auth.session WHERE user_id = $1",
      [other.id],
    );
    expect(kept).toEqual([{ phase: "password_verified" }]);

    const fresh = await fixture.signIn({ ...other, password: newPassword });
    await elevateNewest(other.id);
    const revoked = await fixture.request("POST", "/v1/auth/revoke-sessions", { cookie: fresh });
    expect(revoked.status).toBe(200);
    expect(await storedTokens(other.id)).toEqual([]);
  });

  it("survive a rotation of the lookup key until the old key is removed", async () => {
    const old = fixture.keys.sessionLookup;
    const cookie = await fixture.signIn(user);
    const oldId = old.current;
    const rotated: KeyRing = {
      current: "k9",
      keys: { ...old.keys, k9: keyRing("k9").keys.k9! },
    };
    fixture.rebuild({ keys: { ...fixture.keys, sessionLookup: rotated } });
    try {
      expect(await sessionOf(cookie)).toMatchObject({ user: { id: user.id } });
      const after = await fixture.signIn(user);
      expect(await storedTokens(user.id)).toContain(sessionVerifier(rotated, tokenOf(after), "k9"));

      const withoutOld: KeyRing = { current: "k9", keys: { k9: rotated.keys.k9! } };
      fixture.rebuild({ keys: { ...fixture.keys, sessionLookup: withoutOld } });
      expect(await sessionOf(cookie)).toBeNull();
      expect(await sessionOf(after)).toMatchObject({ user: { id: user.id } });
      expect(oldId).not.toBe("k9");
    } finally {
      fixture.rebuild({ keys: { ...fixture.keys, sessionLookup: old } });
    }
  });
});

interface Call {
  model: string;
  method: string;
  where: string[];
  data: string[];
  raw: string;
}

describe("the wrapper", () => {
  it("sees every token path, and nothing below it sees a raw token", async () => {
    const calls: Call[] = [];
    const record = (method: string, args: unknown): void => {
      const a = (args ?? {}) as {
        model?: string;
        where?: { field: string }[];
        data?: object;
        update?: object;
      };
      calls.push({
        model: a.model ?? "",
        method,
        where: (a.where ?? []).map((clause) => clause.field),
        data: Object.keys(a.data ?? a.update ?? {}),
        raw: JSON.stringify(args),
      });
    };
    const observe = (adapter: Record<string, unknown>): Record<string, unknown> => {
      const observed: Record<string, unknown> = { ...adapter };
      for (const [name, value] of Object.entries(adapter)) {
        if (typeof value !== "function") continue;
        const method = value as (...args: unknown[]) => unknown;
        observed[name] =
          name === "transaction"
            ? (callback: (trx: Record<string, unknown>) => unknown) =>
                method.call(adapter, (trx: Record<string, unknown>) => callback(observe(trx)))
            : (args: unknown) => {
                record(name, args);
                return method.call(adapter, args);
              };
      }
      return observed;
    };
    fixture.rebuild({
      observeAdapter:
        <A>(inner: (options: BetterAuthOptions) => A) =>
        (options: BetterAuthOptions) =>
          observe(inner(options) as Record<string, unknown>) as A,
    });
    const tokens: string[] = [];
    try {
      const observed = await fixture.seedUser();
      const first = await fixture.signIn(observed);
      tokens.push(tokenOf(first));
      await sessionOf(first);
      await elevateNewest(observed.id);
      const newPassword = `${observed.password}-2`;
      const changed = await fixture.request("POST", "/v1/auth/change-password", {
        cookie: first,
        body: { currentPassword: observed.password, newPassword, revokeOtherSessions: true },
      });
      expect(changed.status).toBe(200);
      const second = await fixture.signIn({ ...observed, password: newPassword });
      tokens.push(tokenOf(second));
      await elevateNewest(observed.id);
      expect(
        (await fixture.request("POST", "/v1/auth/revoke-sessions", { cookie: second })).status,
      ).toBe(200);
      const third = await fixture.signIn({ ...observed, password: newPassword });
      tokens.push(tokenOf(third));
      expect((await fixture.request("POST", "/v1/auth/sign-out", { cookie: third })).status).toBe(
        200,
      );
    } finally {
      fixture.rebuild({ observeAdapter: undefined });
    }

    for (const call of calls) {
      for (const token of tokens)
        expect(call.raw, `${call.model}.${call.method}`).not.toContain(token);
    }
    const tokenCalls = [
      ...new Set(
        calls
          .filter((call) => call.where.includes("token") || call.data.includes("token"))
          .map(
            (call) =>
              `${call.model}.${call.method} where[${call.where.join(",")}] data[${call.data.includes("token") ? "token" : ""}]`,
          ),
      ),
    ].sort();
    expect(tokenCalls).toEqual(TOKEN_CALLS);
  });

  it("fails closed on any other use of the token", async () => {
    const adapter = (await fixture.auth.$context).adapter;
    for (const operator of ["contains", "starts_with", "ne"] as const) {
      await expect(
        adapter.findMany({ model: "session", where: [{ field: "token", value: "x", operator }] }),
        operator,
      ).rejects.toThrow(UnsupportedTokenOperation);
    }
    await expect(
      adapter.findMany({ model: "session", sortBy: { field: "token", direction: "asc" } }),
    ).rejects.toThrow(UnsupportedTokenOperation);
    await expect(
      adapter.count({ model: "session", where: [{ field: "token", value: "x" }] }),
    ).rejects.toThrow(UnsupportedTokenOperation);
    // Control: the same adapter lists sessions by user, without their tokens.
    const rows = await adapter.findMany<{ token: string }>({
      model: "session",
      where: [{ field: "userId", value: user.id }],
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.token === "")).toBe(true);
  });
});

describe("client input", () => {
  it("cannot set the factor state of a new session", async () => {
    const before = await storedTokens(user.id);
    const response = await fixture.request("POST", "/v1/auth/sign-in/email", {
      body: {
        email: user.email,
        password: user.password,
        phase: "mfa_complete",
        totpVerifiedAt: new Date().toISOString(),
      },
    });
    expect(response.status).toBe(400);
    expect(await storedTokens(user.id)).toEqual(before);
    // Control: the same sign-in without those fields makes a password_verified session.
    await fixture.signIn(user);
    const phases = await run<{ phase: string }>(
      fixture.pool,
      "SELECT phase FROM auth.session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [user.id],
    );
    expect(phases[0]?.phase).toBe("password_verified");
  });
});

/**
 * The adapter calls that name `token` in the flow above, as observed on
 * better-auth 1.7.19. A version that adds a token path fails here until the
 * wrapper is shown to cover it (D-19).
 */
const TOKEN_CALLS: string[] = [
  "session.create where[] data[token]",
  "session.delete where[token] data[]",
  "session.findMany where[token] data[]",
  "session.findOne where[token] data[]",
];
