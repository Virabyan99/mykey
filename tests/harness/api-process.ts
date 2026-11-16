// The child-process entry of `startApiProcess` (tests/harness/api-worker.ts):
// one real API process on a given database and key directory, built the way
// `startServer` builds it. Reads one JSON line of settings from stdin and
// prints one line `{"port":<n>}` when it listens. Test harness only.
//
// Run 4.2: with `runtime` it holds the organization's runtime identity and a
// lock pool; with `fault` the secret protocol meets one fault at one point:
// `crash` (SIGKILL of this process), `hang` (never returns), `throw`, or
// `terminate_lock` (the lock connection is terminated by PostgreSQL).
//
// Run 5.3: with `archiveTick` it runs the tick's archive driver
// (`continueArchives`) every `intervalMs`, as the API's sweep does.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  createApp,
  createHealthCheck,
  issuerBaoFromDirectory,
  listen,
  capacityPathOf,
  runtimeBaoFromDirectory,
  type ApiConfig,
} from "@mykey/api";
import { createAuth, createThrottle, loadAuthKeys } from "@mykey/auth";
import { createPool, type DbTarget } from "@mykey/db";
import type { OpenBaoTarget } from "@mykey/openbao";
import { continueArchives, readCapacity } from "@mykey/operations";
import { drizzle } from "drizzle-orm/node-postgres";
import { testLimiter, type RateLimitsMode } from "./rate.ts";

export type FaultAction = "crash" | "hang" | "throw" | "terminate_lock";

interface Settings {
  database: DbTarget;
  keysDirectory: string;
  api: ApiConfig;
  tls: { certPath: string; keyPath: string };
  runtime?: { openBao: OpenBaoTarget; secretsDirectory: string };
  fault?: { point: string; action: FaultAction };
  archiveTick?: { intervalMs: number; staleSeconds: number };
  rateLimits?: RateLimitsMode;
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

const bootId = randomUUID();
const issuer =
  settings.runtime === undefined
    ? undefined
    : issuerBaoFromDirectory(settings.runtime.openBao, settings.runtime.secretsDirectory);
const app = createApp({
  pool,
  ...(lockPool === undefined ? {} : { lockPool }),
  ...(settings.runtime === undefined || issuer === undefined
    ? {}
    : {
        bao: runtimeBaoFromDirectory(settings.runtime.openBao, settings.runtime.secretsDirectory),
        issuer,
      }),
  bootId,
  config: settings.api,
  health: () => health.check(),
  // Log lines go to stderr, so a test can search them for values (rule 2).
  log: (entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  },
  limiter: testLimiter(pool, keys.rateLimit, settings.rateLimits),
  // P-115: the parent test API writes the record beside the shared gate file.
  capacity: { read: (nowMs) => readCapacity(capacityPathOf(settings.api.gatePath), nowMs) },
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

const tick = settings.archiveTick;
let ticking = false;
const timer =
  tick === undefined || issuer === undefined || lockPool === undefined
    ? undefined
    : setInterval(() => {
        if (ticking) return;
        ticking = true;
        continueArchives(
          {
            pool,
            lockPool,
            issuer,
            bootId,
            ...(fault === undefined ? {} : { faults: (point: string) => meet(point) }),
          },
          { staleSeconds: tick.staleSeconds },
        )
          .catch((error: unknown) => {
            const line = { event: "archive_tick_failed", error: String(error) };
            process.stderr.write(`${JSON.stringify(line)}\n`);
          })
          .finally(() => {
            ticking = false;
          });
      }, tick.intervalMs);

const stop = (): void => {
  if (timer !== undefined) clearInterval(timer);
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
