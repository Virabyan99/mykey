// The expected-grants matrix of the database (Session 1, extended in Run 2.3)
// and one function that checks a database against it. Shared by
// tests/integration/database/privileges.test.ts and, for a restored database,
// by the backup tests (Run 2.9).
import type pg from "pg";

export const S = "SELECT";
export const I = "INSERT";
export const U = "UPDATE";
export const D = "DELETE";

export const RUNTIME_ROLES = ["api_runtime", "provisioner_runtime", "backup_reader", "maintenance"];
export const GRANTEES = [...RUNTIME_ROLES, "public"];
export const TABLE_PRIVILEGES = [S, I, U, D, "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
export const SCHEMAS = ["app", "audit", "auth", "jobs", "meta"];

/** Columns `api_runtime` may never update, in addition to primary-key columns. */
export const IDENTITY_COLUMNS = [
  "id",
  "organization_id",
  "project_id",
  "environment_id",
  "namespace",
  "lock_key",
  "created_at",
];
export const OPERATION_KEY_COLUMNS = [
  "principal_kind",
  "principal_id",
  "action",
  "target",
  "idempotency_key",
];

export interface Expected {
  api: string[];
  provisioner: string[];
  /** Columns `provisioner_runtime` may update without table-level UPDATE. */
  provisionerColumns?: string[];
  /** Columns `api_runtime` may update in schema auth without table-level UPDATE. */
  apiColumns?: string[];
  /** Table privileges of `maintenance` where they differ from the schema default (Run 3.1, P-45). */
  maintenance?: string[];
  /** Columns `maintenance` may update without table-level UPDATE. */
  maintenanceColumns?: string[];
}

/**
 * The job queue (pg-boss, migration 0004). The tables are pg-boss's own; the
 * runtime roles get exactly the rights their statements were seen to need
 * (Run 3.1 Task A), and nothing by column.
 */
const JOB_TABLES: Record<string, Expected> = {
  "jobs.version": { api: [S], provisioner: [S] },
  "jobs.queue": { api: [S], provisioner: [S] },
  "jobs.schedule": { api: [], provisioner: [] },
  "jobs.subscription": { api: [], provisioner: [] },
  "jobs.bam": { api: [], provisioner: [] },
  "jobs.job": { api: [S, I], provisioner: [S, U, D] },
  "jobs.job_common": { api: [S, I], provisioner: [S, U, D] },
  "jobs.warning": { api: [], provisioner: [] },
  "jobs.queue_stats": { api: [], provisioner: [] },
  "jobs.job_dependency": { api: [], provisioner: [] },
  "jobs.instance": { api: [], provisioner: [] },
};

/**
 * The expected-grants matrix. Every table in the database must be listed here;
 * a new table without an entry fails the sweep.
 */
export const TABLES: Record<string, Expected> = {
  "app.organization": {
    api: [S, I],
    provisioner: [S],
    provisionerColumns: ["state", "config_digest", "provisioning_operation_id", "review_reason"],
  },
  "app.membership": { api: [S, I], provisioner: [] },
  "app.project": { api: [S, I], provisioner: [S], provisionerColumns: ["state", "review_reason"] },
  "app.environment": {
    api: [S, I],
    provisioner: [S],
    provisionerColumns: ["state", "kv_ready", "policy_digest", "review_reason"],
  },
  "app.access_grant": { api: [S, I], provisioner: [] },
  "app.secret_index": { api: [S, I], provisioner: [] },
  "app.secret_version_event": { api: [S, I], provisioner: [] },
  "app.machine_credential": { api: [S, I], provisioner: [] },
  "app.operation": { api: [S, I], provisioner: [S, I, U] },
  "app.operation_tombstone": { api: [S, I], provisioner: [] },
  "app.operation_step": { api: [S, I], provisioner: [S, I, U] },
  "app.effect_slot": { api: [S, I, D], provisioner: [S, I, D] },
  "app.outbox": { api: [S, I], provisioner: [S, I, U] },
  "app.import_preview": { api: [S, I, D], provisioner: [] },
  "app.import_entry": { api: [S, I], provisioner: [] },
  "app.service_control": { api: [S, I], provisioner: [] },
  "app.backup_pair": { api: [S, I], provisioner: [] },
  "app.rate_limit": { api: [S, I, D], provisioner: [] },
  "audit.event": { api: [S, I], provisioner: [I], maintenance: [S, I, D] },
  "meta.schema_migration": { api: [], provisioner: [] },
  // Schema auth (Run 2.3): the session library's tables and the second factor.
  // UPDATE by column as in app; never id, user_id, created_at, a stored verifier
  // or a session's authenticated_at.
  // maintenance (Run 3.1, P-45): the owner bootstrap and the operator reset.
  // Run 3.2 (migration 0005): only maintenance creates users and credential accounts.
  "auth.user": {
    api: [S, D],
    provisioner: [],
    apiColumns: ["name", "email", "email_verified", "image", "updated_at"],
    maintenance: [S, I],
  },
  "auth.session": {
    api: [S, I, D],
    provisioner: [],
    maintenance: [S, D],
    apiColumns: [
      "expires_at",
      "ip_address",
      "user_agent",
      "updated_at",
      "phase",
      "auth_epoch",
      "last_user_activity_at",
      "totp_verified_at",
      "enrollment_id",
    ],
  },
  "auth.account": {
    api: [S, D],
    provisioner: [],
    apiColumns: ["password", "updated_at"],
    maintenance: [S, I],
  },
  "auth.verification": {
    api: [S, I, D],
    provisioner: [],
    apiColumns: ["value", "expires_at", "updated_at"],
  },
  "auth.account_state": {
    api: [S, I, D],
    provisioner: [],
    apiColumns: ["state", "auth_epoch", "credential_epoch", "updated_at"],
    maintenance: [S, I],
    maintenanceColumns: ["state", "auth_epoch", "credential_epoch", "updated_at"],
  },
  "auth.totp_enrollment": {
    api: [S, I, D],
    provisioner: [],
    apiColumns: ["seed_jwe", "key_id", "state", "activated_at"],
  },
  // Written once: a used step is never changed or removed by the API; the
  // operator's clean-up removes old ones (Run 3.5, migration 0006).
  "auth.totp_step_used": { api: [S, I], provisioner: [], maintenance: [S, D] },
  "auth.recovery_code": {
    api: [S, I],
    provisioner: [],
    apiColumns: ["consumed_at", "consumed_by_session"],
    maintenance: [S, D],
  },
  // Run 3.6 (D-30): the operator issues and supersedes, the API consumes.
  "auth.reset_token": {
    api: [S],
    provisioner: [],
    apiColumns: ["verifier", "consumed_at"],
    maintenance: [S, I],
    maintenanceColumns: ["verifier", "superseded_at"],
  },
  ...JOB_TABLES,
};

/**
 * pg-boss keeps queue statistics in one partition per day, named
 * `queue_stats_YYYYMMDD`; migration 0004 creates today's and tomorrow's. Each
 * such partition has the rights of its parent.
 */
const DAILY_PARTITION = /^jobs\.queue_stats_[0-9]{8}$/;

/** The matrix entry a table is checked against. */
export function matrixName(table: string): string {
  return DAILY_PARTITION.test(table) ? "jobs.queue_stats" : table;
}

export function expectedTablePrivileges(table: string, grantee: string): string[] {
  const expected = TABLES[matrixName(table)];
  if (expected === undefined) throw new Error(`table ${table} is not in the matrix`);
  const schema = table.split(".")[0];
  switch (grantee) {
    case "api_runtime":
      return expected.api;
    case "provisioner_runtime":
      return expected.provisioner;
    case "backup_reader":
      return [S];
    case "maintenance":
      if (expected.maintenance !== undefined) return expected.maintenance;
      if (schema === "app") return [S, I, U, D];
      if (table === "audit.event") return [S, D];
      return [S];
    default:
      return [];
  }
}

export interface ColumnRow {
  table: string;
  column: string;
  primary_key: boolean;
}

export function expectedColumnUpdate(row: ColumnRow, grantee: string): boolean {
  if (expectedTablePrivileges(row.table, grantee).includes(U)) return true;
  if (grantee === "provisioner_runtime") {
    return TABLES[matrixName(row.table)]?.provisionerColumns?.includes(row.column) ?? false;
  }
  if (grantee === "maintenance") {
    return TABLES[matrixName(row.table)]?.maintenanceColumns?.includes(row.column) ?? false;
  }
  if (grantee === "api_runtime" && row.table.startsWith("auth.")) {
    return TABLES[matrixName(row.table)]?.apiColumns?.includes(row.column) ?? false;
  }
  if (grantee === "api_runtime" && row.table.startsWith("app.")) {
    if (row.primary_key || IDENTITY_COLUMNS.includes(row.column)) return false;
    if (row.table === "app.operation" && OPERATION_KEY_COLUMNS.includes(row.column)) return false;
    return true;
  }
  return false;
}

export const SCHEMA_USAGE: Record<string, string[]> = {
  api_runtime: ["app", "audit", "auth", "jobs"],
  provisioner_runtime: ["app", "audit", "jobs"],
  backup_reader: SCHEMAS,
  maintenance: SCHEMAS,
  public: [],
};

/**
 * Every way the connected database differs from the matrix: the table list and
 * owners, table and column privileges, schema usage, and database-level
 * CONNECT / CREATE / TEMP. Empty when the database is as migrate() leaves it.
 * `pool` must be logged in as a superuser of that database.
 */
export async function matrixProblems(pool: pg.Pool): Promise<string[]> {
  const problems: string[] = [];
  const query = async <Row extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    (await pool.query<Row>(sql, params)).rows;

  const tables = await query<{ name: string; owner: string }>(
    `SELECT n.nspname || '.' || c.relname AS name, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY 1`,
  );
  const listed = new Set(Object.keys(TABLES));
  for (const table of tables) {
    if (!listed.has(matrixName(table.name)))
      problems.push(`table not in the matrix: ${table.name}`);
    if (table.owner !== "migration_owner") problems.push(`owner of ${table.name}: ${table.owner}`);
  }
  for (const name of listed) {
    if (!tables.some((table) => table.name === name)) problems.push(`table missing: ${name}`);
  }

  const tableRows = await query<{
    table: string;
    grantee: string;
    privilege: string;
    granted: boolean;
  }>(
    `SELECT t AS "table", g AS grantee, p AS privilege, has_table_privilege(g, t, p) AS granted
       FROM unnest($1::text[]) AS t, unnest($2::text[]) AS g, unnest($3::text[]) AS p`,
    [
      tables.map((table) => table.name).filter((name) => listed.has(matrixName(name))),
      GRANTEES,
      TABLE_PRIVILEGES,
    ],
  );
  for (const row of tableRows) {
    if (row.granted !== expectedTablePrivileges(row.table, row.grantee).includes(row.privilege)) {
      problems.push(`${row.grantee} ${row.privilege} ${row.table}: granted=${String(row.granted)}`);
    }
  }

  const columns = await query<ColumnRow>(
    `SELECT n.nspname || '.' || c.relname AS "table", a.attname AS "column",
            EXISTS (SELECT 1 FROM pg_index i
                     WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS primary_key
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r' AND n.nspname = ANY ($1::text[])`,
    [SCHEMAS],
  );
  const columnRows = await query<{
    table: string;
    column: string;
    grantee: string;
    granted: boolean;
  }>(
    `SELECT c.t AS "table", c.col AS "column", g AS grantee,
            has_column_privilege(g, c.t, c.col, 'UPDATE') AS granted
       FROM unnest($1::text[], $2::text[]) AS c(t, col), unnest($3::text[]) AS g`,
    [columns.map((row) => row.table), columns.map((row) => row.column), GRANTEES],
  );
  const primaryKey = new Map(columns.map((row) => [`${row.table}.${row.column}`, row.primary_key]));
  for (const row of columnRows) {
    if (!listed.has(matrixName(row.table))) continue;
    const expected = expectedColumnUpdate(
      {
        table: row.table,
        column: row.column,
        primary_key: primaryKey.get(`${row.table}.${row.column}`) ?? false,
      },
      row.grantee,
    );
    if (row.granted !== expected) {
      problems.push(
        `${row.grantee} UPDATE ${row.table}.${row.column}: granted=${String(row.granted)}`,
      );
    }
  }

  const schemas = await query<{ schema: string; grantee: string; usage: boolean; create: boolean }>(
    `SELECT s AS schema, g AS grantee,
            has_schema_privilege(g, s, 'USAGE') AS usage, has_schema_privilege(g, s, 'CREATE') AS "create"
       FROM unnest($1::text[]) AS s, unnest($2::text[]) AS g`,
    [[...SCHEMAS, "public"], GRANTEES],
  );
  for (const row of schemas) {
    const usage = (SCHEMA_USAGE[row.grantee] ?? []).includes(row.schema);
    if (row.usage !== usage)
      problems.push(`${row.grantee} USAGE on schema ${row.schema}: ${String(row.usage)}`);
    if (row.create) problems.push(`${row.grantee} CREATE on schema ${row.schema}`);
  }

  const database = await query<{
    grantee: string;
    connect: boolean;
    create: boolean;
    temp: boolean;
  }>(
    `SELECT g AS grantee,
            has_database_privilege(g, current_database(), 'CONNECT') AS connect,
            has_database_privilege(g, current_database(), 'CREATE') AS "create",
            has_database_privilege(g, current_database(), 'TEMP') AS temp
       FROM unnest($1::text[]) AS g`,
    [GRANTEES],
  );
  for (const row of database) {
    if (row.connect !== (row.grantee !== "public")) {
      problems.push(`${row.grantee} CONNECT on the database: ${String(row.connect)}`);
    }
    if (row.create || row.temp) problems.push(`${row.grantee} CREATE or TEMP on the database`);
  }
  return problems;
}
