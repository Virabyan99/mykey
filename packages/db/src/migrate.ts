// The migrator. It applies the SQL files of one directory in name order, each
// in its own transaction together with its history row, and refuses to continue
// when an already-applied file has changed.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { connectionConfig, type DbTarget } from "./pool.ts";

export const MIGRATIONS_DIR = resolve(import.meta.dirname, "../migrations");

/** One fixed key: only one migrator runs in a database at a time. */
const ADVISORY_LOCK_KEY = "6072834561927105";

const BOOTSTRAP_SQL = `
  CREATE SCHEMA IF NOT EXISTS meta;
  CREATE TABLE IF NOT EXISTS meta.schema_migration (
    name text PRIMARY KEY,
    sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text NOT NULL
  );
`;

export class MigrationChecksumMismatch extends Error {
  readonly migration: string;

  constructor(migration: string) {
    super(
      `migration ${migration} was changed after it was applied; applied migrations are never edited`,
    );
    this.name = "MigrationChecksumMismatch";
    this.migration = migration;
  }
}

interface MigrationFile {
  name: string;
  sql: string;
  sha256: string;
}

function readMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(dir, name));
      return {
        name,
        sql: bytes.toString("utf8"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
}

/** Compares the directory with the recorded history. Returns the files still to apply. */
function pendingMigrations(
  files: MigrationFile[],
  history: Map<string, string>,
  dir: string,
): MigrationFile[] {
  const byName = new Map(files.map((file) => [file.name, file]));
  for (const name of history.keys()) {
    if (!byName.has(name)) {
      throw new Error(`applied migration ${name} is missing from ${dir}`);
    }
  }
  for (const file of files) {
    const recorded = history.get(file.name);
    if (recorded !== undefined && recorded !== file.sha256) {
      throw new MigrationChecksumMismatch(file.name);
    }
  }
  const lastApplied = [...history.keys()].sort().at(-1);
  const pending = files.filter((file) => !history.has(file.name));
  for (const file of pending) {
    if (lastApplied !== undefined && file.name < lastApplied) {
      throw new Error(
        `migration ${file.name} is out of order: ${lastApplied} was already applied after it`,
      );
    }
  }
  return pending;
}

async function apply(client: pg.Client, file: MigrationFile): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(file.sql);
    await client.query(
      "INSERT INTO meta.schema_migration (name, sha256, applied_by) VALUES ($1, $2, current_user)",
      [file.name, file.sha256],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`migration ${file.name} failed and was rolled back: ${reason}`, {
      cause: error,
    });
  }
}

/**
 * Applies every pending migration of `opts.dir` (default: this package's
 * `migrations` directory) as `owner`, which must be `migration_owner`.
 */
export async function migrate(
  owner: DbTarget,
  opts: { dir?: string } = {},
): Promise<{ applied: string[]; alreadyApplied: string[] }> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const files = readMigrations(dir);
  const client = new pg.Client(connectionConfig(owner));
  await client.connect();
  try {
    // A session lock on this one connection, held for the whole run. If the
    // process dies, the server releases it when the connection closes.
    await client.query("SELECT pg_advisory_lock($1::bigint)", [ADVISORY_LOCK_KEY]);
    try {
      await client.query(BOOTSTRAP_SQL);
      const recorded = await client.query<{ name: string; sha256: string }>(
        "SELECT name, sha256 FROM meta.schema_migration",
      );
      const history = new Map(recorded.rows.map((row) => [row.name, row.sha256]));
      const pending = pendingMigrations(files, history, dir);
      const applied: string[] = [];
      for (const file of pending) {
        await apply(client, file);
        applied.push(file.name);
      }
      return { applied, alreadyApplied: [...history.keys()].sort() };
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1::bigint)", [ADVISORY_LOCK_KEY])
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}
