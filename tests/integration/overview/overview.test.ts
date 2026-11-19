// Run 7.3 (P-139, FR-1.90, AC-1.46): the organization's overview. Projects
// with their environments and key counts, read from the index at one database
// time, for owners and admins only. A count that was not made is null, never 0.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSecretsFixture, type SecretsFixture } from "../../harness/secrets-fixture.ts";
import type { FixtureUser } from "../../harness/tenants.ts";

let f: SecretsFixture;
const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

interface Keys {
  live: number;
  deleted: number;
  needsReview: number;
}
interface EnvironmentRow {
  id: string;
  name: string;
  state: string;
  reviewReason: string | null;
  kvReady: boolean;
  changedAt: string | null;
  keys: Keys | null;
}
interface ProjectRow {
  id: string;
  name: string;
  state: string;
  reviewReason: string | null;
  environments: EnvironmentRow[];
}

const overview = (user: FixtureUser = "ownerA", organizationId = f.tenants.a.organizationId) =>
  f.send("GET", `/v1/organizations/${organizationId}/overview`, { user, key: null });

const environmentOf = (projects: ProjectRow[], id: string): EnvironmentRow | undefined =>
  projects.flatMap((project) => project.environments).find((row) => row.id === id);

/** The index, counted directly as the superuser. */
async function directCounts(): Promise<Map<string, Keys & { changedAt: string | null }>> {
  const rows = await f.api.superuser.query<{
    environment_id: string;
    live: string;
    deleted: string;
    needs_review: string;
    changed_at: Date | null;
  }>(
    `SELECT environment_id,
            count(*) FILTER (WHERE state = 'live') AS live,
            count(*) FILTER (WHERE state = 'deleted') AS deleted,
            count(*) FILTER (WHERE state = 'needs_review') AS needs_review,
            max(last_changed_at) AS changed_at
       FROM app.secret_index WHERE organization_id = $1 GROUP BY environment_id`,
    [f.tenants.a.organizationId],
  );
  return new Map(
    rows.rows.map((row) => [
      row.environment_id,
      {
        live: Number(row.live),
        deleted: Number(row.deleted),
        needsReview: Number(row.needs_review),
        changedAt: row.changed_at === null ? null : row.changed_at.toISOString(),
      },
    ]),
  );
}

beforeAll(async () => {
  f = await createSecretsFixture();
  const name = (): string => `OV_${randomBytes(5).toString("hex").toUpperCase()}`;
  // env1a: three live, one deleted, one under review; env1b: one live; env2a: none.
  for (let i = 0; i < 4; i += 1) {
    const created = await f.create("env1a", name(), `${mark}-${randomUUID()}`);
    expect(created.status, created.text).toBe(201);
  }
  const gone = name();
  const made = await f.create("env1a", gone, `${mark}-${randomUUID()}`);
  expect(made.status, made.text).toBe(201);
  const row = await f.api.superuser.query<{ current_version: number; state_tag: string }>(
    "SELECT current_version, state_tag FROM app.secret_index WHERE environment_id = $1 AND name = $2",
    [f.tenants.a.env1a, gone],
  );
  const deleted = await f.act("env1a", gone, "delete", {
    version: row.rows[0]!.current_version,
    stateTag: row.rows[0]!.state_tag,
  });
  expect(deleted.status, deleted.text).toBe(200);
  await f.api.superuser.query(
    `UPDATE app.secret_index SET state = 'needs_review'
      WHERE (environment_id, name) IN (
        SELECT environment_id, name FROM app.secret_index
         WHERE environment_id = $1 AND state = 'live' ORDER BY name LIMIT 1)`,
    [f.tenants.a.env1a],
  );
  const other = await f.create("env1b", name(), `${mark}-${randomUUID()}`);
  expect(other.status, other.text).toBe(201);
}, 600_000);

afterAll(async () => {
  await f.close();
});

describe("overview.get", () => {
  it("owner and admin get the organization's projects and environments with counts equal to a direct count of app.secret_index; a member gets 403 action_denied; ownerB gets the hidden 404", async () => {
    const before = Date.now();
    const answer = await overview();
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.source).toBe("index");
    expect(answer.body.truncated).toBe(false);
    const observedAt = Date.parse(answer.body.observedAt as string);
    expect(observedAt).toBeGreaterThan(before - 5000);
    expect(observedAt).toBeLessThan(Date.now() + 5000);

    const projects = answer.body.projects as ProjectRow[];
    const stored = await f.api.superuser.query<{ id: string; name: string; state: string }>(
      "SELECT id, name, state FROM app.project WHERE organization_id = $1 ORDER BY id",
      [f.tenants.a.organizationId],
    );
    expect(projects.map((p) => ({ id: p.id, name: p.name, state: p.state }))).toEqual(stored.rows);
    const environments = await f.api.superuser.query<{ id: string; project_id: string }>(
      "SELECT id, project_id FROM app.environment WHERE organization_id = $1 ORDER BY id",
      [f.tenants.a.organizationId],
    );
    for (const project of projects) {
      expect(project.environments.map((row) => row.id)).toEqual(
        environments.rows.filter((row) => row.project_id === project.id).map((row) => row.id),
      );
    }

    const direct = await directCounts();
    expect(direct.get(f.tenants.a.env1a)).toMatchObject({ live: 3, deleted: 1, needsReview: 1 });
    for (const row of projects.flatMap((project) => project.environments)) {
      const counted = direct.get(row.id);
      expect(row.keys, row.name).toEqual({
        live: counted?.live ?? 0,
        deleted: counted?.deleted ?? 0,
        needsReview: counted?.needsReview ?? 0,
      });
      expect(row.changedAt, row.name).toBe(counted?.changedAt ?? null);
      expect(row.kvReady).toBe(true);
    }
    // An environment that holds nothing was counted: zero, and no time of a change.
    expect(environmentOf(projects, f.tenants.a.env2a)).toMatchObject({
      keys: { live: 0, deleted: 0, needsReview: 0 },
      changedAt: null,
    });

    const admin = await overview("adminA");
    expect(admin.status).toBe(200);
    expect(admin.body.projects).toEqual(answer.body.projects);
    for (const member of ["editorA", "readerA", "envEditorA", "ungrantedA"] as const) {
      const denied = await overview(member);
      expect(denied.status, member).toBe(403);
      expect(denied.code, member).toBe("action_denied");
      expect(denied.text).not.toContain(f.tenants.a.project1);
    }
    const foreign = await overview("ownerB");
    expect(foreign.status).toBe(404);
    expect(foreign.code).toBe("not_found");
    const unknown = await overview("ownerA", randomUUID());
    expect(unknown.text.replace(/"requestId":"[^"]*"/, "")).toBe(
      foreign.text.replace(/"requestId":"[^"]*"/, ""),
    );
  });

  it("an environment in needs_review has keys null", async () => {
    const id = f.tenants.a.env1b;
    await f.api.superuser.query(
      "UPDATE app.environment SET state = 'needs_review', review_reason = 'policy_drift' WHERE id = $1",
      [id],
    );
    try {
      const answer = await overview();
      expect(answer.status, answer.text).toBe(200);
      const row = environmentOf(answer.body.projects as ProjectRow[], id);
      expect(row).toMatchObject({
        state: "needs_review",
        reviewReason: "policy_drift",
        keys: null,
        changedAt: null,
      });
      // Its neighbour is still counted.
      expect(environmentOf(answer.body.projects as ProjectRow[], f.tenants.a.env1a)?.keys).toEqual({
        live: 3,
        deleted: 1,
        needsReview: 1,
      });
    } finally {
      await f.api.superuser.query(
        "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
        [id],
      );
    }
  });

  it("a pending environment has keys null; a revoking and an archived one keep the counts of the index", async () => {
    const id = f.tenants.a.env1a;
    const stateOf = async (state: string): Promise<EnvironmentRow | undefined> => {
      await f.api.superuser.query("UPDATE app.environment SET state = $2 WHERE id = $1", [
        id,
        state,
      ]);
      const answer = await overview();
      expect(answer.status, answer.text).toBe(200);
      return environmentOf(answer.body.projects as ProjectRow[], id);
    };
    try {
      expect(await stateOf("pending")).toMatchObject({ state: "pending", keys: null });
      for (const state of ["revoking", "archived"]) {
        const row = await stateOf(state);
        expect(row, state).toMatchObject({
          state,
          keys: { live: 3, deleted: 1, needsReview: 1 },
        });
        expect(row?.changedAt, state).not.toBeNull();
      }
    } finally {
      await f.api.superuser.query("UPDATE app.environment SET state = 'active' WHERE id = $1", [
        id,
      ]);
    }
  });

  it("nothing of organization B is in the answer", async () => {
    const answer = await overview();
    expect(answer.status).toBe(200);
    for (const id of [f.tenants.b.organizationId, f.tenants.b.project1, f.tenants.b.env1a]) {
      expect(answer.text).not.toContain(id);
    }
    // Counts only: no secret's name is in the answer, of either organization.
    const secretNames = await f.api.superuser.query<{ name: string }>(
      "SELECT name FROM app.secret_index",
    );
    expect(secretNames.rows.length).toBeGreaterThan(0);
    for (const row of secretNames.rows) expect(answer.text).not.toContain(row.name);
    // B's own overview holds only B's ids.
    const b = await overview("ownerB", f.tenants.b.organizationId);
    expect(b.status, b.text).toBe(200);
    expect(b.text).toContain(f.tenants.b.project1);
    for (const id of [f.tenants.a.project1, f.tenants.a.project2, f.tenants.a.env1a]) {
      expect(b.text).not.toContain(id);
    }
  });
});
