// A child process of race.test.ts: its own connection pool and its own Better
// Auth instance over the shared test database. It reads one JSON command per
// line on stdin and answers one JSON line on stdout. A command carries `at`, a
// wall-clock time: the worker waits until then, so both workers start the
// same elevation at the same moment.
import { createInterface } from "node:readline";
import {
  createAuth,
  elevateWithRecoveryCode,
  elevateWithTotp,
  type AuthKeys,
  type FactorDeps,
  type KeyRing,
} from "@mykey/auth";
import { connectionConfig, type DbTarget } from "@mykey/db";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

interface WireRing {
  current: string;
  keys: Record<string, string>;
}
type Command =
  | {
      init: { target: DbTarget; baseURL: string; keys: Record<string, WireRing | string> };
    }
  | { id: number; op: "totp" | "recovery"; token: string; code: string; now: number; at: number }
  | { exit: true };

const ring = (wire: WireRing): KeyRing => ({
  current: wire.current,
  keys: Object.fromEntries(
    Object.entries(wire.keys).map(([id, key]) => [id, new Uint8Array(Buffer.from(key, "base64"))]),
  ),
});

const reply = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

let deps: FactorDeps | undefined;
let pool: pg.Pool | undefined;

for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line) as Command;
  if ("exit" in command) break;
  if ("init" in command) {
    const wire = command.init.keys;
    const keys: AuthKeys = {
      cookieSecret: wire.cookieSecret as string,
      sessionLookup: ring(wire.sessionLookup as WireRing),
      seedEncryption: ring(wire.seedEncryption as WireRing),
      recoveryVerifier: ring(wire.recoveryVerifier as WireRing),
    };
    pool = new pg.Pool({ ...connectionConfig(command.init.target), max: 2 });
    deps = {
      pool,
      keys,
      auth: createAuth({ db: drizzle(pool), keys, baseURL: command.init.baseURL }),
    };
    // Warm one connection, so the first round does not measure connection set-up.
    await pool.query("SELECT 1");
    reply({ ready: true });
    continue;
  }
  if (deps === undefined) throw new Error("race-worker: no init");
  while (Date.now() < command.at) await new Promise((resolve) => setTimeout(resolve, 1));
  const input = { sessionToken: command.token, code: command.code, now: new Date(command.now) };
  try {
    const result =
      command.op === "totp"
        ? await elevateWithTotp(deps, input)
        : await elevateWithRecoveryCode(deps, input);
    reply({ id: command.id, ok: result.ok, reason: result.ok ? null : result.reason });
  } catch (error) {
    reply({ id: command.id, ok: false, reason: `error: ${(error as Error).message}` });
  }
}
await pool?.end();
// stdin stays open while the parent lives; the worker ends here on its own.
process.exit(0);
