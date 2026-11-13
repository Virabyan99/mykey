// Run 3.3 (FR-1.07, AC-1.05, P-48): throttling of password and factor
// attempts. Counters on database time (Task A), limits on the routes (Task B).
// Time is moved by ageing rows through the superuser, never by sleeping.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeAt, createThrottle, stepAt, throttleDigest, ringKey } from "@mykey/auth";
import { bootstrapOwner } from "@mykey/auth/operator";
import { bumpCounter, createPool, sumCounters } from "@mykey/db";
import { pgDump } from "../../harness/stack.ts";
import { awaitFreshWindow } from "../../harness/windows.ts";
import {
  enrollOwner,
  seedOwner,
  sessionCookieOf,
  startTestApi,
  type SeededOwner,
  type TestApi,
} from "../../harness/api.ts";

let api: TestApi;

beforeAll(async () => {
  // The harness's peer (127.0.0.1) is the trusted edge here, so each test can
  // send from its own sources through X-Forwarded-For.
  api = await startTestApi({ config: { trustedProxy: "127.0.0.1" } });
});

afterAll(async () => {
  await api.close();
});

let addressCounter = 0;
/** A fresh documentation address (TEST-NET-3) for each source a test uses. */
const source = (): string => {
  addressCounter += 1;
  if (addressCounter > 254) throw new Error("out of test addresses");
  return `203.0.113.${String(addressCounter)}`;
};
const from = (address: string): Record<string, string> => ({ "x-forwarded-for": address });
const unused = (): string => `nobody-${randomBytes(4).toString("hex")}@mykey.invalid`;

function signIn(email: string, password: string, address: string): Promise<Response> {
  return api.request("POST", "/v1/auth/sign-in/email", {
    body: { email, password },
    headers: from(address),
  });
}

async function sessionCount(): Promise<number> {
  const result = await api.superuser.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM auth.session",
  );
  return result.rows[0]?.n ?? -1;
}

/** Moves every lock of `phase` back in time by `seconds`. */
async function ageLocks(phase: string, seconds: number): Promise<void> {
  await api.superuser.query(
    "UPDATE app.rate_limit SET window_start = window_start - make_interval(secs => $2) WHERE scope = $1",
    [`lock:${phase}`, seconds],
  );
}

/** Counts calls of Better Auth's own sign-in, by wrapping it for the duration of `run`. */
async function countNative<T>(run: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const native = api.auth.api as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = native.signInEmail!;
  let calls = 0;
  native.signInEmail = (...args: unknown[]) => {
    calls += 1;
    return original(...args);
  };
  try {
    return { result: await run(), calls };
  } finally {
    native.signInEmail = original;
  }
}

describe("counters (Task A)", () => {
  const key = new Uint8Array(randomBytes(32));

  it("50 concurrent bumps of one key return 1…50 exactly once each", async () => {
    const second = createPool(api.database.targets.api_runtime, { max: 10 });
    try {
      const digest = throttleDigest(key, "test:concurrent", randomBytes(8).toString("hex"));
      const counts = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          bumpCounter(i % 2 === 0 ? api.pool : second, "test:concurrent", digest, 60),
        ),
      );
      expect(counts.map((entry) => entry.count).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 1),
      );
    } finally {
      await second.end();
    }
  });

  it("the window comes from database time: a row aged by 61 s is not counted", async () => {
    const digest = throttleDigest(key, "test:aged", randomBytes(8).toString("hex"));
    expect((await bumpCounter(api.pool, "test:aged", digest, 60)).count).toBe(1);
    await api.superuser.query(
      "UPDATE app.rate_limit SET window_start = window_start - interval '61 seconds' WHERE key_digest = $1",
      [digest],
    );
    expect(await sumCounters(api.pool, "test:aged", digest, 60, 1)).toBe(0);
    expect((await bumpCounter(api.pool, "test:aged", digest, 60)).count).toBe(1);
  });

  it("sumCounters adds the current and the previous window, nothing older", async () => {
    const digest = throttleDigest(key, "test:sum", randomBytes(8).toString("hex"));
    const insert = (windowsAgo: number, count: number) =>
      api.superuser.query(
        `INSERT INTO app.rate_limit (scope, key_digest, window_start, count)
         VALUES ('test:sum', $1, date_bin(interval '900 seconds', now(), timestamptz 'epoch') - make_interval(secs => 900 * $2), $3)`,
        [digest, windowsAgo, count],
      );
    await insert(0, 2);
    await insert(1, 3);
    await insert(2, 7);
    expect(await sumCounters(api.pool, "test:sum", digest, 900, 2)).toBe(5);
    expect(await sumCounters(api.pool, "test:sum", digest, 900, 1)).toBe(2);
  });

  it("a table dump holds no e-mail, address or user id of the test", async () => {
    const throttle = createThrottle({ pool: api.pool, ring: api.keys.rateLimit });
    const email = unused();
    const address = "198.51.100.77";
    const userId = "6f1c4c4e-2a52-4c4b-9a39-2c1f3a1d4e5f";
    await throttle.admit("password", { source: address, account: email });
    await throttle.recordFailure("password", email);
    await throttle.admit("factor", { source: address, account: userId });
    await throttle.recordFailure("factor", userId);
    const dump = await pgDump(api.database.stack, api.database.database);
    expect(dump.includes("rate_limit")).toBe(true);
    for (const needle of [email, address, userId]) expect(dump.includes(needle)).toBe(false);
    // Control: the digest itself is there.
    const digest = throttleDigest(ringKey(api.keys.rateLimit), "fail:password", email);
    expect(dump.includes(digest.toString("hex"))).toBe(true);
  });
});

describe("limits on the routes (Task B)", () => {
  let owner: SeededOwner;

  beforeAll(async () => {
    owner = await seedOwner(api);
  });

  it("per source: attempts 1–5 reach the credential check, the 6th is 429 even with the right password", async () => {
    // Inside one window: the count of a new window starts at zero.
    await awaitFreshWindow(api.superuser);
    const address = source();
    for (let i = 0; i < 5; i += 1) {
      const response = await signIn(unused(), "wrong-password-0", address);
      expect(response.status, `attempt ${String(i + 1)}`).toBe(401);
    }
    const before = await sessionCount();
    const { result, calls } = await countNative(() => signIn(owner.email, owner.password, address));
    expect(result.status).toBe(429);
    expect(((await result.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    const retryAfter = Number(result.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(calls).toBe(0);
    expect(await sessionCount()).toBe(before);
    // Control: the same password from another source signs in.
    expect((await signIn(owner.email, owner.password, source())).status).toBe(200);
  });

  it("per account: five wrong passwords from five sources lock it; the lock lasts 900 s, not less", async () => {
    const victim = await bootstrapLessOwner();
    for (let i = 0; i < 5; i += 1) {
      expect((await signIn(victim.email, "wrong-password-1", source())).status).toBe(401);
    }
    expect((await signIn(victim.email, victim.password, source())).status).toBe(429);
    await ageLocks("password", 895);
    expect((await signIn(victim.email, victim.password, source())).status).toBe(429);
    await ageLocks("password", 6);
    expect((await signIn(victim.email, victim.password, source())).status).toBe(200);
  });

  it("known and unknown accounts are indistinguishable", async () => {
    const victim = await bootstrapLessOwner();
    const nobody = unused();
    const transcripts: Record<string, unknown[]> = { known: [], unknown: [] };
    for (let i = 0; i < 6; i += 1) {
      for (const [name, email] of [
        ["known", victim.email],
        ["unknown", nobody],
      ] as const) {
        const response = await signIn(email, "wrong-password-2", source());
        const body = (await response.json()) as { error: Record<string, unknown> };
        transcripts[name]!.push({
          status: response.status,
          headers: [...response.headers.keys()]
            .filter((header) => header !== "date" && header !== "x-request-id")
            .sort(),
          retryAfter: response.headers.get("retry-after"),
          body: { ...body.error, requestId: "" },
        });
      }
    }
    expect(transcripts.known).toEqual(transcripts.unknown);
    expect(transcripts.known!.at(-1)).toMatchObject({ status: 429 });
  });

  it("a locked attempt verifies nothing and writes auth.throttled, not auth.sign_in", async () => {
    const victim = await bootstrapLessOwner();
    for (let i = 0; i < 5; i += 1) await signIn(victim.email, "wrong-password-3", source());
    const { result, calls } = await countNative(() =>
      signIn(victim.email, victim.password, source()),
    );
    expect(result.status).toBe(429);
    expect(calls).toBe(0);
    const requestId = result.headers.get("x-request-id");
    const rows = await api.superuser.query<{ action: string; details: unknown; outcome: string }>(
      "SELECT action, details, outcome FROM audit.event WHERE request_id = $1",
      [requestId],
    );
    expect(rows.rows).toEqual([
      { action: "auth.throttled", details: { phase: "password" }, outcome: "denied" },
    ]);
  });

  it("factor: five wrong TOTP codes lock the factor phase; recovery codes share the budget", async () => {
    const enrolled = await enrollOwner(api, await bootstrapLessOwner(), { source: source() });
    const passwordSession = async (): Promise<string> => {
      const response = await signIn(enrolled.email, enrolled.password, source());
      expect(response.status).toBe(200);
      return sessionCookieOf(response);
    };
    const wrongCode = codeAt(enrolled.seed, stepAt(new Date()) + 10);
    // Three wrong TOTP codes and two wrong recovery codes: five failures.
    let cookie = await passwordSession();
    for (let i = 0; i < 3; i += 1) {
      const response = await api.request("POST", "/v1/auth/totp/verify", {
        body: { code: wrongCode },
        cookie,
        headers: from(source()),
      });
      expect(response.status).toBe(401);
    }
    for (let i = 0; i < 2; i += 1) {
      const response = await api.request("POST", "/v1/auth/recovery/verify", {
        body: { code: "AAAA-AAAA-AAAA" },
        cookie,
        headers: from(source()),
      });
      expect(response.status).toBe(401);
    }
    cookie = await passwordSession();
    const right = await api.request("POST", "/v1/auth/totp/verify", {
      body: { code: codeAt(enrolled.seed, stepAt(new Date())) },
      cookie,
      headers: from(source()),
    });
    expect(right.status).toBe(429);
    const recovery = await api.request("POST", "/v1/auth/recovery/verify", {
      body: { code: enrolled.recoveryCodes[0] },
      cookie,
      headers: from(source()),
    });
    expect(recovery.status).toBe(429);
    // The password phase of the same account is not locked by it.
    expect((await signIn(enrolled.email, enrolled.password, source())).status).toBe(200);
  });

  it("counter failure refuses: no session, no native call", async () => {
    const victim = await bootstrapLessOwner();
    const before = await sessionCount();
    await api.superuser.query("REVOKE INSERT ON app.rate_limit FROM api_runtime");
    try {
      const { result, calls } = await countNative(() =>
        signIn(victim.email, victim.password, source()),
      );
      expect(result.status).toBe(503);
      expect(((await result.json()) as { error: { code: string } }).error.code).toBe(
        "dependency_unavailable",
      );
      expect(calls).toBe(0);
      expect(await sessionCount()).toBe(before);
    } finally {
      await api.superuser.query("GRANT INSERT ON app.rate_limit TO api_runtime");
    }
    expect((await signIn(victim.email, victim.password, source())).status).toBe(200);
  });

  it("a throttle lock does not stop the operator", async () => {
    for (let i = 0; i < 5; i += 1) await signIn(owner.email, "wrong-password-4", source());
    expect((await signIn(owner.email, owner.password, source())).status).toBe(429);
    const again = await bootstrapOwner(
      { auth: api.auth, pool: api.database.pool("maintenance") },
      { email: owner.email, password: "irrelevant-password" },
    );
    expect(again.outcome).toBe("already_present");
  });
});

/**
 * Another account in the same organization's database, made as the operator
 * would (the bootstrap allows one owner; the rest are inserted directly).
 */
async function bootstrapLessOwner(): Promise<SeededOwner> {
  const email = unused();
  const password = randomBytes(18).toString("base64url");
  const hash = await (await api.auth.$context).password.hash(password);
  const operator = api.database.pool("maintenance");
  const user = await operator.query<{ id: string }>(
    `INSERT INTO auth."user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'User', $1, true) RETURNING id`,
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
