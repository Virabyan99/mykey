// Run 3.6 Task A (FR-1.04, PO-6, P-51): the operator initiates a reset; no
// HTTP route can. One transaction as maintenance: the account is blocked
// (recovery_pending, auth epoch + 1), its sessions end, earlier links are
// superseded, one new link is issued; afterwards the throttle locks are cleared.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createThrottle, ringKey, signInWithPassword, throttleDigest } from "@mykey/auth";
import { RESET_POINTS, initiateReset, resetLink } from "@mykey/auth/operator";
import { pgDump } from "../../harness/stack.ts";
import {
  enrollOwner,
  seedOwner,
  signInComplete,
  startTestApi,
  type EnrolledOwner,
  type TestApi,
} from "../../harness/api.ts";

const WORKER = resolve(import.meta.dirname, "reset-worker.ts");

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

/** Each case starts from an active account with no open reset. */
beforeEach(async () => {
  await api.superuser.query("DELETE FROM app.rate_limit");
  await api.superuser.query("UPDATE auth.session SET reset_token_id = NULL");
  await api.superuser.query("DELETE FROM auth.reset_token");
  await api.superuser.query("UPDATE auth.account_state SET state = 'active' WHERE user_id = $1", [
    owner.userId,
  ]);
});

const operator = () => ({
  pool: api.database.pool("maintenance"),
  keys: api.keys,
  throttle: createThrottle({ pool: api.database.pool("maintenance"), ring: api.keys.rateLimit }),
});

async function accountRow(): Promise<{ state: string; auth_epoch: number }> {
  const result = await api.superuser.query<{ state: string; auth_epoch: number }>(
    "SELECT state, auth_epoch::int AS auth_epoch FROM auth.account_state WHERE user_id = $1",
    [owner.userId],
  );
  return result.rows[0]!;
}

async function openTokens(): Promise<number> {
  const result = await api.superuser.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth.reset_token
      WHERE user_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL AND verifier IS NOT NULL`,
    [owner.userId],
  );
  return result.rows[0]?.n ?? -1;
}

describe("operator-initiated reset", () => {
  it("blocks the account at once: sessions end, the password no longer signs in, the epoch rises", async () => {
    const live = await signInComplete(api, owner, { source: "198.51.100.252" });
    expect(
      (await api.request("GET", "/v1/organizations", { cookie: live.cookie, headers: from() }))
        .status,
    ).toBe(204);
    const before = await accountRow();
    const result = await initiateReset(operator(), { email: owner.email, kind: "password" });
    expect(result.outcome).toBe("issued");
    expect(
      (await api.request("GET", "/v1/organizations", { cookie: live.cookie, headers: from() }))
        .status,
    ).toBe(401);
    const signIn = await api.request("POST", "/v1/auth/sign-in/email", {
      body: { email: owner.email, password: owner.password },
      headers: from(),
    });
    expect(signIn.status).toBe(401);
    const after = await accountRow();
    expect(after.state).toBe("recovery_pending");
    expect(after.auth_epoch).toBe(before.auth_epoch + 1);
    const sessions = await api.superuser.query("SELECT 1 FROM auth.session WHERE user_id = $1", [
      owner.userId,
    ]);
    expect(sessions.rowCount).toBe(0);
  });

  it("a second initiation supersedes the first link: one open token remains", async () => {
    const first = await initiateReset(operator(), { email: owner.email, kind: "password" });
    const second = await initiateReset(operator(), { email: owner.email, kind: "mfa" });
    expect(first.outcome).toBe("issued");
    expect(second.outcome).toBe("issued");
    expect(await openTokens()).toBe(1);
    const rows = await api.superuser.query<{
      kind: string;
      superseded: boolean;
      verifier: boolean;
    }>(
      `SELECT kind, superseded_at IS NOT NULL AS superseded, verifier IS NOT NULL AS verifier
         FROM auth.reset_token WHERE user_id = $1 ORDER BY created_at`,
      [owner.userId],
    );
    expect(rows.rows).toEqual([
      { kind: "password", superseded: true, verifier: false },
      { kind: "mfa", superseded: false, verifier: true },
    ]);
  });

  it("the table holds a verifier, never the token; the audit row holds neither", async () => {
    const result = await initiateReset(operator(), { email: owner.email, kind: "password" });
    if (result.outcome !== "issued") throw new Error("not issued");
    const dump = await pgDump(api.database.stack, api.database.database);
    expect(dump.includes(result.token)).toBe(false);
    expect(dump.includes(Buffer.from(result.token, "base64url").toString("hex"))).toBe(false);
    const audit = await api.superuser.query<{ text: string }>(
      "SELECT row_to_json(e)::text AS text FROM audit.event e WHERE action = 'operator.reset_initiate'",
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const row of audit.rows) expect(row.text.includes(result.token)).toBe(false);
    expect(JSON.parse(audit.rows.at(-1)!.text)).toMatchObject({ details: { kind: "password" } });
  });

  it("the link carries the token only in the fragment", async () => {
    const result = await initiateReset(operator(), { email: owner.email, kind: "mfa" });
    if (result.outcome !== "issued") throw new Error("not issued");
    const link = new URL(resetLink("https://mykey.test", result.token, "mfa"));
    expect(link.pathname).toBe("/reset");
    expect(link.search).toBe("");
    expect(link.hash.includes(result.token)).toBe(true);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const lifetime = result.expiresAt.getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(890_000);
    expect(lifetime).toBeLessThanOrEqual(900_000);
  });

  it("killed at each point and repeated: one open token, the account recovery_pending", async () => {
    expect(RESET_POINTS.length).toBeGreaterThanOrEqual(5);
    const wire = (ring: { current: string; keys: Readonly<Record<string, Uint8Array>> }) => ({
      current: ring.current,
      keys: Object.fromEntries(
        Object.entries(ring.keys).map(([id, key]) => [id, Buffer.from(key).toString("base64")]),
      ),
    });
    for (let point = 1; point <= RESET_POINTS.length; point += 1) {
      await api.superuser.query("DELETE FROM auth.reset_token");
      await api.superuser.query(
        "UPDATE auth.account_state SET state = 'active' WHERE user_id = $1",
        [owner.userId],
      );
      const settings = {
        target: api.database.targets.maintenance,
        email: owner.email,
        kind: "password",
        rateLimit: wire(api.keys.rateLimit),
        resetVerifier: wire(api.keys.resetVerifier),
      };
      const killed = await runWorker({ ...settings, crashAt: point });
      expect(killed, `point ${String(point)}`).toBe(137);
      // Nothing of the killed attempt remains.
      expect((await accountRow()).state, `point ${String(point)}`).toBe("active");
      expect(await openTokens(), `point ${String(point)}`).toBe(0);
      expect(await runWorker({ ...settings, crashAt: null })).toBe(0);
      expect((await accountRow()).state, `point ${String(point)}`).toBe("recovery_pending");
      expect(await openTokens(), `point ${String(point)}`).toBe(1);
    }
  });

  it("a sign-in that verified the old password before initiation and commits after it is refused", async () => {
    const result = await signInWithPassword(
      {
        auth: api.auth,
        pool: api.pool,
        keys: api.keys,
        afterVerify: async () => {
          expect(
            (await initiateReset(operator(), { email: owner.email, kind: "password" })).outcome,
          ).toBe("issued");
        },
      },
      { email: owner.email, password: owner.password, headers: new Headers(), requestId: null },
    );
    expect(result.ok).toBe(false);
    const sessions = await api.superuser.query("SELECT 1 FROM auth.session WHERE user_id = $1", [
      owner.userId,
    ]);
    expect(sessions.rowCount).toBe(0);
  });

  it("initiation clears the throttle locks of the account", async () => {
    const throttle = createThrottle({ pool: api.pool, ring: api.keys.rateLimit });
    for (let i = 0; i < 5; i += 1) {
      await throttle.recordFailure("password", owner.email);
      await throttle.recordFailure("factor", owner.userId);
    }
    const locks = () =>
      api.superuser.query("SELECT 1 FROM app.rate_limit WHERE key_digest = ANY ($1::bytea[])", [
        [
          throttleDigest(ringKey(api.keys.rateLimit), "lock:password", owner.email),
          throttleDigest(ringKey(api.keys.rateLimit), "lock:factor", owner.userId),
        ],
      ]);
    expect((await locks()).rowCount).toBe(2);
    expect(
      (await initiateReset(operator(), { email: owner.email, kind: "password" })).outcome,
    ).toBe("issued");
    expect((await locks()).rowCount).toBe(0);
  });

  it("an unknown e-mail or a disabled account is refused and nothing is written", async () => {
    const before = await api.superuser.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth.reset_token",
    );
    expect(
      await initiateReset(operator(), { email: "nobody@mykey.invalid", kind: "password" }),
    ).toEqual({ outcome: "refused", reason: "no_such_account" });
    await api.superuser.query(
      "UPDATE auth.account_state SET state = 'disabled' WHERE user_id = $1",
      [owner.userId],
    );
    expect(await initiateReset(operator(), { email: owner.email, kind: "password" })).toEqual({
      outcome: "refused",
      reason: "disabled",
    });
    const after = await api.superuser.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth.reset_token",
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("api_runtime cannot initiate: permission denied on reset_token", async () => {
    const error = await initiateReset(
      { ...operator(), pool: api.pool },
      { email: owner.email, kind: "password" },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "42501" });
    expect(await openTokens()).toBe(0);
    expect((await accountRow()).state).toBe("active");
  });
});

function runWorker(settings: Record<string, unknown>): Promise<number | null> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", reject);
    child.on("close", (code) => {
      resolveRun(code);
    });
    child.stdin.end(`${JSON.stringify(settings)}\n`);
  });
}
