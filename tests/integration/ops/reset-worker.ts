// A child process for tests/integration/ops/reset.test.ts: one operator reset
// initiation as `maintenance`, dying (exit 137) right after statement number
// `crashAt`. Reads one JSON line of settings from stdin; prints one JSON line
// (the outcome only, never the token).
import { createInterface } from "node:readline";
import { createThrottle, type AuthKeys, type KeyRing } from "@mykey/auth";
import { initiateReset } from "@mykey/auth/operator";
import { connectionConfig, type DbTarget } from "@mykey/db";
import pg from "pg";

interface WireRing {
  current: string;
  keys: Record<string, string>;
}

interface Settings {
  target: DbTarget;
  email: string;
  kind: "password" | "mfa";
  crashAt: number | null;
  rateLimit: WireRing;
  resetVerifier: WireRing;
}

const ring = (wire: WireRing): KeyRing => ({
  current: wire.current,
  keys: Object.fromEntries(
    Object.entries(wire.keys).map(([id, key]) => [id, new Uint8Array(Buffer.from(key, "base64"))]),
  ),
});

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const settings = JSON.parse(String((await lines.next()).value)) as Settings;
const pool = new pg.Pool({ ...connectionConfig(settings.target), max: 2 });
const keys = { resetVerifier: ring(settings.resetVerifier) } as AuthKeys;
let count = 0;
try {
  const result = await initiateReset(
    {
      pool,
      keys,
      throttle: createThrottle({ pool, ring: ring(settings.rateLimit) }),
      crashAt: () => {
        count += 1;
        if (settings.crashAt !== null && count === settings.crashAt) process.exit(137);
      },
    },
    { email: settings.email, kind: settings.kind },
  );
  process.stdout.write(`${JSON.stringify({ outcome: result.outcome })}\n`);
} finally {
  await pool.end();
}
process.exit(0);
