// Run 2.9: a database built by hand (roles, CREATE DATABASE, applyDatabaseAccess,
// pg_restore) ends up exactly like one made by migrate(): the same privilege
// matrix holds for both. Skipping applyDatabaseAccess shows.
import { randomBytes } from "node:crypto";
import { applyDatabaseAccess, applyRoles, createPool } from "@mykey/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matrixProblems } from "../../harness/privilege-matrix.ts";
import { copyDatabase } from "../../harness/stack.ts";
import { prepareDatabase, rolePasswords, run, type TestDatabase } from "./setup.ts";

let source: TestDatabase;
const made: string[] = [];

beforeAll(async () => {
  source = await prepareDatabase();
});

afterAll(async () => {
  for (const name of made) {
    await run(source.pool("superuser"), `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
  await source.drop();
});

/** CREATE DATABASE, the roles, optionally applyDatabaseAccess, then pg_restore of the source. */
async function rebuilt(withAccess: boolean): Promise<string> {
  const name = `r_${randomBytes(6).toString("hex")}`;
  made.push(name);
  await run(source.pool("superuser"), `CREATE DATABASE ${name}`);
  const target = { ...source.superuser, database: name };
  await applyRoles(target, rolePasswords(source.stack));
  const pool = createPool(target, { max: 1 });
  try {
    if (withAccess) await applyDatabaseAccess(pool, name);
  } finally {
    await pool.end();
  }
  await copyDatabase(source.stack, source.database, name);
  return name;
}

async function problemsOf(database: string): Promise<string[]> {
  const pool = createPool({ ...source.superuser, database }, { max: 1 });
  try {
    return await matrixProblems(pool);
  } finally {
    await pool.end();
  }
}

describe("database access after a restore", () => {
  it("a migrated database matches the matrix (control)", async () => {
    expect(await matrixProblems(source.pool("superuser"))).toEqual([]);
  });

  it("roles, applyDatabaseAccess and pg_restore give the same result as migrate()", async () => {
    expect(await problemsOf(await rebuilt(true))).toEqual([]);
  });

  it("without applyDatabaseAccess, PUBLIC can connect and the matrix says so", async () => {
    expect(await problemsOf(await rebuilt(false))).toContain(
      "public CONNECT on the database: true",
    );
  });

  it("applyDatabaseAccess can run twice", async () => {
    const pool = createPool(source.superuser, { max: 1 });
    try {
      await applyDatabaseAccess(pool, source.database);
      await applyDatabaseAccess(pool, source.database);
    } finally {
      await pool.end();
    }
    expect(await matrixProblems(source.pool("superuser"))).toEqual([]);
  });
});
