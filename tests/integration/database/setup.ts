// Shared set-up for the database suites: a fresh database with the five roles
// and (unless asked otherwise) every migration applied.
import { createHmac } from "node:crypto";
import { ROLE_NAMES, applyRoles, createPool, migrate, type DbTarget } from "@mykey/db";
import pg from "pg";
import { freshDatabase, getSharedStack, type Stack } from "../../harness/stack.ts";

export type RoleName = (typeof ROLE_NAMES)[number];
export type Login = RoleName | "superuser";

export interface TestDatabase {
  stack: Stack;
  database: string;
  superuser: DbTarget;
  targets: Record<RoleName, DbTarget>;
  /** A pool logged in as the given role; `drop()` closes it. */
  pool(login: Login): pg.Pool;
  /** Closes every pool and removes the database. */
  drop(): Promise<void>;
}

/**
 * Roles belong to the whole PostgreSQL server, and the suites share one server
 * and run at the same time. Every suite therefore has to set the same password
 * for a role. The passwords are derived from the stack's random superuser
 * password, so they are synthetic, differ on every stack, and are never printed.
 */
export function rolePasswords(stack: Stack): Record<RoleName, string> {
  const derive = (role: string) =>
    createHmac("sha256", stack.pg.superuser.password).update(`role:${role}`).digest("hex");
  return {
    migration_owner: derive("migration_owner"),
    api_runtime: derive("api_runtime"),
    provisioner_runtime: derive("provisioner_runtime"),
    backup_reader: derive("backup_reader"),
    maintenance: derive("maintenance"),
  };
}

export async function prepareDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const stack = await getSharedStack();
  const fresh = await freshDatabase(stack);
  const base = {
    host: stack.pg.host,
    port: stack.pg.port,
    database: fresh.database,
    caCertPath: stack.pg.caCertPath,
  };
  const superuser: DbTarget = { ...base, ...stack.pg.superuser };
  const passwords = rolePasswords(stack);
  const target = (role: RoleName): DbTarget => ({ ...base, user: role, password: passwords[role] });
  const targets: Record<RoleName, DbTarget> = {
    migration_owner: target("migration_owner"),
    api_runtime: target("api_runtime"),
    provisioner_runtime: target("provisioner_runtime"),
    backup_reader: target("backup_reader"),
    maintenance: target("maintenance"),
  };

  const pools = new Map<Login, pg.Pool>();
  const drop = async () => {
    await Promise.all([...pools.values()].map((pool) => pool.end()));
    pools.clear();
    await fresh.drop();
  };

  try {
    await applyRoles(superuser, passwords);
    if (options.migrate !== false) await migrate(targets.migration_owner);
  } catch (error) {
    await drop();
    throw error;
  }

  return {
    stack,
    database: fresh.database,
    superuser,
    targets,
    pool(login) {
      let pool = pools.get(login);
      if (pool === undefined) {
        pool = createPool(login === "superuser" ? superuser : targets[login], { max: 2 });
        pools.set(login, pool);
      }
      return pool;
    },
    drop,
  };
}

/**
 * Runs one statement in a transaction that is always rolled back.
 * Returns "ok" or the SQLSTATE of the error.
 */
export async function attempt(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(sql, params);
      return "ok";
    } catch (error) {
      if (error instanceof pg.DatabaseError && error.code !== undefined) return error.code;
      throw error;
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
}

/** Runs one statement and keeps its effect. */
export async function run<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const result = await pool.query<Row>(sql, params);
  return result.rows;
}
