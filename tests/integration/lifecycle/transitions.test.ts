// Run 5.3 Task A (P-91, P-92, D-41): every state change of an archive or a
// reactivation goes through one guarded function, app.lifecycle_transition.
// Each step moves exactly its rows and answers true; called again it answers
// false and changes nothing. It never moves a row out of needs_review. Only
// api_runtime may execute it, and api_runtime can no longer write the state
// and archive columns itself.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attempt, prepareDatabase, run, type TestDatabase } from "../database/setup.ts";

const DENIED = "42501";
const CALL = "SELECT app.lifecycle_transition($1, $2, $3, $4, $5, $6) AS moved";

let db: TestDatabase;
const org = randomUUID();

beforeAll(async () => {
  db = await prepareDatabase();
  await run(
    db.pool("superuser"),
    "INSERT INTO app.organization (id, namespace, state) VALUES ($1, $2, 'active')",
    [org, `org-${org}`],
  );
});

afterAll(async () => {
  await db.drop();
});

const su = () => db.pool("superuser");

async function project(state = "active", extra: { op?: string } = {}): Promise<string> {
  const id = randomUUID();
  await run(
    su(),
    `INSERT INTO app.project (id, organization_id, name, state, archive_operation_id, review_reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      org,
      `p-${id.slice(0, 8)}`,
      state,
      extra.op ?? null,
      state === "needs_review" ? "backend_inconsistent" : null,
    ],
  );
  return id;
}

async function environment(
  projectId: string,
  state = "active",
  extra: { origin?: string; op?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await run(
    su(),
    `INSERT INTO app.environment (id, organization_id, project_id, name, state, kv_ready,
                                  archive_origin, archive_operation_id, review_reason)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)`,
    [
      id,
      org,
      projectId,
      `e-${id.slice(0, 8)}`,
      state,
      extra.origin ?? null,
      extra.op ?? null,
      state === "needs_review" ? "backend_inconsistent" : null,
    ],
  );
  return id;
}

async function credential(
  projectId: string,
  environmentId: string,
  state: string,
): Promise<string> {
  const id = randomUUID();
  await run(
    su(),
    `INSERT INTO app.machine_credential
       (id, organization_id, project_id, environment_id, name, issuance_operation_id,
        requested_expires_at, state, issued_by)
     VALUES ($1, $2, $3, $4, 'm', $5, now() + interval '1 hour', $6, $7)`,
    [id, org, projectId, environmentId, randomUUID(), state, randomUUID()],
  );
  return id;
}

async function transition(
  kind: "project" | "environment",
  id: string,
  op: string,
  step: string,
  origin: string | null = null,
  login: "api_runtime" | "superuser" = "api_runtime",
): Promise<boolean> {
  const [row] = await run<{ moved: boolean }>(db.pool(login), CALL, [
    kind,
    org,
    id,
    op,
    step,
    origin,
  ]);
  return row!.moved;
}

const rowOf = async (kind: "project" | "environment", id: string) =>
  (
    await run<{
      state: string;
      archive_operation_id: string | null;
      archive_origin?: string | null;
    }>(
      su(),
      kind === "project"
        ? "SELECT state, archive_operation_id FROM app.project WHERE id = $1"
        : "SELECT state, archive_operation_id, archive_origin FROM app.environment WHERE id = $1",
      [id],
    )
  )[0];

describe("app.lifecycle_transition", () => {
  it("environment: begin_archive, finish_archive, reactivate each move exactly the row and answer true; again: false, nothing changes", async () => {
    const p = await project();
    const e = await environment(p);
    const other = await environment(p);
    const op = randomUUID();
    expect(await transition("environment", e, op, "begin_archive")).toBe(true);
    expect(await rowOf("environment", e)).toEqual({
      state: "revoking",
      archive_operation_id: op,
      archive_origin: "self",
    });
    expect(await transition("environment", e, op, "begin_archive")).toBe(false);
    expect(await transition("environment", e, op, "finish_archive")).toBe(true);
    expect((await rowOf("environment", e))?.state).toBe("archived");
    expect(await transition("environment", e, op, "finish_archive")).toBe(false);
    const reactivation = randomUUID();
    expect(await transition("environment", e, reactivation, "reactivate")).toBe(true);
    expect(await rowOf("environment", e)).toEqual({
      state: "active",
      archive_operation_id: null,
      archive_origin: null,
    });
    expect(await transition("environment", e, reactivation, "reactivate")).toBe(false);
    expect((await rowOf("environment", other))?.state).toBe("active");
    expect((await rowOf("project", p))?.state).toBe("active");
  });

  it("project: begin_archive moves the project only; finish_archive moves it and its environments revoking under the same operation", async () => {
    const p = await project();
    const op = randomUUID();
    const child = await environment(p);
    const own = await environment(p, "archived", { origin: "self", op: randomUUID() });
    expect(await transition("project", p, op, "begin_archive")).toBe(true);
    expect(await rowOf("project", p)).toEqual({ state: "revoking", archive_operation_id: op });
    expect((await rowOf("environment", child))?.state).toBe("active");
    expect(await transition("environment", child, op, "begin_archive", "project")).toBe(true);
    expect(await rowOf("environment", child)).toMatchObject({
      state: "revoking",
      archive_origin: "project",
      archive_operation_id: op,
    });
    expect(await transition("project", p, op, "finish_archive")).toBe(true);
    expect((await rowOf("project", p))?.state).toBe("archived");
    expect((await rowOf("environment", child))?.state).toBe("archived");
    expect(await rowOf("environment", own)).toMatchObject({
      state: "archived",
      archive_origin: "self",
    });
    expect(await transition("project", p, op, "finish_archive")).toBe(false);
  });

  it("finish_archive answers false while one credential of the scope is active, expired, revoking, issuing or needs_review; true when all are revoked", async () => {
    for (const state of ["active", "expired", "revoking", "issuing", "needs_review"]) {
      const p = await project();
      const e = await environment(p);
      const op = randomUUID();
      await credential(p, e, "revoked");
      const blocking = await credential(p, e, state);
      expect(await transition("environment", e, op, "begin_archive"), state).toBe(true);
      expect(await transition("environment", e, op, "finish_archive"), state).toBe(false);
      expect((await rowOf("environment", e))?.state, state).toBe("revoking");
      await run(su(), "UPDATE app.machine_credential SET state = 'revoked' WHERE id = $1", [
        blocking,
      ]);
      expect(await transition("environment", e, op, "finish_archive"), state).toBe(true);
    }
    // A project: a credential of any of its environments blocks it.
    const p = await project();
    const e = await environment(p, "archived", { origin: "self", op: randomUUID() });
    const blocking = await credential(p, e, "active");
    const op = randomUUID();
    expect(await transition("project", p, op, "begin_archive")).toBe(true);
    expect(await transition("project", p, op, "finish_archive")).toBe(false);
    await run(su(), "UPDATE app.machine_credential SET state = 'revoked' WHERE id = $1", [
      blocking,
    ]);
    expect(await transition("project", p, op, "finish_archive")).toBe(true);
  });

  it("finish_archive under another operation answers false", async () => {
    const p = await project();
    const e = await environment(p);
    const op = randomUUID();
    expect(await transition("environment", e, op, "begin_archive")).toBe(true);
    expect(await transition("environment", e, randomUUID(), "finish_archive")).toBe(false);
    expect((await rowOf("environment", e))?.state).toBe("revoking");
  });

  it("begin_archive of an environment with origin project needs its project revoking under the same operation", async () => {
    const p = await project();
    const e = await environment(p);
    const op = randomUUID();
    expect(await transition("environment", e, op, "begin_archive", "project")).toBe(false);
    expect(await transition("project", p, op, "begin_archive")).toBe(true);
    expect(await transition("environment", e, randomUUID(), "begin_archive", "project")).toBe(
      false,
    );
    expect(await transition("environment", e, op, "begin_archive", "project")).toBe(true);
  });

  it("the function never moves a row out of needs_review (all three steps, both kinds)", async () => {
    for (const step of ["begin_archive", "finish_archive", "reactivate"]) {
      const p = await project("needs_review", { op: randomUUID() });
      const e = await environment(await project(), "needs_review", {
        origin: "self",
        op: randomUUID(),
      });
      const op = (await rowOf("project", p))?.archive_operation_id ?? randomUUID();
      expect(await transition("project", p, op, step), step).toBe(false);
      expect(await transition("environment", e, op, step), step).toBe(false);
      expect((await rowOf("project", p))?.state).toBe("needs_review");
      expect((await rowOf("environment", e))?.state).toBe("needs_review");
    }
  });

  it("reactivate of an environment under an archived project answers false; with origin project it is not reactivated on its own", async () => {
    const archivedProject = await project("archived", { op: randomUUID() });
    const own = await environment(archivedProject, "archived", {
      origin: "self",
      op: randomUUID(),
    });
    expect(await transition("environment", own, randomUUID(), "reactivate")).toBe(false);
    const active = await project();
    const fromProject = await environment(active, "archived", {
      origin: "project",
      op: randomUUID(),
    });
    expect(await transition("environment", fromProject, randomUUID(), "reactivate")).toBe(false);
    expect((await rowOf("environment", fromProject))?.state).toBe("archived");
  });

  it("a project reactivation moves only the children of its own archive operation", async () => {
    const op = randomUUID();
    const p = await project("archived", { op });
    const child = await environment(p, "archived", { origin: "project", op });
    const own = await environment(p, "archived", { origin: "self", op: randomUUID() });
    const stray = await environment(p, "archived", { origin: "project", op: randomUUID() });
    expect(await transition("project", p, randomUUID(), "reactivate")).toBe(true);
    expect(await rowOf("project", p)).toEqual({ state: "active", archive_operation_id: null });
    expect(await rowOf("environment", child)).toEqual({
      state: "active",
      archive_origin: null,
      archive_operation_id: null,
    });
    expect((await rowOf("environment", own))?.state).toBe("archived");
    expect((await rowOf("environment", stray))?.state).toBe("archived");
  });

  it("another organization's id moves nothing", async () => {
    const p = await project();
    const [row] = await run<{ moved: boolean }>(db.pool("api_runtime"), CALL, [
      "project",
      randomUUID(),
      p,
      randomUUID(),
      "begin_archive",
      null,
    ]);
    expect(row?.moved).toBe(false);
    expect((await rowOf("project", p))?.state).toBe("active");
  });

  it("an unknown step or kind raises", async () => {
    const p = await project();
    expect(
      await attempt(db.pool("api_runtime"), CALL, [
        "project",
        org,
        p,
        randomUUID(),
        "delete",
        null,
      ]),
    ).toBe("22023");
    expect(
      await attempt(db.pool("api_runtime"), CALL, [
        "organization",
        org,
        p,
        randomUUID(),
        "begin_archive",
        null,
      ]),
    ).toBe("22023");
  });

  it("as api_runtime, a direct UPDATE of project.state or environment.state is refused (42501); the function works", async () => {
    const p = await project();
    const e = await environment(p);
    const api = db.pool("api_runtime");
    for (const sql of [
      "UPDATE app.project SET state = 'archived' WHERE id = $1",
      "UPDATE app.project SET archive_operation_id = gen_random_uuid() WHERE id = $1",
      "UPDATE app.environment SET state = 'archived' WHERE id = $1",
      "UPDATE app.environment SET archive_origin = 'self' WHERE id = $1",
      "UPDATE app.environment SET archive_operation_id = gen_random_uuid() WHERE id = $1",
    ]) {
      expect(await attempt(api, sql, [sql.includes("app.project") ? p : e]), sql).toBe(DENIED);
    }
    expect(await transition("environment", e, randomUUID(), "begin_archive")).toBe(true);
  });

  it("provisioner_runtime, backup_reader, maintenance and PUBLIC cannot execute it", async () => {
    const p = await project();
    for (const login of ["provisioner_runtime", "backup_reader", "maintenance"] as const) {
      expect(
        await attempt(db.pool(login), CALL, [
          "project",
          org,
          p,
          randomUUID(),
          "begin_archive",
          null,
        ]),
        login,
      ).toBe(DENIED);
    }
    const [acl] = await run<{ public: boolean; definer: boolean; owner: string }>(
      su(),
      `SELECT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public,
              p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'lifecycle_transition'`,
    );
    expect(acl).toEqual({ public: false, definer: true, owner: "migration_owner" });
  });
});
