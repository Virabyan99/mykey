// The child-process entry of `startApiProcess` (tests/harness/api-worker.ts):
// one real API process on a given database and key directory, built the way
// `startServer` builds it. Reads one JSON line of settings from stdin and
// prints one line `{"port":<n>}` when it listens. Test harness only.
import { createInterface } from "node:readline";
import { createApp, createHealthCheck, listen, type ApiConfig } from "@mykey/api";
import { createAuth, createThrottle, loadAuthKeys } from "@mykey/auth";
import { createPool, type DbTarget } from "@mykey/db";
import { drizzle } from "drizzle-orm/node-postgres";

interface Settings {
  database: DbTarget;
  keysDirectory: string;
  api: ApiConfig;
  tls: { certPath: string; keyPath: string };
}

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const first = await lines.next();
const settings = JSON.parse(String(first.value)) as Settings;

const pool = createPool(settings.database, { max: 10 });
const health = createHealthCheck(settings.database);
const keys = loadAuthKeys(settings.keysDirectory);
const auth = createAuth({ db: drizzle(pool), keys, baseURL: settings.api.baseUrl });
const app = createApp({
  pool,
  config: settings.api,
  health: () => health.check(),
  log: () => undefined,
  auth: { auth, keys, throttle: createThrottle({ pool, ring: keys.rateLimit }) },
});
const server = await listen(app, { hostname: "127.0.0.1", port: 0, tls: settings.tls });
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);

const stop = (): void => {
  void server
    .close()
    .then(() => health.close())
    .then(() => pool.end())
    .finally(() => process.exit(0));
};
process.once("SIGTERM", stop);
// The parent closing stdin is the other way to stop.
void lines.next().then(stop);
