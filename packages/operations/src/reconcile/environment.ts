// The operator's rebuild of a whole environment's index (Run 4.5, P-75,
// FR-1.88). Under the environment's lock (2 s, else busy) and with no
// operation of the environment unresolved and no slot held — the lock and the
// empty slot are the proof that no change is in flight, so it needs no
// executor exclusion. Every name of the backend and of the index is rebuilt
// (rebuildKey), the counters are summed again, the generation rises by one,
// and an environment in review whose KV is ready becomes active.
import { appendAudit } from "@mykey/audit";
import { SECRET_NAME_PATTERN } from "@mykey/contracts";
import {
  indexNames,
  listUnresolved,
  recomputeCounters,
  slotOf,
  environmentCounters,
  type EnvironmentScope,
} from "@mykey/db";
import { environmentPrefix } from "@mykey/openbao";
import { Busy, inTransaction, withEnvironmentLock } from "../secrets/lock.ts";
import type { ReconcileDeps } from "./operation.ts";
import { BackendUnreadable, rebuildKey } from "./rebuild.ts";

export type EnvironmentVerdict =
  | { kind: "rebuilt"; names: number; changed: number }
  | { kind: "refused"; reason: "unresolved_operations" | "backend_unreadable" | "busy" };

/** How long the rebuild waits for the environment's lock. */
export const RECONCILE_LOCK_WAIT_MS = 2_000;

export async function reconcileEnvironment(
  deps: ReconcileDeps,
  scope: EnvironmentScope,
): Promise<EnvironmentVerdict> {
  const { lockKey } = await environmentCounters(deps.database, scope);
  try {
    return await withEnvironmentLock(
      deps.database,
      lockKey,
      async (locked): Promise<EnvironmentVerdict> => {
        const unresolved = await listUnresolved(locked.client, scope.organizationId);
        if (
          unresolved.some((entry) => entry.environmentId === scope.environmentId) ||
          (await slotOf(locked.client, scope)) !== null
        ) {
          return { kind: "refused", reason: "unresolved_operations" };
        }
        const listed = await deps.bao.kvList(
          environmentPrefix(scope.projectId, scope.environmentId),
        );
        if (!listed.ok && listed.kind !== "not_found") {
          return { kind: "refused", reason: "backend_unreadable" };
        }
        // A listed key that is not a valid name (a folder, a foreign key) cannot have a row.
        const backend = listed.ok
          ? listed.data.names.filter((n) => SECRET_NAME_PATTERN.test(n))
          : [];
        const names = [
          ...new Set([...backend, ...(await indexNames(locked.client, scope))]),
        ].sort();
        try {
          return await inTransaction(locked.client, async (tx) => {
            let changed = 0;
            for (const name of names) {
              if ((await rebuildKey(tx, deps.bao, scope, name, null)) !== "unchanged") changed += 1;
            }
            await recomputeCounters(tx, scope);
            await tx.query(
              `UPDATE app.environment SET state = 'active', review_reason = NULL
                WHERE organization_id = $1 AND id = $2 AND state = 'needs_review' AND kv_ready`,
              [scope.organizationId, scope.environmentId],
            );
            await appendAudit(tx, {
              action: "operator.reconcile_environment",
              actor: { kind: "operator", id: deps.operatorId },
              source: "operator",
              organizationId: scope.organizationId,
              target: { kind: "environment", id: scope.environmentId },
              outcome: "success",
              requestId: deps.requestId,
              operationId: null,
              details: { names: names.length, changed },
            });
            return { kind: "rebuilt", names: names.length, changed };
          });
        } catch (error) {
          if (error instanceof BackendUnreadable) {
            return { kind: "refused", reason: "backend_unreadable" };
          }
          throw error;
        }
      },
      RECONCILE_LOCK_WAIT_MS,
    );
  } catch (error) {
    if (error instanceof Busy) return { kind: "refused", reason: "busy" };
    throw error;
  }
}
