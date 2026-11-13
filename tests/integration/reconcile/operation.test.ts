// Reconciliation of one uncertain operation (Run 4.5, P-75, FR-1.30, FR-1.31,
// AC-1.16). The relay between API and OpenBao makes the uncertainty: `landed`
// holds the answer past the deadline (the change happened), `notLanded`
// swallows the request (it never reached OpenBao). A write proves itself by
// the operation id in its envelope; a delete or undelete leaves no mark, so it
// is settled only after the operator has excluded every executor.
import { randomBytes, randomUUID } from "node:crypto";
import type { OperationId, OrganizationId } from "@mykey/contracts";
import { listUnresolved } from "@mykey/db";
import { namespaceFor, secretPath } from "@mykey/openbao";
import { reconcileOperation, type ReconcileDeps } from "@mykey/operations/operator";
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

type Kind = "create" | "update" | "delete" | "undelete" | "restore";
interface Current {
  version: number;
  stateTag: string;
}
interface Uncertain {
  env: EnvName;
  name: string;
  operationId: OperationId;
  /** The tag the key had before the uncertain request (null for a create). */
  expected: Current | null;
  /** The original request again, with its idempotency key and body. */
  send(): Promise<Answer>;
}

const unique = (): string => `RC_${randomBytes(5).toString("hex").toUpperCase()}`;
const synthetic = (bytes = 30): string => randomBytes(bytes).toString("hex").slice(0, bytes);
const currentOf = (answer: Answer): Current => {
  expect(answer.status, answer.code).toBeLessThan(300);
  return answer.body.result as Current;
};

/** Brings a fresh key to where `kind` applies, then sends `kind` and makes its outcome unknown. */
async function uncertain(
  env: EnvName,
  kind: Kind,
  how: "landed" | "notLanded",
): Promise<Uncertain> {
  const name = unique();
  let expected: Current | null = null;
  if (kind !== "create") {
    expected = currentOf(await f.create(env, name, synthetic(40)));
    if (kind === "restore") expected = currentOf(await f.update(env, name, synthetic(), expected));
    if (kind === "undelete") expected = currentOf(await f.act(env, name, "delete", expected));
  }
  const key = randomUUID();
  const value = synthetic(24);
  const tag = expected;
  const send = (): Promise<Answer> => {
    if (kind === "create") return f.create(env, name, value, { key });
    if (tag === null) throw new Error("a versioned action needs its expected tag");
    if (kind === "update") return f.update(env, name, value, tag, { key });
    return f.act(env, name, kind, tag, {
      key,
      ...(kind === "restore" ? { sourceVersion: 1 } : {}),
    });
  };
  f.setFaults((at) => {
    if (at !== "after_dispatch_marker") return;
    if (how === "landed") f.relay.delayResponses(8_000);
    else f.relay.swallowRequests(true);
  });
  let answer: Answer;
  try {
    answer = await send();
  } finally {
    f.setFaults(null);
    f.relay.clear();
  }
  expect(answer.status).toBe(503);
  expect(answer.code).toBe("outcome_unknown");
  return { env, name, operationId: answer.operationId as OperationId, expected, send };
}

const deps = (): ReconcileDeps => ({
  database: f.api.database.pool("maintenance"),
  bao: f.operatorBao(),
  operatorId: null,
  requestId: randomUUID(),
});

const settle = (u: Uncertain, executorsExcluded: boolean, closeUnknown = false) =>
  reconcileOperation(deps(), u.operationId, { executorsExcluded, closeUnknown });

const operation = async (id: string) =>
  (
    await f.api.superuser.query<{
      state: string;
      error_code: string | null;
      completed_at: Date | null;
      principal_id: string;
      result: Record<string, unknown> | null;
    }>(
      "SELECT state, error_code, completed_at, principal_id, result FROM app.operation WHERE id = $1",
      [id],
    )
  ).rows[0];

const slotHeld = async (u: Uncertain): Promise<boolean> =>
  (
    await f.api.superuser.query("SELECT 1 FROM app.effect_slot WHERE operation_id = $1", [
      u.operationId,
    ])
  ).rowCount === 1;

const reconcileAudits = async (u: Uncertain): Promise<number> =>
  (
    await f.api.superuser.query(
      `SELECT 1 FROM audit.event WHERE action = 'operator.reconcile_operation'
          AND operation_id = $1 AND actor_kind = 'operator'`,
      [u.operationId],
    )
  ).rowCount ?? 0;

const liveBytes = async (env: EnvName): Promise<number> =>
  Number(
    (
      await f.api.superuser.query<{ live_value_bytes: string }>(
        "SELECT live_value_bytes FROM app.environment WHERE id = $1",
        [f.env(env).environmentId],
      )
    ).rows[0]?.live_value_bytes,
  );

describe("a write", () => {
  it("a landed update, no exclusion → succeeded: live at the new version, a new tag, counters right, slot free, the version event names the original user, the original key replays 200, one operator.reconcile_operation", async () => {
    const u = await uncertain("env1a", "update", "landed");
    expect((await f.indexRow("env1a", u.name))?.state).toBe("needs_review");
    expect(await settle(u, false)).toEqual({ kind: "succeeded", version: 2 });
    const row = await f.indexRow("env1a", u.name);
    expect(row?.state).toBe("live");
    expect(row?.current_version).toBe(2);
    expect(row?.state_tag === u.expected?.stateTag).toBe(false);
    expect(await slotHeld(u)).toBe(false);
    await expectIndexMatchesBackend(f, "env1a");
    const op = await operation(u.operationId);
    expect(op?.state).toBe("succeeded");
    expect(op?.result).toMatchObject({
      name: u.name,
      version: 2,
      state: "live",
      stateTag: row?.state_tag,
    });
    const events = await f.api.superuser.query<{
      actor_kind: string;
      actor_id: string;
      action: string;
    }>(
      "SELECT actor_kind, actor_id, action FROM app.secret_version_event WHERE operation_id = $1",
      [u.operationId],
    );
    expect(events.rows).toEqual([
      { actor_kind: "user", actor_id: op?.principal_id, action: "secret.update" },
    ]);
    const replay = await u.send();
    expect(replay.status).toBe(200);
    expect(replay.body.operationId).toBe(u.operationId);
    expect(replay.body.result).toEqual(op?.result);
    expect(await reconcileAudits(u)).toBe(1);
  }, 60_000);

  it("a not-landed update, no exclusion → undetermined executors_not_excluded; nothing changed, slot held", async () => {
    const u = await uncertain("env1a", "update", "notLanded");
    const before = await f.indexRow("env1a", u.name);
    expect(await settle(u, false)).toEqual({
      kind: "undetermined",
      reason: "executors_not_excluded",
    });
    expect(await f.indexRow("env1a", u.name)).toEqual(before);
    expect(await slotHeld(u)).toBe(true);
    expect((await operation(u.operationId))?.state).toBe("uncertain");
    expect(await reconcileAudits(u)).toBe(0);
    // Then with exclusion (the next case's verdict), so the environment is free again.
    expect((await settle(u, true)).kind).toBe("rejected");
  }, 60_000);

  it("a not-landed update, exclusion → rejected: live at its old version with a new tag; the original key answers 503 dependency_unavailable; an update with the new tag succeeds", async () => {
    const u = await uncertain("env1b", "update", "notLanded");
    expect(await settle(u, true)).toEqual({ kind: "rejected" });
    const row = await f.indexRow("env1b", u.name);
    expect(row?.state).toBe("live");
    expect(row?.current_version).toBe(1);
    expect(row?.state_tag === u.expected?.stateTag).toBe(false);
    expect((await operation(u.operationId))?.error_code).toBe("dependency_unavailable");
    await expectIndexMatchesBackend(f, "env1b");
    const replay = await u.send();
    expect(replay.status).toBe(503);
    expect(replay.code).toBe("dependency_unavailable");
    expect(replay.operationId).toBe(u.operationId);
    const next = await f.update("env1b", u.name, synthetic(), {
      version: 1,
      stateTag: row?.state_tag ?? "",
    });
    expect(next.status).toBe(200);
    expect(await reconcileAudits(u)).toBe(1);
  }, 60_000);

  it("a landed create → live at version 1", async () => {
    const u = await uncertain("env2a", "create", "landed");
    expect(await settle(u, false)).toEqual({ kind: "succeeded", version: 1 });
    expect((await f.indexRow("env2a", u.name))?.state).toBe("live");
    await expectIndexMatchesBackend(f, "env2a");
    expect((await u.send()).status).toBe(201);
  }, 60_000);

  it("a not-landed create, exclusion → the index row is gone and the name can be created", async () => {
    const u = await uncertain("env2a", "create", "notLanded");
    expect(await settle(u, true)).toEqual({ kind: "rejected" });
    expect(await f.indexRow("env2a", u.name)).toBeNull();
    await expectIndexMatchesBackend(f, "env2a");
    expect((await f.create("env2a", u.name, synthetic())).status).toBe(201);
  }, 60_000);

  it("a landed restore → succeeded at version 3", async () => {
    const u = await uncertain("env1a", "restore", "landed");
    expect(await settle(u, false)).toEqual({ kind: "succeeded", version: 3 });
    expect((await f.indexRow("env1a", u.name))?.state).toBe("live");
    await expectIndexMatchesBackend(f, "env1a");
  }, 60_000);
});

describe("a delete or undelete", () => {
  it("a landed delete: no exclusion → undetermined; with exclusion → succeeded, state deleted, live bytes reduced", async () => {
    const u = await uncertain("env1b", "delete", "landed");
    const bytes = await liveBytes("env1b");
    expect(await settle(u, false)).toEqual({
      kind: "undetermined",
      reason: "executors_not_excluded",
    });
    expect(await settle(u, true)).toEqual({ kind: "succeeded", version: 1 });
    expect((await f.indexRow("env1b", u.name))?.state).toBe("deleted");
    expect(await liveBytes("env1b")).toBe(bytes - 40);
    await expectIndexMatchesBackend(f, "env1b");
    expect((await u.send()).status).toBe(200);
  }, 60_000);

  it("a not-landed delete, exclusion → rejected, live", async () => {
    const u = await uncertain("env1b", "delete", "notLanded");
    expect(await settle(u, true)).toEqual({ kind: "rejected" });
    expect((await f.indexRow("env1b", u.name))?.state).toBe("live");
    await expectIndexMatchesBackend(f, "env1b");
  }, 60_000);

  it("a landed undelete: no exclusion → undetermined; with exclusion → succeeded, live again", async () => {
    const u = await uncertain("env2a", "undelete", "landed");
    expect((await settle(u, false)).kind).toBe("undetermined");
    expect(await settle(u, true)).toEqual({ kind: "succeeded", version: 1 });
    expect((await f.indexRow("env2a", u.name))?.state).toBe("live");
    await expectIndexMatchesBackend(f, "env2a");
  }, 60_000);

  it("a not-landed undelete, exclusion → rejected, still deleted", async () => {
    const u = await uncertain("env2a", "undelete", "notLanded");
    expect(await settle(u, true)).toEqual({ kind: "rejected" });
    expect((await f.indexRow("env2a", u.name))?.state).toBe("deleted");
    await expectIndexMatchesBackend(f, "env2a");
  }, 60_000);
});

describe("evidence that does not decide", () => {
  it("a version written and destroyed by someone else → evidence_conflict; closeUnknown → closed_unknown, the row still uncertain, the slot free, the key rebuilt, the replay 503 outcome_unknown, no longer unresolved", async () => {
    const u = await uncertain("env1a", "update", "notLanded");
    const { projectId, environmentId } = f.env("env1a");
    const path = secretPath(projectId, environmentId, u.name);
    const other = randomUUID() as OperationId;
    const written = await f
      .operatorBao()
      .kvWrite(path, { value: synthetic(), operation_id: other, format: 1 }, 1, {
        operationId: other,
        dispatchId: randomUUID(),
      });
    expect(written.ok).toBe(true);
    const destroyed = await baoFetch(f.stack, `/v1/kv/destroy/${path}`, {
      method: "POST",
      namespace: namespaceFor(f.tenants.a.organizationId as OrganizationId),
      body: { versions: [2] },
    });
    expect(destroyed.status).toBe(204);

    expect(await settle(u, true)).toEqual({ kind: "undetermined", reason: "evidence_conflict" });
    expect(await slotHeld(u)).toBe(true);
    expect(await settle(u, false, true)).toEqual({
      kind: "undetermined",
      reason: "executors_not_excluded",
    });

    expect(await settle(u, true, true)).toEqual({ kind: "closed_unknown" });
    const op = await operation(u.operationId);
    expect(op?.state).toBe("uncertain");
    expect(op?.completed_at).not.toBeNull();
    expect(await slotHeld(u)).toBe(false);
    const row = await f.indexRow("env1a", u.name);
    expect(row?.current_version).toBe(2);
    expect(row?.state).toBe("deleted");
    const replay = await u.send();
    expect(replay.status).toBe(503);
    expect(replay.code).toBe("outcome_unknown");
    const unresolved = await listUnresolved(
      f.api.superuser,
      f.tenants.a.organizationId as OrganizationId,
    );
    expect(unresolved.map((entry) => entry.id)).not.toContain(u.operationId);
    expect(await reconcileAudits(u)).toBe(1);
  }, 60_000);

  it("a succeeded operation → not_unresolved, nothing changes; settling twice: the second is not_unresolved", async () => {
    const name = unique();
    const created = await f.create("env2a", name, synthetic());
    expect(
      await reconcileOperation(deps(), created.operationId as OperationId, {
        executorsExcluded: true,
      }),
    ).toEqual({ kind: "undetermined", reason: "not_unresolved" });
    const u = await uncertain("env2a", "update", "landed");
    expect((await settle(u, false)).kind).toBe("succeeded");
    const row = await f.indexRow("env2a", u.name);
    expect(await settle(u, true)).toEqual({ kind: "undetermined", reason: "not_unresolved" });
    expect(await f.indexRow("env2a", u.name)).toEqual(row);
    expect(await reconcileAudits(u)).toBe(1);
  }, 60_000);
});
