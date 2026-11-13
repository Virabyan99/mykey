// Run 4.1 Task C (P-63, Doc 04 §4.1, §1.2): an operation's status and the
// environment's operation list. The status is visible to an owner or admin of
// its organization and to the member who made it while that member may still
// do the operation's action on its scope; to everyone else it is a 404 equal
// to the 404 of a random id. Status stays readable while the environment is
// in review.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operationResponseSchema } from "@mykey/contracts";
import { COMMANDS } from "@mykey/ops";
import { PassThrough } from "node:stream";
import { startTestApi, type TestApi } from "../../harness/api.ts";
import { TEST_OPS, testOpsHandler } from "../../harness/test-ops.ts";
import { createTenants, type FixtureUser, type Tenants } from "../../harness/tenants.ts";

let api: TestApi;
let tenants: Tenants;

beforeAll(async () => {
  api = await startTestApi({ stubs: true, routes: [{ def: TEST_OPS, handler: testOpsHandler }] });
  tenants = await createTenants(api);
}, 300_000);

afterAll(async () => {
  await api.close();
});

const envPath = (env = tenants.a.env1a, project = tenants.a.project1) =>
  `/v1/organizations/${tenants.a.organizationId}/projects/${project}/environments/${env}`;

/** An operation made through the test route by `user` in environment 1a (or `env`). */
async function made(
  user: FixtureUser,
  state = "succeeded",
  env = tenants.a.env1a,
): Promise<string> {
  const project = env === tenants.a.env2a ? tenants.a.project2 : tenants.a.project1;
  const response = await api.request("POST", `${envPath(env, project)}/test-ops/A`, {
    body: { state },
    cookie: await tenants.cookie(user),
    headers: { "idempotency-key": randomUUID() },
  });
  const body = (await response.json()) as {
    operationId?: string;
    error?: { operationId?: string };
  };
  const id = body.operationId ?? body.error?.operationId;
  if (id === undefined) throw new Error(`no operation (${String(response.status)})`);
  return id;
}

async function status(user: FixtureUser, id: string): Promise<Response> {
  return api.request("GET", `/v1/operations/${id}`, { cookie: await tenants.cookie(user) });
}

async function shape(response: Response) {
  const text = await response.text();
  const requestId = response.headers.get("x-request-id") ?? "";
  return {
    status: response.status,
    headers: [...response.headers.keys()].filter((name) => name !== "date").sort(),
    body: text.replace(requestId, "<id>"),
    length: response.headers.get("content-length"),
  };
}

describe("operations.get", () => {
  it("the owner reads an operation of the editor; the editor reads its own; the editor gets 404 for the admin's operation", async () => {
    const editors = await made("editorA");
    const admins = await made("adminA");
    expect((await status("ownerA", editors)).status).toBe(200);
    expect((await status("adminA", editors)).status).toBe(200);
    expect((await status("editorA", editors)).status).toBe(200);
    expect((await status("editorA", admins)).status).toBe(404);
  });

  it("ownerB gets a 404 that equals the 404 of a random id", async () => {
    const id = await made("ownerA");
    const hidden = await shape(await status("ownerB", id));
    const absent = await shape(await status("ownerB", randomUUID()));
    expect(hidden.status).toBe(404);
    expect(absent).toEqual(hidden);
  });

  it("the editor's grant is removed: its own operation is 404 on the next request (control before)", async () => {
    const id = await made("editorA");
    expect((await status("editorA", id)).status).toBe(200);
    const removed = await api.superuser.query<{ id: string }>(
      "DELETE FROM app.access_grant WHERE user_id = $1 RETURNING id",
      [tenants.userId("editorA")],
    );
    try {
      expect((await status("editorA", id)).status).toBe(404);
    } finally {
      for (const grant of removed.rows) {
        await api.superuser.query(
          `INSERT INTO app.access_grant (id, organization_id, user_id, project_id, role)
           VALUES ($1, $2, $3, $4, 'editor')`,
          [grant.id, tenants.a.organizationId, tenants.userId("editorA"), tenants.a.project1],
        );
      }
    }
  });

  it("envEditorA reads its own in 1a and gets 404 for an operation of 1b", async () => {
    const own = await made("envEditorA");
    const other = await made("ownerA", "succeeded", tenants.a.env1b);
    expect((await status("envEditorA", own)).status).toBe(200);
    expect((await status("envEditorA", other)).status).toBe(404);
  });

  it("a non-UUID id is 404; an operator's operation (no organization) is 404 for the owner", async () => {
    expect((await status("ownerA", "not-a-uuid")).status).toBe(404);
    const operator = randomUUID();
    await api.superuser.query(
      `INSERT INTO app.operation (id, organization_id, principal_kind, principal_id, action, target,
         idempotency_key, state)
       VALUES ($1::uuid, NULL, 'operator', 'op', 'organization.provision', $2, $1::text, 'succeeded')`,
      [operator, tenants.a.organizationId],
    );
    expect((await status("ownerA", operator)).status).toBe(404);
  });

  it("the environment in needs_review: the status is still 200 (control: secrets.list there is 503); the organization in review: 503", async () => {
    const id = await made("ownerA");
    await api.superuser.query(
      "UPDATE app.environment SET state = 'needs_review', review_reason = 'backend_inconsistent' WHERE id = $1",
      [tenants.a.env1a],
    );
    try {
      expect((await status("ownerA", id)).status).toBe(200);
      const list = await api.request("GET", `${envPath()}/secrets`, {
        cookie: await tenants.cookie("ownerA"),
      });
      expect(list.status).toBe(503);
    } finally {
      await api.superuser.query(
        "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
        [tenants.a.env1a],
      );
    }
    await api.superuser.query(
      "UPDATE app.organization SET state = 'needs_review', review_reason = 'backend_inconsistent' WHERE id = $1",
      [tenants.a.organizationId],
    );
    try {
      const response = await status("ownerA", id);
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "backend_inconsistent",
      );
    } finally {
      await api.superuser.query(
        "UPDATE app.organization SET state = 'active', review_reason = NULL WHERE id = $1",
        [tenants.a.organizationId],
      );
    }
  });

  it("the body's keys are exactly those of the envelope", async () => {
    const id = await made("ownerA");
    const body = (await (await status("ownerA", id)).json()) as Record<string, unknown>;
    expect(operationResponseSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body).sort()).toEqual(
      ["operationId", "replayExpiresAt", "result", "state", "statusUrl"].sort(),
    );
  });

  it("after ops operations-expire the status still answers 200 with the state and no result", async () => {
    const id = await made("ownerA");
    await api.superuser.query(
      "UPDATE app.operation SET replay_expires_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );
    const code = await COMMANDS["operations-expire"]!.run(
      {},
      {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        env: { database: api.database.targets.maintenance },
      },
    );
    expect(code).toBe(0);
    const response = await status("ownerA", id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.state).toBe("succeeded");
    expect(body.result).toBeUndefined();
  });
});

interface ListBody {
  operations: { operationId: string; state: string; mine: boolean; action: string }[];
  nextCursor: string | null;
}

async function list(user: FixtureUser, query = "", env = tenants.a.env1a): Promise<Response> {
  return api.request("GET", `${envPath(env)}/operations${query}`, {
    cookie: await tenants.cookie(user),
  });
}

describe("operations.list", () => {
  it("a member sees only its own; the owner sees all; children are not listed; readerA made none and sees none", async () => {
    const env = tenants.a.env2a;
    const ownerOp = await made("ownerA", "succeeded", env);
    const adminOp = await made("adminA", "succeeded", env);
    const child = randomUUID();
    await api.superuser.query(
      `INSERT INTO app.operation (id, organization_id, environment_id, project_id, principal_kind,
         principal_id, action, target, idempotency_key, state, parent_operation_id)
       VALUES ($1::uuid, $2, $3::uuid, $4, 'user', $5, 'secrets.create', $3::text, $1::text, 'succeeded', $6)`,
      [child, tenants.a.organizationId, env, tenants.a.project2, tenants.userId("ownerA"), ownerOp],
    );
    const all = (await (
      await api.request("GET", `${envPath(env, tenants.a.project2)}/operations`, {
        cookie: await tenants.cookie("ownerA"),
      })
    ).json()) as ListBody;
    const ids = all.operations.map((op) => op.operationId);
    expect(ids).toContain(ownerOp);
    expect(ids).toContain(adminOp);
    expect(ids).not.toContain(child);
    expect(all.operations.find((op) => op.operationId === ownerOp)?.mine).toBe(true);
    expect(all.operations.find((op) => op.operationId === adminOp)?.mine).toBe(false);

    const editorOp = await made("editorA");
    await made("adminA");
    const editors = (await (await list("editorA")).json()) as ListBody;
    expect(editors.operations.length).toBeGreaterThan(0);
    expect(editors.operations.every((op) => op.mine)).toBe(true);
    expect(editors.operations.map((op) => op.operationId)).toContain(editorOp);
    const readers = await list("readerA");
    expect(readers.status).toBe(200);
    expect(((await readers.json()) as ListBody).operations).toEqual([]);
  });

  it("state=unfinished returns accepted, executing, awaiting_input, uncertain only", async () => {
    for (const state of [
      "accepted",
      "executing",
      "awaiting_input",
      "uncertain",
      "succeeded",
      "partial",
    ]) {
      await made("ownerA", state);
    }
    const body = (await (await list("ownerA", "?state=unfinished&limit=100")).json()) as ListBody;
    const states = new Set(body.operations.map((op) => op.state));
    expect([...states].sort()).toEqual(["accepted", "awaiting_input", "executing", "uncertain"]);
  });

  it("120 operations page 50/50/20 newest first, disjoint and complete; one made between pages does not appear or disturb", async () => {
    const env = tenants.b.env1a;
    const inserted: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      const id = randomUUID();
      inserted.push(id);
      await api.superuser.query(
        `INSERT INTO app.operation (id, organization_id, environment_id, project_id, principal_kind,
           principal_id, action, target, idempotency_key, state, created_at)
         VALUES ($1::uuid, $2, $3::uuid, $4, 'user', $5, 'projects.rename', $3::text, $1::text,
                 'succeeded', now() - make_interval(secs => $6))`,
        [id, tenants.b.organizationId, env, tenants.b.project1, tenants.userId("ownerB"), 1000 - i],
      );
    }
    const path = `/v1/organizations/${tenants.b.organizationId}/projects/${tenants.b.project1}/environments/${env}/operations`;
    const cookie = await tenants.cookie("ownerB");
    const pages: ListBody[] = [];
    let cursor: string | null = null;
    do {
      const response = await api.request(
        "GET",
        `${path}?limit=50${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as ListBody;
      pages.push(page);
      cursor = page.nextCursor;
      if (pages.length === 1) {
        // Made between two pages: newer than the first page's anchor.
        await api.superuser.query(
          `INSERT INTO app.operation (id, organization_id, environment_id, project_id, principal_kind,
             principal_id, action, target, idempotency_key, state)
           VALUES ($1::uuid, $2, $3::uuid, $4, 'user', $5, 'projects.rename', $3::text, $1::text,
                   'succeeded')`,
          [
            randomUUID(),
            tenants.b.organizationId,
            env,
            tenants.b.project1,
            tenants.userId("ownerB"),
          ],
        );
      }
    } while (cursor !== null);
    expect(pages.map((page) => page.operations.length)).toEqual([50, 50, 20]);
    const seen = pages.flatMap((page) => page.operations.map((op) => op.operationId));
    expect(new Set(seen).size).toBe(120);
    expect(seen).toEqual([...inserted].reverse());
  });

  it("a cursor of another environment or of projects.list → 400 malformed_request", async () => {
    await made("ownerA", "succeeded", tenants.a.env1b);
    await made("ownerA", "succeeded", tenants.a.env1b);
    const first = (await (await list("ownerA", "?limit=1", tenants.a.env1b)).json()) as ListBody;
    expect(first.nextCursor).not.toBeNull();
    const cursor = encodeURIComponent(first.nextCursor!);
    const wrongEnv = await list("ownerA", `?limit=1&cursor=${cursor}`);
    expect(wrongEnv.status).toBe(400);
    const projects = (await (
      await api.request("GET", `/v1/organizations/${tenants.a.organizationId}/projects?limit=1`, {
        cookie: await tenants.cookie("ownerA"),
      })
    ).json()) as { nextCursor: string | null };
    expect(projects.nextCursor).not.toBeNull();
    const fromProjects = await list(
      "ownerA",
      `?limit=1&cursor=${encodeURIComponent(projects.nextCursor!)}`,
      tenants.a.env1b,
    );
    expect(fromProjects.status).toBe(400);
  });

  it("limit=0 and limit=101 → 422", async () => {
    expect((await list("ownerA", "?limit=0")).status).toBe(422);
    expect((await list("ownerA", "?limit=101")).status).toBe(422);
  });
});
