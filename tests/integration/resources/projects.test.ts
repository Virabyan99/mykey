// Run 3.9 Task B (FR-1.14, FR-1.15, FR-1.19, P-58): projects are created and
// renamed through durable, replayable operations; names follow the contract's
// rules and the database's exact uniqueness; a create also creates the
// `development` environment and its provisioning operation.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorOf } from "../../harness/api.ts";
import type { FixtureUser } from "../../harness/tenants.ts";
import { createProvisioningFixture, type ProvisioningFixture } from "../provisioning/fixture.ts";

let fx: ProvisioningFixture;

beforeAll(async () => {
  fx = await createProvisioningFixture({
    shared: true,
    stubs: true,
    beforeHandler: (routeId) => beforeHandler(routeId),
  });
}, 600_000);

afterAll(async () => {
  await fx.close();
}, 300_000);

const orgA = () => fx.tenants.a.organizationId;

/** Runs after the pipeline's checks and before the handler (Run 4.1 Task D). */
let beforeHandler: (routeId: string) => Promise<void> = () => Promise.resolve();

interface Answer {
  status: number;
  body: Record<string, unknown>;
  code: string | undefined;
}

async function send(
  method: string,
  path: string,
  user: FixtureUser,
  body: unknown,
  key: string | null = randomUUID(),
): Promise<Answer> {
  const response = await fx.api.request(method, path, {
    body,
    cookie: await fx.tenants.cookie(user),
    headers: key === null ? {} : { "idempotency-key": key },
  });
  const text = await response.text();
  const parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  const code = (parsed.error as { code?: string } | undefined)?.code;
  return { status: response.status, body: parsed, code };
}

const create = (name: string, user: FixtureUser = "ownerA", key?: string | null, org = orgA()) =>
  send("POST", `/v1/organizations/${org}/projects`, user, { name }, key);
const rename = (projectId: string, name: string, user: FixtureUser = "ownerA", key?: string) =>
  send("PATCH", `/v1/organizations/${orgA()}/projects/${projectId}`, user, { name }, key);

async function projectsNamed(name: string): Promise<{ id: string; name: string; state: string }[]> {
  const result = await fx.api.superuser.query<{ id: string; name: string; state: string }>(
    "SELECT id, name, state FROM app.project WHERE organization_id = $1 AND name = $2",
    [orgA(), name],
  );
  return result.rows;
}

const resultOf = (answer: Answer) =>
  answer.body.result as { projectId: string; developmentEnvironmentId: string };

describe("create a project", () => {
  it("the owner creates a project: 201 with the operation, the development environment and its provisioning, one audit row; then both become active", async () => {
    const created = await create("Payments");
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: "succeeded" });
    expect(created.body.statusUrl).toBe(`/v1/operations/${String(created.body.operationId)}`);
    const { projectId, developmentEnvironmentId } = resultOf(created);
    const env = await fx.api.superuser.query<{ name: string; state: string; kv_ready: boolean }>(
      "SELECT name, state, kv_ready FROM app.environment WHERE id = $1 AND project_id = $2",
      [developmentEnvironmentId, projectId],
    );
    expect(env.rows).toEqual([{ name: "development", state: "pending", kv_ready: false }]);
    expect((await projectsNamed("Payments")).map((p) => p.state)).toEqual(["pending"]);
    const provision = await fx.api.superuser.query<{ id: string; state: string }>(
      "SELECT id, state FROM app.operation WHERE action = 'environment.provision' AND target = $1",
      [developmentEnvironmentId],
    );
    expect(provision.rows).toHaveLength(1);
    expect(provision.rows[0]?.state).toBe("accepted");
    const outbox = await fx.api.superuser.query(
      "SELECT 1 FROM app.outbox WHERE operation_id = $1",
      [provision.rows[0]?.id],
    );
    expect(outbox.rowCount).toBe(1);
    const audit = await fx.api.superuser.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit.event WHERE action = 'project.create' AND target_id = $1",
      [projectId],
    );
    expect(audit.rows).toEqual([{ details: { nameLength: 8 } }]);

    const provisioner = await fx.start();
    try {
      await fx.waitFor(developmentEnvironmentId, "active", 10_000);
      expect((await projectsNamed("Payments"))[0]?.state).toBe("active");
    } finally {
      await provisioner.stop();
    }
  }, 120_000);

  it("the admin can; editor, reader and an ungranted member get 403; ownerB gets 404; nothing is created by them", async () => {
    expect((await create("By admin", "adminA")).status).toBe(201);
    for (const user of ["editorA", "readerA", "ungrantedA"] as const) {
      const answer = await create(`By ${user}`, user);
      expect(answer.status, user).toBe(403);
      expect(answer.code, user).toBe("action_denied");
      expect(await projectsNamed(`By ${user}`)).toEqual([]);
    }
    const outsider = await create("By ownerB", "ownerB");
    expect(outsider.status).toBe(404);
    expect(await projectsNamed("By ownerB")).toEqual([]);
    // Control: ownerB creates in its own organization.
    expect(
      (await create("By ownerB", "ownerB", undefined, fx.tenants.b.organizationId)).status,
    ).toBe(201);
  });
});

describe("project names", () => {
  const astral = "\u{1F600}";
  const CASES: [string, string, number][] = [
    ["1 code point", "x", 201],
    ["64 code points", "p".repeat(64), 201],
    ["65 code points", "q".repeat(65), 422],
    ["empty", "", 422],
    ["only spaces", "   ", 422],
    ["a tab inside", "a\tb", 422],
    ["a NUL inside", "a\u0000b", 422],
    ["U+0085 inside", "a\u0085b", 422],
    ["64 astral characters (one code point each)", astral.repeat(64), 201],
  ];
  for (const [label, name, status] of CASES) {
    it(`${label} → ${String(status)}`, async () => {
      const answer = await create(name);
      expect(answer.status).toBe(status);
      if (status === 422) expect(answer.code).toBe("validation_failed");
    });
  }

  it("U+202E inside follows the contract's rule", async () => {
    const { checkProjectName } = await import("@mykey/contracts");
    const name = "a‮b";
    const expected = checkProjectName(name).ok ? 201 : 422;
    expect((await create(name)).status).toBe(expected);
  });

  it("e + U+0301 is stored as U+00E9 and collides with a project created as U+00E9", async () => {
    const decomposed = await create("Café");
    expect(decomposed.status).toBe(201);
    const stored = await projectsNamed("Café");
    expect(stored).toHaveLength(1);
    const composed = await create("Café");
    expect(composed.status).toBe(409);
    expect(composed.code).toBe("already_exists");
  });

  it('" api", "api " and "api" are three projects; "Api" and "api" are two', async () => {
    for (const name of [" api", "api ", "api", "Api"]) {
      expect((await create(name)).status, JSON.stringify(name)).toBe(201);
    }
    for (const name of [" api", "api ", "api", "Api"]) {
      expect(await projectsNamed(name), JSON.stringify(name)).toHaveLength(1);
    }
  });

  it("two creates of one name at once: one 201, one 409, one project, one development environment (20 rounds)", async () => {
    for (let round = 0; round < 20; round += 1) {
      const name = `Race ${String(round)}`;
      const answers = await Promise.all([create(name), create(name)]);
      expect(answers.map((a) => a.status).sort(), name).toEqual([201, 409]);
      const projects = await projectsNamed(name);
      expect(projects, name).toHaveLength(1);
      const environments = await fx.api.superuser.query(
        "SELECT 1 FROM app.environment WHERE project_id = $1",
        [projects[0]?.id],
      );
      expect(environments.rowCount, name).toBe(1);
    }
  });
});

describe("replay", () => {
  it("the same key and body again → the same 201 body, no second project", async () => {
    const key = randomUUID();
    const first = await create("Replayed", "ownerA", key);
    const again = await create("Replayed", "ownerA", key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(await projectsNamed("Replayed")).toHaveLength(1);
  });

  it("the same key with another name → 409 idempotency_conflict", async () => {
    const key = randomUUID();
    expect((await create("Conflict one", "ownerA", key)).status).toBe(201);
    const other = await create("Conflict two", "ownerA", key);
    expect(other.status).toBe(409);
    expect(other.code).toBe("idempotency_conflict");
    expect(await projectsNamed("Conflict two")).toEqual([]);
  });

  it("two identical requests at once with one key → one project, both answers name the same operation", async () => {
    for (let round = 0; round < 10; round += 1) {
      const key = randomUUID();
      const name = `Twin ${String(round)}`;
      const answers = await Promise.all([create(name, "ownerA", key), create(name, "ownerA", key)]);
      expect(answers.map((a) => a.status)).toEqual([201, 201]);
      expect(answers[0].body.operationId).toBe(answers[1].body.operationId);
      expect(await projectsNamed(name)).toHaveLength(1);
    }
  });

  it("no key, or a key that is not a UUID → 422 precondition_required", async () => {
    const none = await create("No key", "ownerA", null);
    expect(none.status).toBe(422);
    expect(none.code).toBe("precondition_required");
    const bad = await create("Bad key", "ownerA", "not-a-uuid");
    expect(bad.status).toBe(422);
    expect(bad.code).toBe("precondition_required");
    expect(await projectsNamed("No key")).toEqual([]);
  });

  it("the same key used by another user is another operation", async () => {
    const key = randomUUID();
    const owner = await create("Shared key A", "ownerA", key);
    const admin = await create("Shared key B", "adminA", key);
    expect(owner.status).toBe(201);
    expect(admin.status).toBe(201);
    expect(admin.body.operationId).not.toBe(owner.body.operationId);
  });

  it("after the organization goes to needs_review, the completed request still replays its 201 and a new key gets backend_inconsistent", async () => {
    const key = randomUUID();
    const first = await create("Before review", "ownerA", key);
    expect(first.status).toBe(201);
    await fx.api.superuser.query(
      "UPDATE app.organization SET state = 'needs_review', review_reason = 'drill' WHERE id = $1",
      [orgA()],
    );
    try {
      const again = await create("Before review", "ownerA", key);
      expect(again.status).toBe(201);
      expect(again.body).toEqual(first.body);
      const fresh = await create("During review");
      expect(fresh.status).toBe(503);
      expect(fresh.code).toBe("backend_inconsistent");
    } finally {
      await fx.api.superuser.query(
        "UPDATE app.organization SET state = 'active', review_reason = NULL WHERE id = $1",
        [orgA()],
      );
    }
  });
});

describe("rename", () => {
  it("200; id, created_at, grants unchanged; editorA keeps exactly the access it had", async () => {
    const projectId = fx.tenants.a.project1;
    const before = await fx.api.superuser.query(
      "SELECT id, created_at FROM app.project WHERE id = $1",
      [projectId],
    );
    const grants = await fx.api.superuser.query(
      "SELECT user_id, role FROM app.access_grant WHERE project_id = $1 ORDER BY user_id",
      [projectId],
    );
    const renamed = await rename(projectId, "Project One renamed");
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ state: "succeeded", result: {} });
    const after = await fx.api.superuser.query(
      "SELECT id, created_at, name FROM app.project WHERE id = $1",
      [projectId],
    );
    expect(after.rows[0]).toMatchObject({ ...before.rows[0], name: "Project One renamed" });
    const grantsAfter = await fx.api.superuser.query(
      "SELECT user_id, role FROM app.access_grant WHERE project_id = $1 ORDER BY user_id",
      [projectId],
    );
    expect(grantsAfter.rows).toEqual(grants.rows);
    const secrets = `/v1/organizations/${orgA()}/projects/${projectId}/environments/${fx.tenants.a.env1a}/secrets`;
    const editor = await fx.api.request("GET", secrets, {
      cookie: await fx.tenants.cookie("editorA"),
    });
    // secrets.list has its handler since Run 4.3: the editor's access answers 200.
    expect(editor.status).toBe(200);
    const ungranted = await fx.api.request("GET", secrets, {
      cookie: await fx.tenants.cookie("ungrantedA"),
    });
    expect(ungranted.status).toBe(404);
    // Back to the fixture's name.
    expect((await rename(projectId, "Project One")).status).toBe(200);
  });

  it("rename to an existing name → 409 already_exists; to the same name → 200 and no project.rename audit row", async () => {
    const { a } = fx.tenants;
    const taken = await rename(a.project1, "Project Two");
    expect(taken.status).toBe(409);
    expect(taken.code).toBe("already_exists");
    const count = async () =>
      (
        await fx.api.superuser.query(
          "SELECT 1 FROM audit.event WHERE action = 'project.rename' AND target_id = $1",
          [a.project1],
        )
      ).rowCount;
    const rows = await count();
    const same = await rename(a.project1, "Project One");
    expect(same.status).toBe(200);
    expect(same.body.state).toBe("succeeded");
    expect(await count()).toBe(rows);
  });

  it("two renames of one project at once both settle (no deadlock), 10 rounds", async () => {
    const created = await create("Rename race");
    const { projectId } = resultOf(created);
    for (let round = 0; round < 10; round += 1) {
      const answers = await Promise.all([
        rename(projectId, `Rename race a${String(round)}`),
        rename(projectId, `Rename race b${String(round)}`),
      ]);
      expect(
        answers.map((answer) => answer.status),
        String(round),
      ).toEqual([200, 200]);
    }
  });

  it("rename of an archived project → 409 state_conflict", async () => {
    const { a } = fx.tenants;
    await fx.api.superuser.query("UPDATE app.project SET state = 'archived' WHERE id = $1", [
      a.project2,
    ]);
    try {
      const answer = await rename(a.project2, "Archived renamed");
      expect(answer.status).toBe(409);
      expect(answer.code).toBe("state_conflict");
    } finally {
      await fx.api.superuser.query("UPDATE app.project SET state = 'active' WHERE id = $1", [
        a.project2,
      ]);
    }
  });
});

describe("admission recheck", () => {
  it("the admission recheck sees a state that changed after the pipeline: 503 backend_inconsistent, nothing created", async () => {
    const name = `Recheck ${randomUUID().slice(0, 8)}`;
    beforeHandler = async (routeId) => {
      if (routeId !== "projects.create") return;
      await fx.api.superuser.query(
        "UPDATE app.organization SET state = 'needs_review', review_reason = 'backend_inconsistent' WHERE id = $1",
        [orgA()],
      );
    };
    try {
      const answer = await create(name);
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("backend_inconsistent");
      expect(await projectsNamed(name)).toEqual([]);
    } finally {
      beforeHandler = () => Promise.resolve();
      await fx.api.superuser.query(
        "UPDATE app.organization SET state = 'active', review_reason = NULL WHERE id = $1",
        [orgA()],
      );
    }
    // Control: with the organization active the same name is created.
    expect((await create(name)).status).toBe(201);
  });
});

describe("audit", () => {
  it("a failed audit append creates nothing: 503 audit_unavailable, no project, no operation, no outbox row", async () => {
    await fx.api.superuser.query("REVOKE INSERT ON audit.event FROM api_runtime");
    try {
      const key = randomUUID();
      const answer = await create("Unaudited", "ownerA", key);
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("audit_unavailable");
      expect(await projectsNamed("Unaudited")).toEqual([]);
      const operations = await fx.api.superuser.query(
        "SELECT 1 FROM app.operation WHERE idempotency_key = $1",
        [key],
      );
      expect(operations.rowCount).toBe(0);
    } finally {
      await fx.api.superuser.query("GRANT INSERT ON audit.event TO api_runtime");
    }
  });
});

it("the error envelope of a refusal carries its code (control of the helper)", async () => {
  const response = await fx.api.request("POST", `/v1/organizations/${orgA()}/projects`, {
    body: { name: "x" },
    cookie: await fx.tenants.cookie("readerA"),
    headers: { "idempotency-key": randomUUID() },
  });
  expect((await errorOf(response)).code).toBe("action_denied");
});
