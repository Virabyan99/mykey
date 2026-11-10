// Checks that the committed migrations match the Drizzle schema files.
//
// It runs `drizzle-kit generate` against a temporary copy of the migrations
// directory and reports every file that the run added or changed. The working
// tree is never touched, so the check also works with uncommitted work.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DB_PACKAGE = resolve(import.meta.dirname, "../packages/db");
const MIGRATIONS = join(DB_PACKAGE, "migrations");
const DRIZZLE_KIT = join(DB_PACKAGE, "node_modules/drizzle-kit/bin.cjs");
// drizzle-kit resolves its output directory against the package directory and
// cannot take an absolute path, so the copy lives inside the package, in a
// directory that Git, ESLint and Prettier already ignore.
const WORK_ROOT = join(DB_PACKAGE, "node_modules/.cache");

/** What drizzle-kit prints when it ran to the end. Its exit code is 0 even when it crashes. */
const NO_CHANGE = "No schema changes, nothing to migrate";
const WROTE_MIGRATION = "Your SQL migration file";

function listFiles(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(directory, path).replaceAll("\\", "/"), readFileSync(path, "utf8"));
  }
  return files;
}

/**
 * Returns the files a fresh `drizzle-kit generate` would add or change, as
 * paths inside the migrations directory. An empty list means no drift.
 * Throws when drizzle-kit did not run to the end.
 */
export function findSchemaDrift(migrationsDir: string = MIGRATIONS): string[] {
  mkdirSync(WORK_ROOT, { recursive: true });
  const copy = mkdtempSync(join(WORK_ROOT, "mykey-db-check-"));
  try {
    cpSync(migrationsDir, copy, { recursive: true });
    const before = listFiles(copy);
    const result = spawnSync(process.execPath, [DRIZZLE_KIT, "generate"], {
      cwd: DB_PACKAGE,
      encoding: "utf8",
      env: {
        ...process.env,
        MYKEY_DRIZZLE_OUT: `./${relative(DB_PACKAGE, copy).replaceAll("\\", "/")}`,
      },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const finished = output.includes(NO_CHANGE) || output.includes(WROTE_MIGRATION);
    if (result.status !== 0 || !finished) {
      throw new Error(`drizzle-kit generate did not finish:\n${output}`);
    }
    const drift: string[] = [];
    for (const [path, content] of listFiles(copy)) {
      if (before.get(path) !== content) drift.push(path);
    }
    if (drift.length === 0 && !output.includes(NO_CHANGE)) {
      throw new Error(`drizzle-kit reported a new migration but no file changed:\n${output}`);
    }
    return drift.sort();
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const drift = findSchemaDrift();
  if (drift.length > 0) {
    console.error(
      "The Drizzle schema and the committed migrations differ. A fresh generate would write:",
    );
    for (const path of drift) console.error(`  ${path}`);
    console.error("Run: pnpm run db:generate, review the new SQL, and commit it.");
    process.exit(1);
  }
  console.log("db: migrations match the schema.");
}
