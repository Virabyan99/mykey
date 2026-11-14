// The child-process entry of `startApiProcess` (tests/harness/api-worker.ts):
// one real API process on a given database and key directory, built the way
// `startServer` builds it. Reads one JSON line of settings from stdin and
// prints one line `{"port":<n>}` when it listens. Test harness only.
//
// Run 4.2: with `runtime` it holds the organization's runtime identity and a
// lock pool; with `fault` the secret protocol meets one fault at one point:
// `crash` (SIGKILL of this process), `hang` (never returns), `throw`, or
// `terminate_lock` (the lock connection is terminated by PostgreSQL).
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  createApp,
  createHealthCheck,
  listen,
  runtimeBaoFromDirectory,
  type ApiConfig,
} from "@mykey/api";
import { createAuth, createThrottle, loadAuthKeys } from "@mykey/auth";
import { createPool, type DbTarget } from "@mykey/db";
import type { OpenBaoTarget } from "@mykey/openbao";
import { drizzle } from "drizzle-orm/node-postgres";

export type FaultAction = "crash" | "hang" | "throw" | "terminate_lock";

interface Settings {
  database: DbTarget;
  keysDirectory: string;
  api: ApiConfig;
  tls: { certPath: string; keyPath: string };
  runtime?: { openBao: OpenBaoTarget; secretsDirectory: string };
  fault?: { point: string; action: FaultAction };
}

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const first = await lines.next();
const settings = JSON.parse(String(first.value)) as Settings;

const pool = createPool(settings.database, { max: 10 });
const lockPool =
  settings.runtime === undefined ? undefined : createPool(settings.database, { max: 8 });
const health = createHealthCheck(settings.database);
const keys = loadAuthKeys(settings.keysDirectory);
const auth = createAuth({ db: drizzle(pool), keys, baseURL: settings.api.baseUrl });
const fault = settings.fault;

async function meet(point: string): Promise<void> {
  if (fault?.point !== point) return;
  switch (fault.action) {
    case "crash":
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => undefined);
      return;
    case "hang":
      await new Promise(() => undefined);
      return;
    case "throw":
      throw new Error("fault");
    case "terminate_lock":
      await pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()
            AND pid IN (SELECT pid FROM pg_stat_activity WHERE usename = current_user)`,
      );
      return;
  }
}

const app = createApp({
  pool,
  ...(lockPool === undefined ? {} : { lockPool }),
  ...(settings.runtime === undefined
    ? {}
    : {
        bao: runtimeBaoFromDirectory(settings.runtime.openBao, settings.runtime.secretsDirectory),
      }),
  bootId: randomUUID(),
  config: settings.api,
  health: () => health.check(),
  // Log lines go to stderr, so a test can search them for values (rule 2).
  log: (entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  },
  auth: { auth, keys, throttle: createThrottle({ pool, ring: keys.rateLimit }) },
  // TOTP codes are checked at the time a test sends (Run 3.4), as in tests/harness/api.ts.
  test: {
    clock: (headers: Headers) => {
      const value = headers.get("x-test-now");
      return value === null ? undefined : new Date(value);
    },
    ...(fault === undefined ? {} : { faults: (point: string) => meet(point) }),
  },
});
const server = await listen(app, { hostname: "127.0.0.1", port: 0, tls: settings.tls });
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);

const stop = (): void => {
  void server
    .close()
    .then(() => health.close())
    .then(() => pool.end())
    .then(() => lockPool?.end())
    .finally(() => process.exit(0));
};
process.once("SIGTERM", stop);
// The parent closing stdin is the other way to stop.
void lines.next().then(stop);
