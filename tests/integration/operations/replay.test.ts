// Run 4.1 Task B (P-64, P-65, Doc 06 §6.3): the pipeline replays a request by
// the stored state of its operation; the path parameters are part of the
// intent; a terminal record expires into replay_expired; unfinished never.
// A test-only idempotent route stores an operation in the state its body names.
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intentOf } from "@mykey/api";
import { findOperation } from "@mykey/db";
import { COMMANDS } from "@mykey/ops";
import { startTestApi, type TestApi } from "../../harness/api.ts";
import { STATES, TEST_OPS, testOpsHandler } from "../../harness/test-ops.ts";
import { createTenants, type FixtureUser, type Tenants } from "../../harness/tenants.ts";

let api: TestApi;
let tenants: Tenants;

beforeAll(async () => {
  api = await startTestApi({ routes: [{ def: TEST_OPS, handler: testOpsHandler }] });
  tenants = await createTenants(api);
}, 300_000);

afterAll(async () => {
  await api.close();
});

const path = (name: string, env = tenants.a.env1a) =>
  `/v1/organizations/${tenants.a.organizationId}/projects/${tenants.a.project1}/environments/${env}/test-ops/${name}`;

interface Answer {
  status: number;
  code: string | undefined;
  operationId: string | undefined;
  body: Record<string, unknown>;
}

async function send(
  key: string,
  payload: unknown,
  opts: { name?: string; user?: FixtureUser } = {},
): Promise<Answer> {
  const response = await api.request("POST", path(opts.name ?? "A"), {
    body: payload,
    cookie: await tenants.cookie(opts.user ?? "ownerA"),
    headers: { "idempotency-key": key },
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  const error = parsed.error as { code?: string; operationId?: string } | undefined;
  return {
    status: response.status,
    code: error?.code,
    operationId: error?.operationId ?? (parsed.operationId as string | undefined),
    body: parsed,
  };
}

const EXPECTED: Record<(typeof STATES)[number], { status: number; code?: string }> = {
  accepted: { status: 202 },
  executing: { status: 202 },
  awaiting_input: { status: 202 },
  uncertain: { status: 503, code: "outcome_unknown" },
  succeeded: { status: 200 },
  partial: { status: 200 },
  rejected: { status: 409, code: "state_conflict" },
};

describe("replay by stored state", () => {
  it.each(STATES.map((state) => [state]))(
    "%s: the replay answers the status, code and operationId of P-65",
    async (state) => {
      const key = randomUUID();
      const payload = state === "rejected" ? { state, errorCode: "state_conflict" } : { state };
      const first = await send(key, payload);
      const replay = await send(key, payload);
      for (const answer of [first, replay]) {
        expect(answer.status).toBe(EXPECTED[state].status);
        expect(answer.code).toBe(EXPECTED[state].code);
      }
      expect(replay.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(replay.operationId).toBe(first.operationId);
      const stored = await api.superuser.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM app.operation WHERE idempotency_key = $1",
        [key],
      );
      expect(stored.rows[0]?.count).toBe(1);
    },
  );

  it("the same key and body with another :name → 409 idempotency_conflict (control: the same :name replays)", async () => {
    const key = randomUUID();
    expect((await send(key, { state: "succeeded" }, { name: "A" })).status).toBe(200);
    expect((await send(key, { state: "succeeded" }, { name: "A" })).status).toBe(200);
    const other = await send(key, { state: "succeeded" }, { name: "B" });
    expect(other.status).toBe(409);
    expect(other.code).toBe("idempotency_conflict");
  });

  it("the same key with another body → 409 idempotency_conflict", async () => {
    const key = randomUUID();
    expect((await send(key, { state: "succeeded" })).status).toBe(200);
    const other = await send(key, { state: "partial" });
    expect(other.code).toBe("idempotency_conflict");
  });

  it("a terminal row aged past its expiry → 409 replay_expired; after ops operations-expire still 409", async () => {
    const key = randomUUID();
    const first = await send(key, { state: "succeeded" });
    await api.superuser.query(
      "UPDATE app.operation SET replay_expires_at = now() - interval '1 second' WHERE id = $1",
      [first.operationId],
    );
    const expired = await send(key, { state: "succeeded" });
    expect(expired.status).toBe(409);
    expect(expired.code).toBe("replay_expired");

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const code = await COMMANDS["operations-expire"]!.run(
      {},
      {
        stdin: new PassThrough(),
        stdout,
        stderr,
        env: { database: api.database.targets.maintenance },
      },
    );
    expect(code).toBe(0);
    expect(Buffer.concat(chunks).toString()).toMatch(/^expired [1-9]\d*\n$/);
    const audit = await api.superuser.query<{ details: { expired: number } }>(
      "SELECT details FROM audit.event WHERE action = 'operator.operations_expire'",
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    const after = await send(key, { state: "succeeded" });
    expect(after.status).toBe(409);
    expect(after.code).toBe("replay_expired");
    const row = await findOperation(api.pool, first.operationId as never);
    expect(row?.fingerprint).toBeNull();
    expect(row?.result).toBeNull();
    expect(row?.state).toBe("succeeded");
  });

  it("an uncertain row aged 60 days still answers 503 outcome_unknown", async () => {
    const key = randomUUID();
    const first = await send(key, { state: "uncertain" });
    await api.superuser.query(
      "UPDATE app.operation SET created_at = now() - interval '60 days' WHERE id = $1",
      [first.operationId],
    );
    const replay = await send(key, { state: "uncertain" });
    expect(replay.status).toBe(503);
    expect(replay.code).toBe("outcome_unknown");
  });

  it("a rejected row whose error_code the route does not list answers dependency_unavailable and logs unlisted_error", async () => {
    const key = randomUUID();
    const payload = { state: "rejected", errorCode: "credential_not_replayable" };
    await send(key, payload);
    // The handler's own answer logged one; the replay logs another. Both are consumed.
    const before = api.logs.filter((entry) => entry.event === "unlisted_error").length;
    const replay = await send(key, payload);
    expect(replay.status).toBe(503);
    expect(replay.code).toBe("dependency_unavailable");
    const unlisted = api.logs.filter(
      (entry) => entry.event === "unlisted_error" && entry.routeId === "test.ops",
    );
    expect(unlisted.length).toBe(before + 1);
    for (let i = api.logs.length - 1; i >= 0; i -= 1) {
      if (api.logs[i]?.event === "unlisted_error") api.logs.splice(i, 1);
    }
  });

  it("replay happens before the state check: with the environment in review a completed request replays, a new key gets backend_inconsistent", async () => {
    const key = randomUUID();
    expect((await send(key, { state: "succeeded" }, { name: "R" })).status).toBe(200);
    await api.superuser.query(
      "UPDATE app.environment SET state = 'needs_review', review_reason = 'backend_inconsistent' WHERE id = $1",
      [tenants.a.env1a],
    );
    try {
      expect((await send(key, { state: "succeeded" }, { name: "R" })).status).toBe(200);
      const fresh = await send(randomUUID(), { state: "succeeded" }, { name: "R" });
      expect(fresh.status).toBe(503);
      expect(fresh.code).toBe("backend_inconsistent");
    } finally {
      await api.superuser.query(
        "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
        [tenants.a.env1a],
      );
    }
  });

  it("a replay by a user whose grant was removed is 404 (control before the removal)", async () => {
    const key = randomUUID();
    const user = "envEditorA";
    expect((await send(key, { state: "succeeded" }, { user })).status).toBe(200);
    expect((await send(key, { state: "succeeded" }, { user })).status).toBe(200);
    const removed = await api.superuser.query<{ id: string; project_id: string | null }>(
      "DELETE FROM app.access_grant WHERE user_id = $1 RETURNING id",
      [tenants.userId(user)],
    );
    try {
      const after = await send(key, { state: "succeeded" }, { user });
      expect(after.status).toBe(404);
      expect(after.code).toBe("not_found");
    } finally {
      for (const grant of removed.rows) {
        await api.superuser.query(
          `INSERT INTO app.access_grant (id, organization_id, user_id, environment_id, role)
           VALUES ($1, $2, $3, $4, 'editor')`,
          [grant.id, tenants.a.organizationId, tenants.userId(user), tenants.a.env1a],
        );
      }
    }
  });
});

describe("intentOf", () => {
  it("the target is the deepest scope id and params hold the other path parameters", () => {
    const principal = { userId: randomUUID() } as never;
    const params = { org: "o", project: "p", env: "e", name: "DB" };
    expect(intentOf(TEST_OPS, params, principal, { state: "succeeded" })).toMatchObject({
      target: "e",
      params: { name: "DB" },
      action: "test.ops",
    });
    const noParams = intentOf(TEST_OPS, { org: "o", project: "p" }, principal, {});
    expect(noParams.target).toBe("p");
    expect(noParams.params).toBeUndefined();
  });
});
