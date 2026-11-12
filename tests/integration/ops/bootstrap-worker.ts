// A child process for tests/integration/ops/bootstrap.test.ts: runs one
// owner bootstrap as `maintenance`, optionally dying (exit 137) right after
// statement number `crashAt`. Reads one JSON line (the settings, with the
// password) from stdin, then waits for a line "go" before it starts, so two
// workers can be released together. Prints one JSON line: the result.
import { createInterface } from "node:readline";
import { createAuth, ephemeralKeys } from "@mykey/auth";
import { bootstrapOwner } from "@mykey/auth/operator";
import { connectionConfig, type DbTarget } from "@mykey/db";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

interface Settings {
  target: DbTarget;
  email: string;
  password: string;
  crashAt: number | null;
}

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const first = await lines.next();
const settings = JSON.parse(String(first.value)) as Settings;
const pool = new pg.Pool({ ...connectionConfig(settings.target), max: 1 });
const auth = createAuth({
  db: drizzle(pool),
  keys: ephemeralKeys(),
  baseURL: "https://mykey.test",
});
// Connect before the release, so both workers start their work together.
await pool.query("SELECT 1");
await lines.next();

let count = 0;
const crashAt = (): void => {
  count += 1;
  if (settings.crashAt !== null && count === settings.crashAt) process.exit(137);
};
try {
  const result = await bootstrapOwner(
    { auth, pool, crashAt },
    { email: settings.email, password: settings.password },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ error: error instanceof Error ? error.constructor.name : "unknown" })}\n`,
  );
} finally {
  await pool.end();
}
process.exit(0);
