// Reconciliation of a whole environment (Run 4.5, P-75, FR-1.88): under the
// environment's lock and with no operation unresolved, every name of the
// backend and of the index is rebuilt from OpenBao; the counters are summed
// again; an environment in review becomes active.
import { randomBytes, randomUUID } from "node:crypto";
import type { OperationId, OrganizationId } from "@mykey/contracts";
import type { EnvironmentScope } from "@mykey/db";
import { secretPath } from "@mykey/openbao";
import {
  reconcileEnvironment,
  reconcileOperation,
  type ReconcileDeps,
} from "@mykey/operations/operator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";
import { baoFetch } from "../../harness/stack.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

const unique = (): string => `RE_${randomBytes(5).toString("hex").toUpperCase()}`;
const synthetic = (bytes = 30): string => randomBytes(bytes).toString("hex").slice(0, bytes);

const deps = (): ReconcileDeps => ({
  database: f.api.database.pool("maintenance"),
  bao: f.operatorBao(),
  operatorId: null,
  requestId: randomUUID(),
});

const scopeOf = (env: EnvName): EnvironmentScope => ({
  organizationId: f.tenants.a.organizationId as OrganizationId,
  projectId: f.env(env).projectId,
  environmentId: f.env(env).environmentId,
});

const environment = async (env: EnvName) =>
  (
    await f.api.superuser.query<{ state: string; generation: string }>(
      "SELECT state, metadata_generation::text AS generation FROM app.environment WHERE id = $1",
      [f.env(env).environmentId],
    )
  ).rows[0];

const created = async (env: EnvName, name: string, bytes = 30): Promise<Answer> => {
  const answer = await f.create(env, name, synthetic(bytes));
  expect(answer.status, answer.code).toBe(201);
  return answer;
};

describe("reconcileEnvironment", () => {
  it("drift on a request: the runtime policy emptied → 503 backend_inconsistent, the environment in review, one system.drift_detected; the policy put back, reconcile → rebuilt, active, a create succeeds", async () => {
    const namespace = f.fx.namespace;
    const policyPath = "/v1/sys/policies/acl/runtime";
    const original = (await (await baoFetch(f.stack, policyPath, { namespace })).json()) as {
      data: { policy: string };
    };
    const replaced = await baoFetch(f.stack, policyPath, {
      method: "PUT",
      namespace,
      body: { policy: 'path "sys/nothing" { capabilities = ["deny"] }' },
    });
    expect(replaced.status).toBe(204);
    const requestsBefore = await f.api.superuser.query(
      "SELECT 1 FROM audit.event WHERE action = 'system.drift_detected'",
    );
    try {
      const refused = await f.create("env2a", unique(), synthetic());
      expect(refused.status).toBe(503);
      expect(refused.code).toBe("backend_inconsistent");
      expect((await environment("env2a"))?.state).toBe("needs_review");
      const drift = await f.api.superuser.query<{ details: Record<string, unknown> }>(
        "SELECT details FROM audit.event WHERE action = 'system.drift_detected' AND target_id = $1",
        [f.env("env2a").environmentId],
      );
      expect(drift.rowCount).toBe(1);
      expect(drift.rows[0]?.details).toMatchObject({ object: "kv_data" });
      expect(
        (
          await f.api.superuser.query(
            "SELECT 1 FROM audit.event WHERE action = 'system.drift_detected'",
          )
        ).rowCount,
      ).toBe((requestsBefore.rowCount ?? 0) + 1);
    } finally {
      const restored = await baoFetch(f.stack, policyPath, {
        method: "PUT",
        namespace,
        body: { policy: original.data.policy },
      });
      expect(restored.status).toBe(204);
    }
    const generation = BigInt((await environment("env2a"))?.generation ?? "0");
    const result = await reconcileEnvironment(deps(), scopeOf("env2a"));
    expect(result.kind).toBe("rebuilt");
    const after = await environment("env2a");
    expect(after?.state).toBe("active");
    expect(BigInt(after?.generation ?? "0")).toBe(generation + 1n);
    await expectIndexMatchesBackend(f, "env2a");
    await created("env2a", unique());
    const audits = await f.api.superuser.query(
      "SELECT 1 FROM audit.event WHERE action = 'operator.reconcile_environment' AND target_id = $1",
      [f.env("env2a").environmentId],
    );
    expect(audits.rowCount).toBe(1);
  }, 120_000);

  it("an index damaged on purpose is rebuilt to equal the backend: new tags, the generation up by one", async () => {
    const names = [unique(), unique(), unique(), unique()];
    for (const name of names) await created("env1a", name, 40);
    const tags = new Map<string, string>();
    for (const name of names) tags.set(name, (await f.indexRow("env1a", name))?.state_tag ?? "");
    const { environmentId } = f.env("env1a");
    const db = f.api.superuser;
    await db.query(
      "UPDATE app.secret_index SET current_version = 7 WHERE environment_id = $1 AND name = $2",
      [environmentId, names[0]],
    );
    await db.query(
      "UPDATE app.secret_index SET live_value_bytes = 3 WHERE environment_id = $1 AND name = $2",
      [environmentId, names[1]],
    );
    await db.query("DELETE FROM app.secret_index WHERE environment_id = $1 AND name = $2", [
      environmentId,
      names[2],
    ]);
    const ghost = unique();
    await f.seedIndex("env1a", [ghost]);
    await db.query(
      "UPDATE app.environment SET live_value_bytes = live_value_bytes + 999 WHERE id = $1",
      [environmentId],
    );
    const generation = BigInt((await environment("env1a"))?.generation ?? "0");

    const result = await reconcileEnvironment(deps(), scopeOf("env1a"));
    expect(result).toMatchObject({ kind: "rebuilt", changed: 4 });
    await expectIndexMatchesBackend(f, "env1a");
    expect(await f.indexRow("env1a", ghost)).toBeNull();
    for (const name of names.slice(0, 3)) {
      expect((await f.indexRow("env1a", name))?.state_tag === tags.get(name), name).toBe(false);
    }
    // The undamaged row keeps its tag: a client holding it is not refused for nothing.
    expect((await f.indexRow("env1a", names[3] ?? ""))?.state_tag).toBe(tags.get(names[3] ?? ""));
    expect(BigInt((await environment("env1a"))?.generation ?? "0")).toBe(generation + 1n);
  }, 120_000);

  it("refuses while an operation of the environment is unresolved", async () => {
    const name = unique();
    const current = (await created("env1b", name)).body.result as {
      version: number;
      stateTag: string;
    };
    f.setFaults((at) => {
      if (at === "after_dispatch_marker") f.relay.swallowRequests(true);
    });
    let answer: Answer;
    try {
      answer = await f.update("env1b", name, synthetic(), current);
    } finally {
      f.setFaults(null);
      f.relay.clear();
    }
    expect(answer.code).toBe("outcome_unknown");
    expect(await reconcileEnvironment(deps(), scopeOf("env1b"))).toEqual({
      kind: "refused",
      reason: "unresolved_operations",
    });
    expect(
      await reconcileOperation(deps(), answer.operationId as OperationId, {
        executorsExcluded: true,
      }),
    ).toEqual({ kind: "rejected" });
    expect((await reconcileEnvironment(deps(), scopeOf("env1b"))).kind).toBe("rebuilt");
  }, 60_000);

  it("answers busy while the environment's lock is held", async () => {
    const lock = await f.api.superuser.query<{ lock_key: string }>(
      "SELECT lock_key::text FROM app.environment WHERE id = $1",
      [f.env("env1b").environmentId],
    );
    const client = await f.api.superuser.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1::bigint)", [lock.rows[0]?.lock_key]);
      const started = Date.now();
      expect(await reconcileEnvironment(deps(), scopeOf("env1b"))).toEqual({
        kind: "refused",
        reason: "busy",
      });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await client.query("SELECT pg_advisory_unlock_all()");
      client.release();
    }
  }, 30_000);

  it("300 names written past the index are rebuilt within 60 s", async () => {
    const { projectId, environmentId } = f.env("env1b");
    const names = Array.from({ length: 300 }, () => unique());
    for (let i = 0; i < names.length; i += 25) {
      await Promise.all(
        names.slice(i, i + 25).map(async (name) => {
          const id = randomUUID() as OperationId;
          const written = await f
            .operatorBao()
            .kvWrite(
              secretPath(projectId, environmentId, name),
              { value: synthetic(20), operation_id: id, format: 1 },
              0,
              { operationId: id, dispatchId: randomUUID() },
            );
          expect(written.ok).toBe(true);
        }),
      );
    }
    const started = Date.now();
    const result = await reconcileEnvironment(deps(), scopeOf("env1b"));
    const elapsed = Date.now() - started;
    expect(result.kind).toBe("rebuilt");
    expect(result.kind === "rebuilt" ? result.changed : 0).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(60_000);
    await expectIndexMatchesBackend(f, "env1b");
  }, 180_000);
});
