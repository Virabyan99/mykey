import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyRoles } from "@mykey/db";
import {
  attempt,
  prepareDatabase,
  rolePasswords,
  run,
  type Login,
  type TestDatabase,
} from "./setup.ts";
import {
  GRANTEES,
  I,
  IDENTITY_COLUMNS,
  RUNTIME_ROLES,
  S,
  SCHEMAS,
  SCHEMA_USAGE,
  TABLE_PRIVILEGES,
  TABLES,
  U,
  expectedColumnUpdate,
  expectedTablePrivileges,
  matrixName,
  type ColumnRow,
} from "../../harness/privilege-matrix.ts";

const DENIED = "42501";

let db: TestDatabase;
const organizationId = randomUUID();

beforeAll(async () => {
  db = await prepareDatabase();
  await run(
    db.pool("superuser"),
    "INSERT INTO app.organization (id, namespace, state) VALUES ($1, 'org-a', 'active')",
    [organizationId],
  );
});

afterAll(async () => {
  await db.drop();
});

const auditInsert =
  "INSERT INTO audit.event (id, actor_kind, action, outcome) VALUES (gen_random_uuid(), 'system', 'test', 'ok')";
const projectInsert =
  "INSERT INTO app.project (id, organization_id, name, state) VALUES (gen_random_uuid(), $1, 'made-by-test', 'active')";

type Case = [login: Login, what: string, sql: string, expected: string, params?: unknown[]];

const CASES: Case[] = [
  ["api_runtime", "inserts a project", projectInsert, "ok", [organizationId]],
  ["api_runtime", "selects projects", "SELECT * FROM app.project", "ok"],
  [
    "api_runtime",
    "updates an organization's state",
    "UPDATE app.organization SET state = 'active'",
    "ok",
  ],
  ["api_runtime", "renames a project", "UPDATE app.project SET name = 'renamed'", "ok"],
  [
    "api_runtime",
    "uses the lock-key sequence",
    "SELECT nextval('app.environment_lock_key_seq')",
    "ok",
  ],
  ["api_runtime", "inserts an audit event", auditInsert, "ok"],
  ["api_runtime", "selects audit events", "SELECT * FROM audit.event", "ok"],
  ["api_runtime", "deletes effect slots", "DELETE FROM app.effect_slot", "ok"],
  ["api_runtime", "deletes import previews", "DELETE FROM app.import_preview", "ok"],
  ["api_runtime", "deletes rate-limit rows", "DELETE FROM app.rate_limit", "ok"],
  ["api_runtime", "cannot create a table in app", "CREATE TABLE app.x ()", DENIED],
  ["api_runtime", "cannot create a table in public", "CREATE TABLE public.x ()", DENIED],
  ["api_runtime", "cannot create a temporary table", "CREATE TEMPORARY TABLE x ()", DENIED],
  ["api_runtime", "cannot create a schema", "CREATE SCHEMA x", DENIED],
  ["api_runtime", "cannot alter a table", "ALTER TABLE app.project ADD COLUMN x integer", DENIED],
  ["api_runtime", "cannot drop a table", "DROP TABLE app.rate_limit", DENIED],
  [
    "api_runtime",
    "cannot change a namespace",
    "UPDATE app.organization SET namespace = 'x'",
    DENIED,
  ],
  [
    "api_runtime",
    "cannot move a project to another organization",
    "UPDATE app.project SET organization_id = gen_random_uuid()",
    DENIED,
  ],
  [
    "api_runtime",
    "cannot change an operation's key",
    "UPDATE app.operation SET idempotency_key = 'x'",
    DENIED,
  ],
  ["api_runtime", "cannot update audit events", "UPDATE audit.event SET action = 'x'", DENIED],
  ["api_runtime", "cannot delete audit events", "DELETE FROM audit.event", DENIED],
  ["api_runtime", "cannot truncate audit events", "TRUNCATE audit.event", DENIED],
  [
    "api_runtime",
    "cannot read the migration history",
    "SELECT * FROM meta.schema_migration",
    DENIED,
  ],
  ["api_runtime", "cannot delete projects", "DELETE FROM app.project", DENIED],
  ["api_runtime", "cannot truncate projects", "TRUNCATE app.project CASCADE", DENIED],

  [
    "provisioner_runtime",
    "marks an environment's store ready",
    "UPDATE app.environment SET kv_ready = true",
    "ok",
  ],
  [
    "provisioner_runtime",
    "updates an organization's state",
    "UPDATE app.organization SET state = 'active'",
    "ok",
  ],
  ["provisioner_runtime", "selects operations", "SELECT * FROM app.operation", "ok"],
  ["provisioner_runtime", "deletes effect slots", "DELETE FROM app.effect_slot", "ok"],
  ["provisioner_runtime", "inserts an audit event", auditInsert, "ok"],
  ["provisioner_runtime", "cannot read the secret index", "SELECT * FROM app.secret_index", DENIED],
  ["provisioner_runtime", "cannot read memberships", "SELECT * FROM app.membership", DENIED],
  [
    "provisioner_runtime",
    "cannot read machine credentials",
    "SELECT * FROM app.machine_credential",
    DENIED,
  ],
  [
    "provisioner_runtime",
    "cannot rename an environment",
    "UPDATE app.environment SET name = 'x'",
    DENIED,
  ],
  [
    "provisioner_runtime",
    "cannot change a namespace",
    "UPDATE app.organization SET namespace = 'x'",
    DENIED,
  ],
  ["provisioner_runtime", "cannot insert a project", projectInsert, DENIED, [organizationId]],
  ["provisioner_runtime", "cannot read audit events", "SELECT * FROM audit.event", DENIED],
  ["provisioner_runtime", "cannot delete audit events", "DELETE FROM audit.event", DENIED],
  ["provisioner_runtime", "cannot create a table in app", "CREATE TABLE app.x ()", DENIED],
  ["provisioner_runtime", "cannot create a table in auth", "CREATE TABLE auth.x ()", DENIED],
  ["api_runtime", "cannot delete a used TOTP step", "DELETE FROM auth.totp_step_used", DENIED],
  [
    "api_runtime",
    "cannot rewrite a recovery code's verifier",
    "UPDATE auth.recovery_code SET verifier = verifier",
    DENIED,
  ],
  [
    "api_runtime",
    "marks a recovery code consumed (control)",
    "UPDATE auth.recovery_code SET consumed_at = now() WHERE consumed_at IS NULL",
    "ok",
  ],
  ["api_runtime", "removes sessions (control)", "DELETE FROM auth.session", "ok"],
  [
    "api_runtime",
    "cannot rewrite a session's verifier",
    "UPDATE auth.session SET token = token",
    DENIED,
  ],
  [
    "api_runtime",
    "updates a session's phase (control)",
    "UPDATE auth.session SET phase = phase",
    "ok",
  ],
  ["maintenance", "reads sessions", "SELECT * FROM auth.session", "ok"],
  // Run 3.1 (P-45): the operator bootstrap and reset run as maintenance.
  ["maintenance", "removes sessions", "DELETE FROM auth.session", "ok"],
  ["maintenance", "cannot change a session", "UPDATE auth.session SET phase = phase", DENIED],
  [
    "maintenance",
    "inserts a user",
    "INSERT INTO auth.user (id, name, email) VALUES (gen_random_uuid(), 'n', 'maintenance-case@example.invalid')",
    "ok",
  ],
  [
    "maintenance",
    "changes an account's state and epochs",
    "UPDATE auth.account_state SET state = state, auth_epoch = auth_epoch, credential_epoch = credential_epoch, updated_at = now()",
    "ok",
  ],
  [
    "maintenance",
    "cannot change a stored password",
    "UPDATE auth.account SET password = password",
    DENIED,
  ],
  ["maintenance", "cannot remove a user", "DELETE FROM auth.user", DENIED],
  ["maintenance", "inserts an audit event", auditInsert, "ok"],
  ["api_runtime", "cannot create a table in jobs", "CREATE TABLE jobs.x ()", DENIED],
  ["provisioner_runtime", "cannot create a table in jobs", "CREATE TABLE jobs.x ()", DENIED],
  ["api_runtime", "cannot remove a queue", "DELETE FROM jobs.queue", DENIED],
  ["provisioner_runtime", "cannot remove a queue", "DELETE FROM jobs.queue", DENIED],
  [
    "provisioner_runtime",
    "cannot alter a table",
    "ALTER TABLE app.environment ADD COLUMN x integer",
    DENIED,
  ],

  ["backup_reader", "cannot insert a project", projectInsert, DENIED, [organizationId]],
  [
    "backup_reader",
    "cannot update an organization",
    "UPDATE app.organization SET state = 'active'",
    DENIED,
  ],
  ["backup_reader", "cannot delete audit events", "DELETE FROM audit.event", DENIED],
  ["backup_reader", "cannot insert an audit event", auditInsert, DENIED],
  [
    "backup_reader",
    "cannot advance a sequence",
    "SELECT nextval('app.environment_lock_key_seq')",
    DENIED,
  ],
  ["backup_reader", "cannot create a table", "CREATE TABLE app.x ()", DENIED],
  ["backup_reader", "cannot alter a table", "ALTER TABLE app.project ADD COLUMN x integer", DENIED],

  ["maintenance", "deletes audit events", "DELETE FROM audit.event", "ok"],
  ["maintenance", "selects audit events", "SELECT * FROM audit.event", "ok"],
  ["maintenance", "deletes projects", "DELETE FROM app.project", "ok"],
  ["maintenance", "reads the migration history", "SELECT * FROM meta.schema_migration", "ok"],
  ["maintenance", "cannot update audit events", "UPDATE audit.event SET action = 'x'", DENIED],
  ["maintenance", "cannot truncate audit events", "TRUNCATE audit.event", DENIED],
  [
    "maintenance",
    "cannot change the migration history",
    "DELETE FROM meta.schema_migration",
    DENIED,
  ],
  ["maintenance", "cannot create a table", "CREATE TABLE app.x ()", DENIED],
  ["maintenance", "cannot alter a table", "ALTER TABLE app.project ADD COLUMN x integer", DENIED],
];

describe("role privileges", () => {
  it.each(CASES)("%s %s", async (login, _what, sql, expected, params) => {
    expect(await attempt(db.pool(login), sql, params ?? [])).toBe(expected);
  });

  it("backup_reader selects from every table and reads every sequence", async () => {
    for (const table of Object.keys(TABLES)) {
      expect(await attempt(db.pool("backup_reader"), `SELECT * FROM ${table}`), table).toBe("ok");
    }
    expect(
      await attempt(
        db.pool("backup_reader"),
        "SELECT last_value FROM app.environment_lock_key_seq",
      ),
    ).toBe("ok");
  });

  it("a role with no grants cannot connect to the database", async () => {
    const role = `t_nogrant_${randomBytes(6).toString("hex")}`;
    const password = randomBytes(18).toString("hex");
    // The role name and password are hex strings generated above, so they are safe to inline.
    await run(db.pool("superuser"), `CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    try {
      const client = new pg.Client({
        host: db.superuser.host,
        port: db.superuser.port,
        database: db.database,
        user: role,
        password,
        ssl: { ca: readFileSync(db.superuser.caCertPath, "utf8"), rejectUnauthorized: true },
      });
      const failure = await client.connect().then(
        () => client.end().then(() => "connected"),
        (error: unknown) => (error instanceof pg.DatabaseError ? error.code : String(error)),
      );
      expect(failure).toBe(DENIED);
    } finally {
      await run(db.pool("superuser"), `DROP ROLE ${role}`);
    }
  });
});

describe("catalog sweep", () => {
  it("every table is in the expected-grants matrix and is owned by migration_owner", async () => {
    const tables = await run<{ name: string; owner: string }>(
      db.pool("superuser"),
      `SELECT n.nspname || '.' || c.relname AS name, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
        ORDER BY 1`,
    );
    // A daily partition of pg-boss's queue statistics counts as its parent.
    expect([...new Set(tables.map((table) => matrixName(table.name)))].sort()).toEqual(
      Object.keys(TABLES).sort(),
    );
    expect(tables.filter((table) => table.owner !== "migration_owner")).toEqual([]);
  });

  it("table privileges equal the matrix for every role and for PUBLIC", async () => {
    const rows = await run<{ table: string; grantee: string; privilege: string; granted: boolean }>(
      db.pool("superuser"),
      `SELECT t AS "table", g AS grantee, p AS privilege, has_table_privilege(g, t, p) AS granted
         FROM unnest($1::text[]) AS t, unnest($2::text[]) AS g, unnest($3::text[]) AS p`,
      [Object.keys(TABLES), GRANTEES, TABLE_PRIVILEGES],
    );
    expect(rows).toHaveLength(
      Object.keys(TABLES).length * GRANTEES.length * TABLE_PRIVILEGES.length,
    );
    const wrong = rows
      .filter(
        (row) =>
          row.granted !== expectedTablePrivileges(row.table, row.grantee).includes(row.privilege),
      )
      .map((row) => `${row.grantee} ${row.privilege} ${row.table}: granted=${String(row.granted)}`);
    expect(wrong).toEqual([]);
  });

  it("column privileges equal the matrix: UPDATE by column, nothing else by column", async () => {
    const columns = await run<ColumnRow>(
      db.pool("superuser"),
      `SELECT n.nspname || '.' || c.relname AS "table", a.attname AS "column",
              EXISTS (SELECT 1 FROM pg_index i
                       WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)) AS primary_key
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r' AND n.nspname = ANY ($1::text[])`,
      [SCHEMAS],
    );
    expect(columns.length).toBeGreaterThan(100);

    const granted = await run<{
      table: string;
      column: string;
      grantee: string;
      privilege: string;
      granted: boolean;
    }>(
      db.pool("superuser"),
      `SELECT c.t AS "table", c.col AS "column", g AS grantee, p AS privilege,
              has_column_privilege(g, c.t, c.col, p) AS granted
         FROM unnest($1::text[], $2::text[]) AS c(t, col),
              unnest($3::text[]) AS g,
              unnest($4::text[]) AS p`,
      [
        columns.map((row) => row.table),
        columns.map((row) => row.column),
        GRANTEES,
        [S, I, U, "REFERENCES"],
      ],
    );
    const primaryKey = new Map(
      columns.map((row) => [`${row.table}.${row.column}`, row.primary_key]),
    );
    const wrong = granted
      .filter((row) => {
        const column = {
          table: row.table,
          column: row.column,
          primary_key: primaryKey.get(`${row.table}.${row.column}`) ?? false,
        };
        const expected =
          row.privilege === U
            ? expectedColumnUpdate(column, row.grantee)
            : expectedTablePrivileges(row.table, row.grantee).includes(row.privilege);
        return row.granted !== expected;
      })
      .map(
        (row) =>
          `${row.grantee} ${row.privilege} ${row.table}.${row.column}: granted=${String(row.granted)}`,
      );
    expect(wrong).toEqual([]);

    // The rule must leave api_runtime something to update, and must protect the identity columns.
    const apiUpdatable = columns.filter((row) => expectedColumnUpdate(row, "api_runtime"));
    expect(apiUpdatable.map((row) => `${row.table}.${row.column}`)).toEqual(
      expect.arrayContaining(["app.project.name", "app.environment.state", "app.operation.state"]),
    );
    expect(apiUpdatable.filter((row) => IDENTITY_COLUMNS.includes(row.column))).toEqual([]);
  });

  it("schema, database and sequence privileges are the least each role needs", async () => {
    const usage = SCHEMA_USAGE;
    const schemas = await run<{ schema: string; grantee: string; usage: boolean; create: boolean }>(
      db.pool("superuser"),
      `SELECT s AS schema, g AS grantee,
              has_schema_privilege(g, s, 'USAGE') AS usage, has_schema_privilege(g, s, 'CREATE') AS "create"
         FROM unnest($1::text[]) AS s, unnest($2::text[]) AS g`,
      [[...SCHEMAS, "public"], GRANTEES],
    );
    expect(schemas).toHaveLength(6 * GRANTEES.length);
    for (const row of schemas) {
      const label = `${row.grantee} on schema ${row.schema}`;
      expect(row.usage, `${label} USAGE`).toBe(usage[row.grantee]!.includes(row.schema));
      expect(row.create, `${label} CREATE`).toBe(false);
    }

    const owners = await run<{ kind: string; name: string; owner: string }>(
      db.pool("superuser"),
      `SELECT 'schema' AS kind, nspname AS name, pg_get_userbyid(nspowner) AS owner
         FROM pg_namespace WHERE nspname = ANY ($1::text[])
       UNION ALL
       SELECT 'database', datname, pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()`,
      [SCHEMAS],
    );
    expect(owners).toHaveLength(SCHEMAS.length + 1);
    expect(owners.filter((row) => row.owner !== "migration_owner")).toEqual([]);

    const database = await run<{
      grantee: string;
      connect: boolean;
      create: boolean;
      temp: boolean;
    }>(
      db.pool("superuser"),
      `SELECT g AS grantee,
              has_database_privilege(g, current_database(), 'CONNECT') AS connect,
              has_database_privilege(g, current_database(), 'CREATE') AS "create",
              has_database_privilege(g, current_database(), 'TEMP') AS temp
         FROM unnest($1::text[]) AS g`,
      [GRANTEES],
    );
    expect(database).toEqual(
      GRANTEES.map((grantee) => ({
        grantee,
        connect: grantee !== "public",
        create: false,
        temp: false,
      })),
    );

    const sequence = await run<{ grantee: string; usage: boolean; read: boolean; update: boolean }>(
      db.pool("superuser"),
      `SELECT g AS grantee,
              has_sequence_privilege(g, 'app.environment_lock_key_seq', 'USAGE') AS usage,
              has_sequence_privilege(g, 'app.environment_lock_key_seq', 'SELECT') AS read,
              has_sequence_privilege(g, 'app.environment_lock_key_seq', 'UPDATE') AS update
         FROM unnest($1::text[]) AS g`,
      [GRANTEES],
    );
    expect(sequence).toEqual([
      { grantee: "api_runtime", usage: true, read: false, update: false },
      { grantee: "provisioner_runtime", usage: false, read: false, update: false },
      { grantee: "backup_reader", usage: false, read: true, update: false },
      { grantee: "maintenance", usage: true, read: false, update: false },
      { grantee: "public", usage: false, read: false, update: false },
    ]);
  });

  it("the five roles cannot escalate: no superuser, no role or database creation, no RLS bypass", async () => {
    const roles = await run<{ rolname: string; flags: string }>(
      db.pool("superuser"),
      `SELECT rolname,
              concat_ws(',', CASE WHEN rolsuper THEN 'super' END, CASE WHEN rolcreatedb THEN 'createdb' END,
                        CASE WHEN rolcreaterole THEN 'createrole' END, CASE WHEN rolbypassrls THEN 'bypassrls' END,
                        CASE WHEN rolreplication THEN 'replication' END, CASE WHEN rolcanlogin THEN 'login' END) AS flags
         FROM pg_roles WHERE rolname = ANY ($1::text[]) ORDER BY rolname`,
      [[...RUNTIME_ROLES, "migration_owner"]],
    );
    expect(roles).toEqual(
      [...RUNTIME_ROLES, "migration_owner"].sort().map((rolname) => ({ rolname, flags: "login" })),
    );
    const memberships = await run(
      db.pool("superuser"),
      `SELECT 1 FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.member OR r.oid = m.roleid
        WHERE r.rolname = ANY ($1::text[])`,
      [[...RUNTIME_ROLES, "migration_owner"]],
    );
    expect(memberships).toEqual([]);
  });

  it("future tables: backup_reader can read them, api_runtime gets DML only in auth", async () => {
    const owner = db.pool("migration_owner");
    await run(owner, "CREATE TABLE auth.future_table (id integer PRIMARY KEY)");
    await run(owner, "CREATE TABLE app.future_table (id integer PRIMARY KEY)");
    await run(owner, "CREATE TABLE jobs.future_table (id integer PRIMARY KEY)");
    await run(
      owner,
      "CREATE FUNCTION app.future_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
    );
    try {
      for (const schema of ["auth", "app", "jobs"]) {
        expect(
          await attempt(db.pool("backup_reader"), `SELECT * FROM ${schema}.future_table`),
          schema,
        ).toBe("ok");
        expect(
          await attempt(db.pool("backup_reader"), `DELETE FROM ${schema}.future_table`),
          schema,
        ).toBe(DENIED);
      }
      const api = db.pool("api_runtime");
      expect(await attempt(api, "INSERT INTO auth.future_table VALUES (1)")).toBe("ok");
      expect(await attempt(api, "DELETE FROM auth.future_table")).toBe("ok");
      expect(await attempt(api, "SELECT * FROM app.future_table")).toBe(DENIED);
      expect(await attempt(api, "SELECT * FROM jobs.future_table")).toBe(DENIED);
      expect(await attempt(api, "SELECT app.future_function()")).toBe(DENIED);
      expect(await attempt(db.pool("provisioner_runtime"), "SELECT * FROM app.future_table")).toBe(
        DENIED,
      );
    } finally {
      await run(owner, "DROP FUNCTION app.future_function()");
      for (const schema of ["auth", "app", "jobs"])
        await run(owner, `DROP TABLE ${schema}.future_table`);
    }
  });
});

describe("applyRoles", () => {
  it("stores SCRAM verifiers, never a plain password", async () => {
    const stored = await run<{ rolname: string; rolpassword: string }>(
      db.pool("superuser"),
      "SELECT rolname, rolpassword FROM pg_authid WHERE rolname = ANY ($1::text[])",
      [[...RUNTIME_ROLES, "migration_owner"]],
    );
    expect(stored).toHaveLength(5);
    const passwords = rolePasswords(db.stack);
    for (const row of stored) {
      expect(row.rolpassword, row.rolname).toMatch(
        /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
      );
      expect(row.rolpassword).not.toContain(passwords[row.rolname as keyof typeof passwords]);
    }
  });

  it("can run twice at the same time, and again later, without error", async () => {
    const passwords = rolePasswords(db.stack);
    await Promise.all([applyRoles(db.superuser, passwords), applyRoles(db.superuser, passwords)]);
    await applyRoles(db.superuser, passwords);
    expect(await attempt(db.pool("api_runtime"), "SELECT 1")).toBe("ok");
  });

  it("refuses a short or non-ASCII password and changes nothing", async () => {
    const passwords = rolePasswords(db.stack);
    await expect(applyRoles(db.superuser, { ...passwords, maintenance: "short" })).rejects.toThrow(
      /maintenance/,
    );
    await expect(
      applyRoles(db.superuser, { ...passwords, api_runtime: `${"p".repeat(20)}é` }),
    ).rejects.toThrow(/api_runtime/);
    const client = await db.pool("maintenance").connect();
    client.release();
  });
});
