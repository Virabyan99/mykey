// Run 3.6 Task C (FR-1.04, AC-1.03): only one completion of a reset link ever
// succeeds, also when two API processes receive it at the same moment; and an
// initiation racing a completion never leaves an active account with an open
// link. The cases run in this order: the mfa race retires the factor the
// others need.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "@mykey/api";
import {
  codeAt,
  createAuth,
  createThrottle,
  generateKeyFiles,
  loadAuthKeys,
  stepAt,
  type AuthKeys,
} from "@mykey/auth";
import { initiateReset, type ResetKind } from "@mykey/auth/operator";
import { ensureQueues } from "@mykey/operations";
import { drizzle } from "drizzle-orm/node-postgres";
import * as OTPAuth from "otpauth";
import { TEST_ORIGIN, requestTo, sessionCookieOf } from "../../harness/api.ts";
import { keepCapacityOk, startApiProcess, type ApiProcess } from "../../harness/api-worker.ts";
import { prepareDatabase, type TestDatabase } from "../database/setup.ts";
import { TEST_BUILD, gateText, setIncarnation } from "../../harness/gate.ts";

const ROUNDS = 20;

let capacity: { stop(): void } | undefined;
let db: TestDatabase;
let directory: string;
let keys: AuthKeys;
let processes: [ApiProcess, ApiProcess];
let ca: Buffer;
const user = {
  id: "",
  email: `reset-racer-${randomBytes(4).toString("hex")}@mykey.invalid`,
  password: randomBytes(18).toString("base64url"),
  seed: new Uint8Array() as Uint8Array,
};
let sources = 0;
const from = (): Record<string, string> => {
  sources += 1;
  return { "x-forwarded-for": `192.0.2.${String(sources % 250)}` };
};
let steps = 0;
const future = (): Date => {
  steps += 1;
  return new Date(Date.now() + (200 + steps) * 120_000);
};

function call(which: 0 | 1, path: string, body: unknown, extra: Record<string, string> = {}) {
  return requestTo({ port: processes[which].port, ca }, "POST", path, {
    body,
    headers: { ...from(), ...extra },
  });
}

async function issue(kind: ResetKind): Promise<string> {
  const pool = db.pool("maintenance");
  const result = await initiateReset(
    { pool, keys, throttle: createThrottle({ pool, ring: keys.rateLimit }) },
    { email: user.email, kind },
  );
  if (result.outcome !== "issued") throw new Error(`reset ${result.outcome}`);
  return result.token;
}

async function account(): Promise<{ state: string; credential_epoch: number; open: number }> {
  const result = await db.pool("superuser").query<{
    state: string;
    credential_epoch: number;
    open: number;
  }>(
    `SELECT s.state, s.credential_epoch::int AS credential_epoch,
            (SELECT count(*)::int FROM auth.reset_token t
              WHERE t.user_id = s.user_id AND t.consumed_at IS NULL AND t.superseded_at IS NULL
                AND t.expires_at > now()) AS open
       FROM auth.account_state s WHERE s.user_id = $1`,
    [user.id],
  );
  return result.rows[0]!;
}

beforeAll(async () => {
  db = await prepareDatabase();
  await ensureQueues(db.pool("migration_owner"));
  directory = mkdtempSync(join(tmpdir(), "mykey-reset-race-"));
  const keysDirectory = mkdtempSync(join(directory, "keys-"));
  generateKeyFiles(keysDirectory);
  keys = loadAuthKeys(keysDirectory);
  const hostInstanceId = randomUUID();
  // Run 6.7 (P-122): the record, the processes and the database name one incarnation.
  const backendIncarnation = randomUUID();
  await setIncarnation(db.pool("superuser"), backendIncarnation);
  const gatePath = join(directory, "gate.json");
  writeFileSync(
    gatePath,
    gateText({ hostInstanceId, backendIncarnation, releaseBuild: TEST_BUILD }, "open", 1),
  );
  const api: ApiConfig = {
    baseUrl: TEST_ORIGIN,
    build: TEST_BUILD,
    gatePath,
    hostInstanceId,
    backendIncarnation,
    trustedProxy: "127.0.0.1",
  };
  const tls = { certPath: db.stack.api.certPath, keyPath: db.stack.api.keyPath };
  ca = readFileSync(db.stack.api.certAuthorityPath);
  // Run 6.3 (P-115): an ok capacity record beside the gate file.
  capacity = keepCapacityOk(gatePath);
  processes = [
    await startApiProcess(db.targets.api_runtime, { keysDirectory, api, tls }),
    await startApiProcess(db.targets.api_runtime, { keysDirectory, api, tls }),
  ];
  // An enrolled account, made by the operator and enrolled through process 0.
  const auth = createAuth({ db: drizzle(db.pool("maintenance")), keys, baseURL: TEST_ORIGIN });
  const hash = await (await auth.$context).password.hash(user.password);
  const operator = db.pool("maintenance");
  const created = await operator.query<{ id: string }>(
    `INSERT INTO auth."user" (id, name, email, email_verified) VALUES (gen_random_uuid(), 'Racer', $1, true) RETURNING id`,
    [user.email],
  );
  user.id = created.rows[0]!.id;
  await operator.query(
    "INSERT INTO auth.account (id, account_id, provider_id, user_id, password) VALUES (gen_random_uuid(), $1, 'credential', $2, $3)",
    [user.id, user.id, hash],
  );
  await operator.query(
    "INSERT INTO auth.account_state (user_id, state) VALUES ($1, 'enrollment_pending')",
    [user.id],
  );
  const signedIn = await call(0, "/v1/auth/sign-in/email", {
    email: user.email,
    password: user.password,
  });
  const cookie = sessionCookieOf(signedIn);
  const enrolled = await requestTo(
    { port: processes[0].port, ca },
    "POST",
    "/v1/auth/totp/enroll",
    {
      body: {},
      cookie,
      headers: from(),
    },
  );
  user.seed = OTPAuth.Secret.fromBase32(
    ((await enrolled.json()) as { secret: string }).secret,
  ).bytes;
  const now = new Date();
  const activated = await requestTo(
    { port: processes[0].port, ca },
    "POST",
    "/v1/auth/totp/activate",
    {
      body: { code: codeAt(user.seed, stepAt(now)) },
      cookie,
      headers: { ...from(), "x-test-now": now.toISOString() },
    },
  );
  expect(activated.status).toBe(200);
}, 300_000);

afterAll(async () => {
  capacity?.stop();
  for (const process of processes) await process.kill();
  await db.drop();
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.pool("superuser").query("DELETE FROM app.rate_limit");
});

const statuses = async (responses: Promise<Response>[]): Promise<number[]> =>
  (await Promise.all(responses)).map((response) => response.status).sort((a, b) => a - b);

describe("one redemption across two API processes", () => {
  it(`one password link, two completions released together: exactly one 200 (${String(ROUNDS)} rounds)`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const token = await issue("password");
      const before = (await account()).credential_epoch;
      const now = future();
      const body = {
        token,
        newPassword: `round-${String(round)}-${randomBytes(8).toString("hex")}`,
        code: codeAt(user.seed, stepAt(now)),
      };
      const extra = { "x-test-now": now.toISOString() };
      const answers = await statuses([
        call(0, "/v1/auth/reset/complete", body, extra),
        call(1, "/v1/auth/reset/complete", body, extra),
      ]);
      expect(answers, `round ${String(round)}`).toEqual([200, 401]);
      const after = await account();
      expect(after.credential_epoch - before, `round ${String(round)}`).toBe(1);
      expect(after.state).toBe("active");
      await db.pool("superuser").query("DELETE FROM app.rate_limit");
    }
  });

  it("an initiation racing the completion of the previous link never leaves an active account with an open link", async () => {
    for (let round = 0; round < 10; round += 1) {
      const token = await issue("password");
      const now = future();
      const [completion] = await Promise.all([
        call(
          round % 2 === 0 ? 0 : 1,
          "/v1/auth/reset/complete",
          {
            token,
            newPassword: `race-${String(round)}-${randomBytes(8).toString("hex")}`,
            code: codeAt(user.seed, stepAt(now)),
          },
          { "x-test-now": now.toISOString() },
        ),
        issue("password"),
      ]);
      const after = await account();
      if (completion.status === 200 && after.state === "active") {
        // The completion came last: the new link was superseded? Never — then it must be closed.
        expect(after.open, `round ${String(round)}`).toBe(0);
      } else {
        // Either the old link completed and the new one is open with the account blocked again,
        // or the old one failed because the new one superseded it.
        expect(after.state, `round ${String(round)}`).toBe("recovery_pending");
        expect(after.open, `round ${String(round)}`).toBe(1);
      }
      expect(after.state === "active" && after.open > 0).toBe(false);
      // Back to an active account for the next round.
      const last = await issue("password");
      const next = future();
      const settled = await call(
        0,
        "/v1/auth/reset/complete",
        {
          token: last,
          newPassword: `settle-${String(round)}-${randomBytes(8).toString("hex")}`,
          code: codeAt(user.seed, stepAt(next)),
        },
        { "x-test-now": next.toISOString() },
      );
      expect(settled.status).toBe(200);
      await db.pool("superuser").query("DELETE FROM app.rate_limit");
    }
  });

  it(`an mfa link under the same race: exactly one 200 and one challenge session (${String(ROUNDS)} rounds)`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const token = await issue("mfa");
      const body = { token, newPassword: `mfa-${String(round)}-${randomBytes(8).toString("hex")}` };
      const answers = await statuses([
        call(0, "/v1/auth/reset/complete", body),
        call(1, "/v1/auth/reset/complete", body),
      ]);
      expect(answers, `round ${String(round)}`).toEqual([200, 401]);
      const challenges = await db
        .pool("superuser")
        .query<{ n: number }>(
          "SELECT count(*)::int AS n FROM auth.session WHERE user_id = $1 AND reset_token_id IS NOT NULL",
          [user.id],
        );
      expect(challenges.rows[0]?.n, `round ${String(round)}`).toBe(1);
      await db.pool("superuser").query("DELETE FROM app.rate_limit");
    }
  });
});
