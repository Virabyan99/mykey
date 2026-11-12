// Run 3.4 Task C (FR-1.03, AC-1.02): a TOTP step and a recovery code are used
// once, also when two API processes on one database receive them at the same
// moment. Each race runs 20 times.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "@mykey/api";
import { codeAt, createAuth, generateKeyFiles, loadAuthKeys, stepAt } from "@mykey/auth";
import { ensureQueues } from "@mykey/operations";
import { drizzle } from "drizzle-orm/node-postgres";
import * as OTPAuth from "otpauth";
import { TEST_ORIGIN, requestTo, sessionCookieOf } from "../../harness/api.ts";
import { startApiProcess, type ApiProcess } from "../../harness/api-worker.ts";
import { prepareDatabase, type TestDatabase } from "../database/setup.ts";

const ROUNDS = 20;

let db: TestDatabase;
let directory: string;
let processes: [ApiProcess, ApiProcess];
let ca: Buffer;
const user = {
  email: `racer-${randomBytes(4).toString("hex")}@mykey.invalid`,
  password: randomBytes(18).toString("base64url"),
  seed: new Uint8Array() as Uint8Array,
  fresh: "",
};

let sources = 0;
const from = (): Record<string, string> => {
  sources += 1;
  return { "x-forwarded-for": `192.0.2.${String(sources % 250)}` };
};

function call(
  which: 0 | 1,
  path: string,
  init: { body?: unknown; cookie?: string; now?: Date },
): Promise<Response> {
  return requestTo({ port: processes[which].port, ca }, "POST", path, {
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    headers: {
      ...from(),
      ...(init.now === undefined ? {} : { "x-test-now": init.now.toISOString() }),
    },
  });
}

async function passwordSession(which: 0 | 1): Promise<string> {
  const response = await call(which, "/v1/auth/sign-in/email", {
    body: { email: user.email, password: user.password },
  });
  expect(response.status).toBe(200);
  return sessionCookieOf(response);
}

beforeAll(async () => {
  db = await prepareDatabase();
  await ensureQueues(db.pool("migration_owner"));
  directory = mkdtempSync(join(tmpdir(), "mykey-race-"));
  const keysDirectory = mkdtempSync(join(directory, "keys-"));
  generateKeyFiles(keysDirectory);
  const hostInstanceId = randomUUID();
  const gatePath = join(directory, "gate.json");
  writeFileSync(
    gatePath,
    JSON.stringify({
      version: 1,
      state: "open",
      gateEpoch: 1,
      hostInstanceId,
      writtenAt: new Date().toISOString(),
    }),
  );
  const api: ApiConfig = {
    baseUrl: TEST_ORIGIN,
    build: "0000000",
    gatePath,
    hostInstanceId,
    trustedProxy: "127.0.0.1",
  };
  const tls = { certPath: db.stack.api.certPath, keyPath: db.stack.api.keyPath };
  ca = readFileSync(db.stack.api.certAuthorityPath);
  processes = [
    await startApiProcess(db.targets.api_runtime, { keysDirectory, api, tls }),
    await startApiProcess(db.targets.api_runtime, { keysDirectory, api, tls }),
  ];

  // An enrollment_pending account, enrolled through process 0.
  const auth = createAuth({
    db: drizzle(db.pool("maintenance")),
    keys: loadAuthKeys(keysDirectory),
    baseURL: TEST_ORIGIN,
  });
  const hash = await (await auth.$context).password.hash(user.password);
  const operator = db.pool("maintenance");
  const created = await operator.query<{ id: string }>(
    `INSERT INTO auth."user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'Racer', $1, true) RETURNING id`,
    [user.email],
  );
  const userId = created.rows[0]!.id;
  await operator.query(
    "INSERT INTO auth.account (id, account_id, provider_id, user_id, password) VALUES (gen_random_uuid(), $1, 'credential', $2, $3)",
    [userId, userId, hash],
  );
  await operator.query(
    "INSERT INTO auth.account_state (user_id, state) VALUES ($1, 'enrollment_pending')",
    [userId],
  );
  const cookie = await passwordSession(0);
  const enrolled = await call(0, "/v1/auth/totp/enroll", { body: {}, cookie });
  expect(enrolled.status).toBe(200);
  user.seed = OTPAuth.Secret.fromBase32(
    ((await enrolled.json()) as { secret: string }).secret,
  ).bytes;
  const now = new Date();
  const activated = await call(0, "/v1/auth/totp/activate", {
    body: { code: codeAt(user.seed, stepAt(now)) },
    cookie,
    now,
  });
  expect(activated.status).toBe(200);
  // A TOTP-elevated session: fresh for ten minutes, used to regenerate codes.
  user.fresh = sessionCookieOf(activated);
}, 300_000);

afterAll(async () => {
  for (const process of processes) await process.kill();
  await db.drop();
  rmSync(directory, { recursive: true, force: true });
});

// The losers of each race are counted as factor failures; a round must not
// inherit a lock from the rounds before it (the lock is throttle.test.ts's).
beforeEach(async () => {
  await db.pool("superuser").query("DELETE FROM app.rate_limit");
});

const statusesOf = async (responses: Promise<Response>[]): Promise<number[]> =>
  (await Promise.all(responses)).map((response) => response.status).sort((a, b) => a - b);

describe("one use across two API processes", () => {
  it(`one TOTP step, two sessions, one request to each process: exactly one 200 (${String(ROUNDS)} rounds)`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      // A step of its own for each round, far from the activation's.
      const now = new Date(Date.now() + (round + 10) * 120_000);
      const code = codeAt(user.seed, stepAt(now));
      const [a, b] = [await passwordSession(0), await passwordSession(1)];
      const statuses = await statusesOf([
        call(0, "/v1/auth/totp/verify", { body: { code }, cookie: a, now }),
        call(1, "/v1/auth/totp/verify", { body: { code }, cookie: b, now }),
      ]);
      expect(statuses, `round ${String(round)}`).toEqual([200, 401]);
      await db.pool("superuser").query("DELETE FROM app.rate_limit");
    }
  });

  it(`one recovery code, two password-only sessions, two processes: exactly one 200 (${String(ROUNDS)} rounds)`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const regenerated = await call(round % 2 === 0 ? 0 : 1, "/v1/auth/recovery/regenerate", {
        body: {},
        cookie: user.fresh,
      });
      expect(regenerated.status, `round ${String(round)}`).toBe(200);
      const [code] = ((await regenerated.json()) as { recoveryCodes: string[] }).recoveryCodes;
      const [a, b] = [await passwordSession(0), await passwordSession(1)];
      const statuses = await statusesOf([
        call(0, "/v1/auth/recovery/verify", { body: { code }, cookie: a }),
        call(1, "/v1/auth/recovery/verify", { body: { code }, cookie: b }),
      ]);
      expect(statuses, `round ${String(round)}`).toEqual([200, 401]);
      await db.pool("superuser").query("DELETE FROM app.rate_limit");
    }
  });

  it("the same session presented to both processes with one valid code: one 200, one 401, one mfa_complete row", async () => {
    const now = new Date(Date.now() + 90 * 120_000);
    const code = codeAt(user.seed, stepAt(now));
    const cookie = await passwordSession(0);
    const before = await db
      .pool("superuser")
      .query<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth.session WHERE phase = 'mfa_complete'",
      );
    const statuses = await statusesOf([
      call(0, "/v1/auth/totp/verify", { body: { code }, cookie, now }),
      call(1, "/v1/auth/totp/verify", { body: { code }, cookie, now }),
    ]);
    expect(statuses).toEqual([200, 401]);
    const after = await db
      .pool("superuser")
      .query<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth.session WHERE phase = 'mfa_complete'",
      );
    expect((after.rows[0]?.n ?? 0) - (before.rows[0]?.n ?? 0)).toBe(1);
  });
});
