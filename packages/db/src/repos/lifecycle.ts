// Archive and reactivation (Run 5.3, P-91, P-92, D-41): every state change of
// a project or an environment goes through app.lifecycle_transition
// (migration 0014), one guarded update per step.
import type { OperationId, OrganizationId } from "@mykey/contracts";
import type { Queryable } from "../tx.ts";

export type LifecycleStep = "begin_archive" | "finish_archive" | "reactivate";

/** One step; false: its guard did not hold and nothing changed. */
export async function lifecycleTransition(
  tx: Queryable,
  t: {
    kind: "project" | "environment";
    organizationId: OrganizationId;
    id: string;
    operationId: OperationId;
    step: LifecycleStep;
    origin?: "self" | "project";
  },
): Promise<boolean> {
  const result = await tx.query<{ moved: boolean }>(
    "SELECT app.lifecycle_transition($1, $2, $3, $4, $5, $6) AS moved",
    [t.kind, t.organizationId, t.id, t.operationId, t.step, t.origin ?? null],
  );
  return result.rows[0]?.moved === true;
}
