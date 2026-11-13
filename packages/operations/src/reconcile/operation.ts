// The operator's settlement of one unresolved secret operation (Run 4.5,
// P-75, D-38; Doc 06 §6.4; FR-1.30, FR-1.31). Evidence: the step's
// before_state, the operation's expected version, the key's metadata now, and
// for a write the envelope of every version above the one it started from.
//
// - A write proves itself: a version whose envelope carries the operation id
//   → succeeded, with or without exclusion (a write cannot land twice). No
//   such version: without exclusion → undetermined (its late twin may still
//   arrive); with exclusion and nothing above the start → rejected; anything
//   else above it → evidence_conflict.
// - A delete or undelete leaves no mark (D-20): it is judged only once the
//   operator has excluded every executor. The expected version current and in
//   the target state → succeeded; in the state before → rejected; anything
//   else → evidence_conflict.
// - closeUnknown (with exclusion, for evidence_conflict only): the operation
//   stays uncertain for ever and stops counting as unresolved.
//
// Every settlement is one transaction under the environment's lock: the row
// settled, the key rebuilt from the backend, the counters summed again, a
// version event for a change that happened, the slot released, one audit row.
import { appendAudit } from "@mykey/audit";
import { LIMITS, type OperationId } from "@mykey/contracts";
import {
  environmentCounters,
  findOperation,
  readIndexRow,
  recomputeCounters,
  recordVersionEvent,
  releaseSlot,
  settleOperation,
  type EnvironmentScope,
  type OperationRow,
  type Settlement,
} from "@mykey/db";
import { secretPath, type OpenBaoClient } from "@mykey/openbao";
import type pg from "pg";
import { inTransaction, withEnvironmentLock } from "../secrets/lock.ts";
import { SWEPT_ACTIONS, sweepStaleOperations } from "../secrets/sweep.ts";
import { BackendUnreadable, rebuildKey } from "./rebuild.ts";

export interface ReconcileDeps {
  /** Logged in as `maintenance`. */
  database: pg.Pool;
  /** The operator's token, in the organization's namespace. */
  bao: OpenBaoClient;
  /** The operator has no id of their own today; null. */
  operatorId: string | null;
  requestId: string;
}

export type OperationVerdict =
  | { kind: "succeeded"; version: number }
  | { kind: "rejected" }
  | { kind: "closed_unknown" }
  | {
      kind: "undetermined";
      reason:
        "executors_not_excluded" | "backend_unreadable" | "evidence_conflict" | "not_unresolved";
    };

/** No operation has this id. */
export class UnknownOperation extends Error {
  constructor() {
    super("unknown operation");
    this.name = "UnknownOperation";
  }
}

const undetermined = (
  reason: Extract<OperationVerdict, { kind: "undetermined" }>["reason"],
): OperationVerdict => ({ kind: "undetermined", reason });

type Evidence =
  | { kind: "succeeded"; version: number }
  | { kind: "rejected" }
  | { kind: "conflict" }
  | { kind: "not_excluded" }
  | { kind: "unreadable" };

interface BeforeState {
  backendCurrentVersion: number | null;
}

const unresolved = (row: OperationRow): boolean =>
  row.state === "uncertain" && row.completedAt === null;

export async function reconcileOperation(
  deps: ReconcileDeps,
  operationId: OperationId,
  opts: { executorsExcluded: boolean; closeUnknown?: boolean },
): Promise<OperationVerdict> {
  let row = await findOperation(deps.database, operationId);
  if (row === null) throw new UnknownOperation();
  if (row.state === "accepted" || row.state === "executing") {
    // A stale row is first moved by the sweep's own rule; a fresh one is still running.
    await sweepStaleOperations(deps.database);
    row = (await findOperation(deps.database, operationId)) ?? row;
  }
  const scope = scopeOf(row);
  if (scope === null || SWEPT_ACTIONS[row.action] === undefined || !unresolved(row)) {
    return undetermined("not_unresolved");
  }
  const { lockKey } = await environmentCounters(deps.database, scope);
  return withEnvironmentLock(deps.database, lockKey, async (locked) => {
    const current = await findOperation(locked.client, operationId);
    if (current === null || !unresolved(current)) return undetermined("not_unresolved");
    const evidence = await gather(deps.bao, locked.client, current, scope, opts.executorsExcluded);
    switch (evidence.kind) {
      case "not_excluded":
        return undetermined("executors_not_excluded");
      case "unreadable":
        return undetermined("backend_unreadable");
      case "conflict":
        if (!(opts.executorsExcluded && opts.closeUnknown === true)) {
          return undetermined("evidence_conflict");
        }
        return settle(deps, locked.client, current, scope, { kind: "closed_unknown" }, opts);
      default:
        return settle(deps, locked.client, current, scope, evidence, opts);
    }
  });
}

function scopeOf(row: OperationRow): (EnvironmentScope & { name: string }) | null {
  if (
    row.organizationId === null ||
    row.projectId === null ||
    row.environmentId === null ||
    row.secretName === null
  ) {
    return null;
  }
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    name: row.secretName,
  };
}

async function gather(
  bao: OpenBaoClient,
  db: pg.PoolClient,
  row: OperationRow,
  scope: EnvironmentScope & { name: string },
  excluded: boolean,
): Promise<Evidence> {
  const path = secretPath(scope.projectId, scope.environmentId, scope.name);
  const write =
    row.action === "secrets.create" ||
    row.action === "secrets.update" ||
    row.action === "secrets.restore";
  if (!write && !excluded) return { kind: "not_excluded" };
  const metadata = await bao.kvMetadata(path);
  if (!metadata.ok && metadata.kind !== "not_found") return { kind: "unreadable" };
  const currentVersion = metadata.ok ? metadata.data.currentVersion : 0;

  if (write) {
    const step = await db.query<{ before_state: BeforeState | null }>(
      "SELECT before_state FROM app.operation_step WHERE operation_id = $1 AND ordinal = 1",
      [row.id],
    );
    const before = step.rows[0]?.before_state?.backendCurrentVersion ?? 0;
    for (let version = before + 1; version <= currentVersion; version += 1) {
      const read = await bao.kvRead(path, version);
      if (read.ok && read.data.envelope.operation_id === row.id) {
        return { kind: "succeeded", version };
      }
      // Deleted, destroyed or not an envelope reads as not_found / invalid 200; anything else is unreadable.
      if (
        !read.ok &&
        read.kind !== "not_found" &&
        !(read.kind === "invalid" && read.status === 200)
      ) {
        return { kind: "unreadable" };
      }
    }
    if (!excluded) return { kind: "not_excluded" };
    return currentVersion === before ? { kind: "rejected" } : { kind: "conflict" };
  }

  // A delete or undelete, executors excluded.
  const expected = (row.expected as { version?: unknown } | null)?.version;
  if (!metadata.ok || typeof expected !== "number" || currentVersion !== expected) {
    return { kind: "conflict" };
  }
  const entry = metadata.data.versions[String(expected)];
  if (entry === undefined || entry.destroyed) return { kind: "conflict" };
  const target = row.action === "secrets.delete";
  return entry.deleted === target ? { kind: "succeeded", version: expected } : { kind: "rejected" };
}

async function settle(
  deps: ReconcileDeps,
  client: pg.PoolClient,
  row: OperationRow,
  scope: EnvironmentScope & { name: string },
  verdict:
    { kind: "succeeded"; version: number } | { kind: "rejected" } | { kind: "closed_unknown" },
  opts: { executorsExcluded: boolean },
): Promise<OperationVerdict> {
  try {
    return await inTransaction(client, async (tx) => {
      await rebuildKey(tx, deps.bao, scope, scope.name, row.id);
      const generation = await recomputeCounters(tx, scope);
      const rebuilt = await readIndexRow(tx, scope, scope.name);
      const settlement: Settlement =
        verdict.kind === "succeeded"
          ? {
              state: "succeeded",
              result: {
                name: scope.name,
                version: verdict.version,
                stateTag: rebuilt?.stateTag ?? null,
                state: rebuilt?.state ?? null,
                generation: generation.toString(),
              },
            }
          : verdict.kind === "rejected"
            ? { state: "rejected", errorCode: "dependency_unavailable" }
            : { state: "uncertain" };
      if (
        !(await settleOperation(tx, row.id, settlement, LIMITS.operation.terminalRetentionDays))
      ) {
        throw new NotUnresolved();
      }
      if (verdict.kind !== "closed_unknown") {
        await tx.query(
          `UPDATE app.operation_step SET outcome = $2,
                  backend_ref = coalesce($3, backend_ref)
            WHERE operation_id = $1 AND ordinal = 1`,
          [row.id, verdict.kind, verdict.kind === "succeeded" ? String(verdict.version) : null],
        );
      }
      if (verdict.kind === "succeeded") {
        await recordVersionEvent(tx, scope, {
          name: scope.name,
          version: verdict.version,
          operationId: row.id,
          actorKind: row.principalKind === "user" ? "user" : "system",
          actorId: row.principalKind === "user" ? row.principalId : null,
          action: SWEPT_ACTIONS[row.action] ?? row.action,
        });
      }
      await releaseSlot(tx, row.id);
      await appendAudit(tx, {
        action: "operator.reconcile_operation",
        actor: { kind: "operator", id: deps.operatorId },
        source: "operator",
        organizationId: scope.organizationId,
        target: { kind: "environment", id: scope.environmentId },
        outcome: "success",
        requestId: deps.requestId,
        operationId: row.id,
        details: {
          name: scope.name,
          verdict: verdict.kind,
          executorsExcluded: opts.executorsExcluded,
        },
      });
      return verdict.kind === "succeeded"
        ? { kind: "succeeded", version: verdict.version }
        : { kind: verdict.kind };
    });
  } catch (error) {
    if (error instanceof BackendUnreadable) return undetermined("backend_unreadable");
    if (error instanceof NotUnresolved) return undetermined("not_unresolved");
    throw error;
  }
}

class NotUnresolved extends Error {}
