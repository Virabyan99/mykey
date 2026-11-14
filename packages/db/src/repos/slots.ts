// Effect slots (Doc 06 §6.1): one row per scope with an effect in flight. A
// slot is released by the finalize of its operation, or by the operator's
// reconciliation (Run 4.5) — never by time.
import type { OperationId } from "@mykey/contracts";
import type pg from "pg";
import type { EnvironmentScope } from "../scope.ts";
import type { Queryable } from "../tx.ts";

export const slotKey = (scope: EnvironmentScope): string => `env:${scope.environmentId}`;

/** The holder of the environment's slot, with the name its operation acts on; null when free. */
export async function slotOf(
  db: Queryable,
  scope: EnvironmentScope,
): Promise<{ operationId: OperationId; secretName: string | null } | null> {
  const result = await db.query<{ operation_id: OperationId; secret_name: string | null }>(
    `SELECT s.operation_id, o.secret_name FROM app.effect_slot s
       JOIN app.operation o ON o.id = s.operation_id
      WHERE s.scope_key = $1`,
    [slotKey(scope)],
  );
  const row = result.rows[0];
  return row === undefined ? null : { operationId: row.operation_id, secretName: row.secret_name };
}

export async function takeSlot(
  tx: pg.PoolClient,
  scope: EnvironmentScope,
  operationId: OperationId,
  stepId: string,
  generation: bigint,
): Promise<void> {
  await tx.query(
    `INSERT INTO app.effect_slot (scope_key, operation_id, step_id, generation, acquired_at)
     VALUES ($1, $2, $3, $4, now())`,
    [slotKey(scope), operationId, stepId, generation.toString()],
  );
}

export async function releaseSlot(tx: Queryable, operationId: OperationId): Promise<void> {
  await tx.query("DELETE FROM app.effect_slot WHERE operation_id = $1", [operationId]);
}
