// Run 3.9 Task C (FR-1.15, FR-1.16, FR-1.19): environments are created and
// renamed through replayable operations; names follow ENVIRONMENT_NAME_PATTERN;
// a rename changes the name only — its id, lock key, readiness, grants and its
// machine policy in OpenBao stay as they were.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EnvironmentId } from "@mykey/contracts";
import { machineName } from "@mykey/openbao";
import type { FixtureUser } from "../../harness/tenants.ts";
import { createProvisioningFixture, type ProvisioningFixture } from "../provisioning/fixture.ts";

let fx: ProvisioningFixture;

beforeAll(async () => {
  fx = await createProvisioningFixture({ shared: true });
  // The tenants' environments of A through the real job, once.
  const provisioner = await fx.start();
  try {
    for (const id of [fx.tenants.a.env1a, fx.tenants.a.env1b, fx.tenants.a.env2a]) {
      await fx.waitFor(id, "active");
    }
  } finally {
    await provisioner.stop();
  }
}, 600_000);

afterAll(async () => {
  await fx.close();
}, 300_000);

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
  key: string = randomUUID(),
): Promise<Answer> {
  const response = await fx.api.request(method, path, {
    body,
    cookie: await fx.tenants.cookie(user),
    headers: { "idempotency-key": key },
  });
  const text = await response.text();
  const parsed = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  return {
    status: response.status,
    body: parsed,
    code: (parsed.error as { code?: string } | undefined)?.code,
  };
}

const base = (org: string, project: string) =>
  `/v1/organizations/${org}/projects/${project}/environments`;
const create = (
  name: string,
  opts: { project?: string; org?: string; user?: FixtureUser; key?: string } = {},
) =>
  send(
    "POST",
    base(opts.org ?? fx.tenants.a.organizationId, opts.project ?? fx.tenants.a.project1),
    opts.user ?? "ownerA",
    { name },
    opts.key,
  );
const rename = (environmentId: string, name: string, project = fx.tenants.a.project1) =>
  send("PATCH", `${base(fx.tenants.a.organizationId, project)}/${environmentId}`, "ownerA", {
    name,
  });

async function environmentsNamed(project: string, name: string): Promise<number> {
  const result = await fx.api.superuser.query(
    "SELECT 1 FROM app.environment WHERE project_id = $1 AND name = $2",
    [project, name],
  );
  return result.rowCount ?? 0;
}

describe("environment names", () => {
  const ACCEPTED = ["a", `a${"b".repeat(62)}`];
  const REJECTED = [`a${"b".repeat(63)}`, "A", "1a", "-a", "a_b", "a.b", "", "a "];
  for (const name of ACCEPTED) {
    it(`${JSON.stringify(name.length > 10 ? `${name.slice(0, 4)}… (${String(name.length)})` : name)} → 201`, async () => {
      expect((await create(name)).status).toBe(201);
    });
  }
  for (const name of REJECTED) {
    it(`${JSON.stringify(name.length > 10 ? `${name.slice(0, 4)}… (${String(name.length)})` : name)} → 422`, async () => {
      const answer = await create(name);
      expect(answer.status).toBe(422);
      expect(answer.code).toBe("validation_failed");
    });
  }

  it("development twice in one project → 409 already_exists; in two projects both are created", async () => {
    const { a } = fx.tenants;
    expect((await create("development")).status).toBe(201);
    const again = await create("development");
    expect(again.status).toBe(409);
    expect(again.code).toBe("already_exists");
    expect((await create("development", { project: a.project2 })).status).toBe(201);
    expect(await environmentsNamed(a.project1, "development")).toBe(1);
    expect(await environmentsNamed(a.project2, "development")).toBe(1);
  });

  it("two creates of one name at once: one 201 (10 rounds)", async () => {
    for (let round = 0; round < 10; round += 1) {
      const name = `race-${String(round)}`;
      const answers = await Promise.all([create(name), create(name)]);
      expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
      expect(await environmentsNamed(fx.tenants.a.project1, name)).toBe(1);
    }
  });
});

describe("where an environment may be created", () => {
  it("under an archived or needs_review project → 409 state_conflict", async () => {
    const { a } = fx.tenants;
    for (const [state, reason] of [
      ["archived", null],
      ["needs_review", "drill"],
    ] as const) {
      await fx.api.superuser.query(
        "UPDATE app.project SET state = $2, review_reason = $3 WHERE id = $1",
        [a.project2, state, reason],
      );
      try {
        const answer = await create(`under-${state.replace("_", "-")}`, { project: a.project2 });
        expect(answer.status, state).toBe(409);
        expect(answer.code, state).toBe("state_conflict");
      } finally {
        await fx.api.superuser.query(
          "UPDATE app.project SET state = 'active', review_reason = NULL WHERE id = $1",
          [a.project2],
        );
      }
    }
  });

  it("under a project of organization B, or with project 2's id on organization B's path → 404", async () => {
    const { a, b } = fx.tenants;
    expect((await create("cross", { org: b.organizationId, project: b.project1 })).status).toBe(
      404,
    );
    expect((await create("cross", { org: b.organizationId, project: a.project2 })).status).toBe(
      404,
    );
    expect(await environmentsNamed(a.project2, "cross")).toBe(0);
  });
});

describe("rename", () => {
  it("keeps id, lock_key, policy_digest, kv_ready, grants and the machine policy in OpenBao byte-identical", async () => {
    const { a } = fx.tenants;
    const row = async () =>
      (
        await fx.api.superuser.query(
          "SELECT id, lock_key, policy_digest, kv_ready, created_at, name FROM app.environment WHERE id = $1",
          [a.env1a],
        )
      ).rows[0] as Record<string, unknown>;
    const grants = async () =>
      (
        await fx.api.superuser.query<{ user_id: string; role: string }>(
          "SELECT user_id, role FROM app.access_grant WHERE environment_id = $1 ORDER BY user_id",
          [a.env1a],
        )
      ).rows;
    const policy = () => fx.admin.readPolicy(fx.namespace, machineName(a.env1a as EnvironmentId));
    const before = { row: await row(), grants: await grants(), policy: await policy() };
    expect(before.policy).not.toBeNull();
    const renamed = await rename(a.env1a, "renamed-dev");
    expect(renamed.status).toBe(200);
    const after = { row: await row(), grants: await grants(), policy: await policy() };
    expect(after.row).toEqual({ ...before.row, name: "renamed-dev" });
    expect(after.grants).toEqual(before.grants);
    expect(after.policy).toBe(before.policy);
    // envEditorA keeps writing there.
    const secrets = `${base(a.organizationId, a.project1)}/${a.env1a}/secrets`;
    const write = await fx.api.request("POST", secrets, {
      body: { name: "A", value: "" },
      cookie: await fx.tenants.cookie("envEditorA"),
      headers: { "idempotency-key": randomUUID() },
    });
    // Every check of the pipeline passed — not a 403 or 404. This fixture's API
    // holds no runtime identity, so the protocol answers 503 (Run 4.2).
    expect(write.status).toBe(503);
    expect(((await write.json()) as { error: { code: string } }).error.code).toBe(
      "dependency_unavailable",
    );
    const denied = await fx.api.superuser.query(
      "SELECT 1 FROM audit.event WHERE action = 'access.denied' AND request_id = $1",
      [write.headers.get("x-request-id")],
    );
    expect(denied.rowCount).toBe(0);
    expect((await rename(a.env1a, "dev")).status).toBe(200);
  });

  it("rename to an existing name → 409 already_exists", async () => {
    const answer = await rename(fx.tenants.a.env1a, "prod");
    expect(answer.status).toBe(409);
    expect(answer.code).toBe("already_exists");
  });
});

describe("permissions and replay (one each)", () => {
  it("an editor of the project gets 403 and nothing is created", async () => {
    const answer = await create("by-editor", { user: "editorA" });
    expect(answer.status).toBe(403);
    expect(await environmentsNamed(fx.tenants.a.project1, "by-editor")).toBe(0);
  });

  it("the same key and body again → the same 201 body, one environment", async () => {
    const key = randomUUID();
    const first = await create("replayed", { key });
    const again = await create("replayed", { key });
    expect(first.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(await environmentsNamed(fx.tenants.a.project1, "replayed")).toBe(1);
  });
});
