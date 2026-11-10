import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attempt, prepareDatabase, run, type TestDatabase } from "./setup.ts";

const FOREIGN_KEY = "23503";
const CHECK = "23514";

interface Tenant {
  organization: string;
  project: string;
  environment: string;
  member: string;
}

let db: TestDatabase;
let a: Tenant;
let b: Tenant;

async function tenant(label: string): Promise<Tenant> {
  const ids: Tenant = {
    organization: randomUUID(),
    project: randomUUID(),
    environment: randomUUID(),
    member: randomUUID(),
  };
  const pool = db.pool("maintenance");
  await run(pool, "INSERT INTO app.organization (id, namespace, state) VALUES ($1, $2, 'active')", [
    ids.organization,
    `org-${label}`,
  ]);
  await run(
    pool,
    "INSERT INTO app.membership (id, organization_id, user_id, role, state) VALUES ($1, $2, $3, 'member', 'active')",
    [randomUUID(), ids.organization, ids.member],
  );
  await run(
    pool,
    "INSERT INTO app.project (id, organization_id, name, state) VALUES ($1, $2, 'shop', 'active')",
    [ids.project, ids.organization],
  );
  await run(
    pool,
    "INSERT INTO app.environment (id, organization_id, project_id, name, state) VALUES ($1, $2, $3, 'production', 'active')",
    [ids.environment, ids.organization, ids.project],
  );
  return ids;
}

const insertEnvironment =
  "INSERT INTO app.environment (id, organization_id, project_id, name, state) VALUES (gen_random_uuid(), $1, $2, 'staging', 'active')";
const insertSecret =
  "INSERT INTO app.secret_index (environment_id, name, organization_id, state_tag, state, last_changed_at) VALUES ($2, 'API_KEY', $1, 'tag-1', 'live', now())";
const insertCredential = `INSERT INTO app.machine_credential
    (id, organization_id, project_id, environment_id, name, issuance_operation_id, requested_expires_at, state, issued_by)
  VALUES (gen_random_uuid(), $1, $2, $3, 'ci', gen_random_uuid(), now() + interval '1 day', 'issuing', gen_random_uuid())`;
const insertGrant =
  "INSERT INTO app.access_grant (id, organization_id, user_id, project_id, environment_id, role) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'reader')";

beforeAll(async () => {
  db = await prepareDatabase();
  a = await tenant("a");
  b = await tenant("b");
});

afterAll(async () => {
  await db.drop();
});

describe("tenant boundaries are enforced by the database", () => {
  const maintenance = () => db.pool("maintenance");

  it("accepts rows that stay inside one organization", async () => {
    expect(await attempt(maintenance(), insertEnvironment, [a.organization, a.project])).toBe("ok");
    expect(await attempt(maintenance(), insertSecret, [a.organization, a.environment])).toBe("ok");
    expect(
      await attempt(maintenance(), insertCredential, [a.organization, a.project, a.environment]),
    ).toBe("ok");
    expect(
      await attempt(maintenance(), insertGrant, [a.organization, a.member, a.project, null]),
    ).toBe("ok");
    expect(
      await attempt(maintenance(), insertGrant, [a.organization, a.member, null, a.environment]),
    ).toBe("ok");
  });

  it("rejects an environment with A's organization and B's project", async () => {
    expect(await attempt(maintenance(), insertEnvironment, [a.organization, b.project])).toBe(
      FOREIGN_KEY,
    );
  });

  it("rejects a secret index row with A's organization and B's environment", async () => {
    expect(await attempt(maintenance(), insertSecret, [a.organization, b.environment])).toBe(
      FOREIGN_KEY,
    );
  });

  it("rejects a machine credential with A's organization and B's environment", async () => {
    expect(
      await attempt(maintenance(), insertCredential, [a.organization, a.project, b.environment]),
    ).toBe(FOREIGN_KEY);
  });

  it("rejects a grant that names both a project and an environment, or neither", async () => {
    expect(
      await attempt(maintenance(), insertGrant, [
        a.organization,
        a.member,
        a.project,
        a.environment,
      ]),
    ).toBe(CHECK);
    expect(await attempt(maintenance(), insertGrant, [a.organization, a.member, null, null])).toBe(
      CHECK,
    );
  });

  it("rejects a grant for a user who is not a member of that organization", async () => {
    expect(
      await attempt(maintenance(), insertGrant, [a.organization, b.member, a.project, null]),
    ).toBe(FOREIGN_KEY);
    expect(
      await attempt(maintenance(), insertGrant, [a.organization, randomUUID(), a.project, null]),
    ).toBe(FOREIGN_KEY);
  });

  it("rejects a grant in A on B's project or B's environment", async () => {
    expect(
      await attempt(maintenance(), insertGrant, [a.organization, a.member, b.project, null]),
    ).toBe(FOREIGN_KEY);
    expect(
      await attempt(maintenance(), insertGrant, [a.organization, a.member, null, b.environment]),
    ).toBe(FOREIGN_KEY);
  });

  it("allows the same project and environment names in two organizations", async () => {
    const names = await run<{ count: string }>(
      db.pool("superuser"),
      "SELECT count(*) AS count FROM app.environment WHERE name = 'production'",
    );
    expect(names[0]!.count).toBe("2");
  });
});
