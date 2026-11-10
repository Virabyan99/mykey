import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MigrationChecksumMismatch, migrate } from "@mykey/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { findSchemaDrift } from "../../../scripts/db-check.ts";
import { prepareDatabase, run, type TestDatabase } from "./setup.ts";

const root = resolve(import.meta.dirname, "../../..");
const migrationsDir = join(root, "packages/db/migrations");
const fixtures = join(root, "tests/fixtures/migrations");

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

const databases: TestDatabase[] = [];
const directories: string[] = [];

async function emptyDatabase(): Promise<TestDatabase> {
  const db = await prepareDatabase({ migrate: false });
  databases.push(db);
  return db;
}

/** A private copy of a fixture directory, so a test can edit the files. */
function workingCopy(fixture: string): string {
  const directory = mkdtempSync(join(tmpdir(), "mykey-migrations-"));
  directories.push(directory);
  for (const name of readdirSync(join(fixtures, fixture))) {
    if (name.endsWith(".sql")) cpSync(join(fixtures, fixture, name), join(directory, name));
  }
  return directory;
}

async function history(db: TestDatabase): Promise<{ name: string; sha256: string }[]> {
  return run<{ name: string; sha256: string }>(
    db.pool("superuser"),
    "SELECT name, sha256 FROM meta.schema_migration ORDER BY name",
  );
}

async function relationExists(db: TestDatabase, name: string): Promise<boolean> {
  const rows = await run<{ found: boolean }>(
    db.pool("superuser"),
    "SELECT to_regclass($1) IS NOT NULL AS found",
    [name],
  );
  return rows[0]!.found;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

afterAll(async () => {
  await Promise.all(databases.map((db) => db.drop()));
});

describe("migrate", () => {
  it("fresh database applies all migrations and records name + sha256", async () => {
    expect(migrationFiles.length).toBeGreaterThanOrEqual(2);
    expect(migrationFiles[0]).toMatch(/^0000_.+\.sql$/);
    expect(migrationFiles[1]).toBe("0001_grants.sql");

    const db = await emptyDatabase();
    const result = await migrate(db.targets.migration_owner);

    expect(result).toEqual({ applied: migrationFiles, alreadyApplied: [] });
    expect(await history(db)).toEqual(
      migrationFiles.map((name) => ({ name, sha256: sha256(join(migrationsDir, name)) })),
    );
    const appliedBy = await run<{ applied_by: string }>(
      db.pool("superuser"),
      "SELECT DISTINCT applied_by FROM meta.schema_migration",
    );
    expect(appliedBy).toEqual([{ applied_by: "migration_owner" }]);
  });

  it("second run applies nothing", async () => {
    const db = await emptyDatabase();
    await migrate(db.targets.migration_owner);
    const second = await migrate(db.targets.migration_owner);
    expect(second).toEqual({ applied: [], alreadyApplied: migrationFiles });
    expect(await history(db)).toHaveLength(migrationFiles.length);
  });

  it("two migrators started together both resolve and each migration is recorded once", async () => {
    const db = await emptyDatabase();
    const [first, second] = await Promise.all([
      migrate(db.targets.migration_owner),
      migrate(db.targets.migration_owner),
    ]);
    expect([...first.applied, ...second.applied].sort()).toEqual(migrationFiles);
    expect([first.applied.length, second.applied.length].sort()).toEqual([
      0,
      migrationFiles.length,
    ]);
    expect((await history(db)).map((row) => row.name)).toEqual(migrationFiles);
  });

  it("an edited applied migration throws MigrationChecksumMismatch", async () => {
    const db = await emptyDatabase();
    const dir = workingCopy("tampered");
    const original = sha256(join(dir, "0000_first.sql"));
    expect(await migrate(db.targets.migration_owner, { dir })).toEqual({
      applied: ["0000_first.sql"],
      alreadyApplied: [],
    });

    cpSync(join(fixtures, "tampered/edited/0000_first.sql"), join(dir, "0000_first.sql"));
    expect(sha256(join(dir, "0000_first.sql"))).not.toBe(original);

    const failure = await migrate(db.targets.migration_owner, { dir }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MigrationChecksumMismatch);
    expect((failure as MigrationChecksumMismatch).migration).toBe("0000_first.sql");
    expect(await history(db)).toEqual([{ name: "0000_first.sql", sha256: original }]);
    expect(await relationExists(db, "fx.edited")).toBe(false);
  });

  it("a migration with failing SQL leaves no partial objects and no history row, and succeeds after the file is fixed", async () => {
    const db = await emptyDatabase();
    const dir = workingCopy("broken");

    await expect(migrate(db.targets.migration_owner, { dir })).rejects.toThrow(/0001_second\.sql/);
    expect((await history(db)).map((row) => row.name)).toEqual(["0000_first.sql"]);
    expect(await relationExists(db, "fx.first")).toBe(true);
    expect(await relationExists(db, "fx.second")).toBe(false);

    cpSync(join(fixtures, "broken/fixed/0001_second.sql"), join(dir, "0001_second.sql"));
    expect(await migrate(db.targets.migration_owner, { dir })).toEqual({
      applied: ["0001_second.sql"],
      alreadyApplied: ["0000_first.sql"],
    });
    expect(await relationExists(db, "fx.second")).toBe(true);
  });

  it("refuses a directory that does not match the recorded history", async () => {
    const db = await emptyDatabase();
    const dir = workingCopy("broken");
    cpSync(join(fixtures, "broken/fixed/0001_second.sql"), join(dir, "0001_second.sql"));
    await migrate(db.targets.migration_owner, { dir });

    // A new file that sorts before an applied one would run out of order.
    cpSync(join(fixtures, "tampered/edited/0000_first.sql"), join(dir, "0000_earlier.sql"));
    await expect(migrate(db.targets.migration_owner, { dir })).rejects.toThrow(/out of order/);
    expect(await relationExists(db, "fx.edited")).toBe(false);
    rmSync(join(dir, "0000_earlier.sql"));

    // An applied migration whose file has disappeared.
    rmSync(join(dir, "0000_first.sql"));
    await expect(migrate(db.targets.migration_owner, { dir })).rejects.toThrow(/missing/);
    expect(await history(db)).toHaveLength(2);
  });

  it("schema matches Drizzle: generating again produces no change", () => {
    expect(findSchemaDrift()).toEqual([]);
  });

  it("the drift check reports a schema the migrations do not cover", () => {
    // A copy of the migrations whose latest snapshot has lost one table: to
    // drizzle-kit the schema files now contain a table no migration created.
    const doctored = mkdtempSync(join(tmpdir(), "mykey-migrations-"));
    directories.push(doctored);
    cpSync(migrationsDir, doctored, { recursive: true });
    const latest = String(migrationFiles.length - 1).padStart(4, "0");
    const next = String(migrationFiles.length).padStart(4, "0");
    const snapshotFile = join(doctored, "meta", `${latest}_snapshot.json`);
    const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8")) as {
      tables: Record<string, unknown>;
    };
    expect(snapshot.tables["app.rate_limit"]).toBeDefined();
    delete snapshot.tables["app.rate_limit"];
    writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));

    const drift = findSchemaDrift(doctored);
    expect(drift).toContain("meta/_journal.json");
    expect(
      drift.filter((path) => path.startsWith(`${next}_`) && path.endsWith(".sql")),
    ).toHaveLength(1);
  });
});
