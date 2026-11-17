import { randomUUID } from "node:crypto";
import {
  ENVIRONMENT_NAME_PATTERN,
  LIMITS,
  OPERATION_STATES,
  SECRET_NAME_PATTERN,
} from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attempt, prepareDatabase, run, type TestDatabase } from "./setup.ts";

const UNIQUE = "23505";
const CHECK = "23514";

let db: TestDatabase;
const organization = randomUUID();
const project = randomUUID();
const environment = randomUUID();
const operation = randomUUID();

const insertProject =
  "INSERT INTO app.project (id, organization_id, name, state) VALUES (gen_random_uuid(), $1, $2, $3)";
const insertEnvironment =
  "INSERT INTO app.environment (id, organization_id, project_id, name, state, live_value_bytes) VALUES (gen_random_uuid(), $1, $2, $3, 'active', $4)";
const insertSecret =
  "INSERT INTO app.secret_index (environment_id, name, organization_id, state_tag, state, live_value_bytes, last_changed_at) VALUES ($1, $2, $3, 'tag-1', 'live', $4, now())";
const insertOperation = `INSERT INTO app.operation (id, principal_kind, principal_id, action, target, idempotency_key, state)
  VALUES (gen_random_uuid(), 'user', $1, 'secret.update', 'env/NAME', $2, $3)`;
const insertSlot =
  "INSERT INTO app.effect_slot (scope_key, operation_id, generation, acquired_at) VALUES ($1, $2, 1, now())";

beforeAll(async () => {
  db = await prepareDatabase();
  const pool = db.pool("maintenance");
  await run(
    pool,
    "INSERT INTO app.organization (id, namespace, state) VALUES ($1, 'org-c', 'active')",
    [organization],
  );
  await run(pool, insertProject.replace("gen_random_uuid()", "$4"), [
    organization,
    "shop",
    "active",
    project,
  ]);
  await run(
    pool,
    "INSERT INTO app.environment (id, organization_id, project_id, name, state) VALUES ($1, $2, $3, 'production', 'active')",
    [environment, organization, project],
  );
  await run(
    pool,
    `INSERT INTO app.operation (id, principal_kind, principal_id, action, target, idempotency_key, state)
     VALUES ($1, 'user', 'user-1', 'secret.update', 'env/NAME', 'key-1', 'accepted')`,
    [operation],
  );
  await run(pool, insertSlot, ["env/NAME", operation]);
});

afterAll(async () => {
  await db.drop();
});

describe("database constraints", () => {
  const pool = () => db.pool("maintenance");

  it("service_control has exactly one row and refuses a second", async () => {
    const rows = await run(
      db.pool("superuser"),
      "SELECT id, capture_mode, epoch::text FROM app.service_control",
    );
    expect(rows).toEqual([{ id: true, capture_mode: "idle", epoch: "0" }]);
    expect(await attempt(pool(), "INSERT INTO app.service_control (id) VALUES (true)")).toBe(
      UNIQUE,
    );
    expect(await attempt(pool(), "INSERT INTO app.service_control (id) VALUES (false)")).toBe(
      CHECK,
    );
    expect(await attempt(pool(), "UPDATE app.service_control SET capture_mode = 'paused'")).toBe(
      CHECK,
    );
  });

  it("a second effect slot with the same scope key fails", async () => {
    expect(await attempt(pool(), insertSlot, ["env/OTHER", operation])).toBe("ok");
    expect(await attempt(pool(), insertSlot, ["env/NAME", operation])).toBe(UNIQUE);
  });

  it("a duplicate operation key fails; a different key or principal does not", async () => {
    expect(await attempt(pool(), insertOperation, ["user-1", "key-2", "accepted"])).toBe("ok");
    expect(await attempt(pool(), insertOperation, ["user-2", "key-1", "accepted"])).toBe("ok");
    expect(await attempt(pool(), insertOperation, ["user-1", "key-1", "accepted"])).toBe(UNIQUE);
  });

  it("operation state accepts exactly the seven contract states", async () => {
    for (const state of OPERATION_STATES) {
      expect(await attempt(pool(), insertOperation, ["user-3", "key-1", state]), state).toBe("ok");
    }
    expect(await attempt(pool(), insertOperation, ["user-3", "key-1", "failed"])).toBe(CHECK);
  });

  it("environment names follow the contract pattern", async () => {
    const insert = (name: string) =>
      attempt(pool(), insertEnvironment, [organization, project, name, 0]);
    expect(await insert("staging")).toBe("ok");
    expect(await insert("a".repeat(LIMITS.environment.nameMaxLength))).toBe("ok");
    expect(await insert("a".repeat(LIMITS.environment.nameMaxLength + 1))).toBe(CHECK);
    expect(await insert("Prod")).toBe(CHECK);
    expect(await insert("1st")).toBe(CHECK);
    expect(await insert("")).toBe(CHECK);
    expect(await insert("production")).toBe(UNIQUE);
  });

  it("secret names follow the contract pattern", async () => {
    const insert = (name: string) =>
      attempt(pool(), insertSecret, [environment, name, organization, 0]);
    expect(await insert("API_KEY")).toBe("ok");
    expect(await insert("A".repeat(LIMITS.secret.nameMaxLength))).toBe("ok");
    expect(await insert("A".repeat(LIMITS.secret.nameMaxLength + 1))).toBe(CHECK);
    expect(await insert("lower")).toBe(CHECK);
    expect(await insert("1A")).toBe(CHECK);
  });

  it("the patterns in the database are the patterns in the contracts package", async () => {
    const definitions = await run<{ definition: string }>(
      db.pool("superuser"),
      `SELECT pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'c' AND n.nspname = 'app'`,
    );
    const all = definitions.map((row) => row.definition).join("\n");
    expect(all).toContain(`'${ENVIRONMENT_NAME_PATTERN.source}'`);
    expect(all).toContain(`'${SECRET_NAME_PATTERN.source}'`);
  });

  it("stored sizes are bounded", async () => {
    const secret = (bytes: number) =>
      attempt(pool(), insertSecret, [environment, "SIZE_TEST", organization, bytes]);
    expect(await secret(LIMITS.secret.valueMaxBytes)).toBe("ok");
    expect(await secret(LIMITS.secret.valueMaxBytes + 1)).toBe(CHECK);
    expect(await secret(-1)).toBe(CHECK);
    const env = (bytes: number) =>
      attempt(pool(), insertEnvironment, [organization, project, "sized", bytes]);
    expect(await env(LIMITS.environment.maxLiveValueBytes)).toBe("ok");
    expect(await env(LIMITS.environment.maxLiveValueBytes + 1)).toBe(CHECK);
    expect(await env(-1)).toBe(CHECK);
    expect(
      await attempt(
        pool(),
        "INSERT INTO app.rate_limit (scope, key_digest, window_start, count) VALUES ('s', '\\x00', now(), -1)",
      ),
    ).toBe(CHECK);
  });

  it("project names are 1 to 64 code points in NFC form", async () => {
    const insert = (name: string) => attempt(pool(), insertProject, [organization, name, "active"]);
    const max = LIMITS.project.nameMaxCodePoints;
    expect(await insert("x".repeat(max))).toBe("ok");
    expect(await insert("𝒜".repeat(max))).toBe("ok");
    expect(await insert("x".repeat(max + 1))).toBe(CHECK);
    expect(await insert("")).toBe(CHECK);
    expect(await insert("café")).toBe("ok");
    expect(await insert("café")).toBe(CHECK);
    expect(await insert("shop")).toBe(UNIQUE);
  });

  it("states and roles accept only their listed values", async () => {
    expect(await attempt(pool(), insertProject, [organization, "state-test", "deleted"])).toBe(
      CHECK,
    );
    expect(
      await attempt(
        pool(),
        "INSERT INTO app.organization (id, namespace, state) VALUES (gen_random_uuid(), 'x', 'gone')",
      ),
    ).toBe(CHECK);
    expect(
      await attempt(
        pool(),
        "INSERT INTO app.membership (id, organization_id, user_id, role, state) VALUES (gen_random_uuid(), $1, gen_random_uuid(), 'root', 'active')",
        [organization],
      ),
    ).toBe(CHECK);
    expect(await attempt(pool(), "UPDATE app.environment SET archive_origin = 'other'")).toBe(
      CHECK,
    );
    expect(await attempt(pool(), "UPDATE app.environment SET archive_origin = 'project'")).toBe(
      "ok",
    );
  });

  it("no column could hold a secret value, token or password", async () => {
    const columns = await run<{ column_name: string }>(
      db.pool("superuser"),
      `SELECT table_schema || '.' || table_name || '.' || column_name AS column_name
         FROM information_schema.columns
        WHERE table_schema IN ('app', 'audit')
          AND column_name IN ('token', 'value', 'secret', 'password')`,
    );
    expect(columns).toEqual([]);
    const total = await run<{ count: string }>(
      db.pool("superuser"),
      "SELECT count(*) AS count FROM information_schema.columns WHERE table_schema IN ('app', 'audit')",
    );
    expect(Number(total[0]!.count)).toBeGreaterThan(100);
  });

  it("ids are application-generated uuids, timestamps carry a time zone, nothing lives in public", async () => {
    const ids = await run<{ name: string; data_type: string; column_default: string | null }>(
      db.pool("superuser"),
      `SELECT table_schema || '.' || table_name AS name, data_type, column_default
         FROM information_schema.columns
        WHERE table_schema IN ('app', 'audit') AND column_name = 'id' AND table_name <> 'service_control'`,
    );
    // Run 6.5 (migration 0017): app.backup_invalidation is the fifteenth.
    expect(ids).toHaveLength(15);
    expect(ids.filter((row) => row.data_type !== "uuid" || row.column_default !== null)).toEqual(
      [],
    );

    const naive = await run(
      db.pool("superuser"),
      `SELECT table_schema, table_name, column_name FROM information_schema.columns
        WHERE table_schema IN ('app', 'audit', 'meta') AND data_type = 'timestamp without time zone'`,
    );
    expect(naive).toEqual([]);

    const inPublic = await run(
      db.pool("superuser"),
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S', 'v', 'm', 'i')`,
    );
    expect(inPublic).toEqual([]);
  });
});
