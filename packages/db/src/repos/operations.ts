// The operation record (Doc 06 §6). This run needs insert and lookup by the
// idempotency key; later runs add the state transitions.
import type { OperationId, OperationState, OrganizationId } from "@mykey/contracts";
import type pg from "pg";
import type { Queryable } from "../tx.ts";

export type PrincipalKind = "user" | "machine" | "operator" | "system";

/** The five columns of the unique key `operation_idempotency_key`. */
export interface OperationKey {
  principalKind: PrincipalKind;
  principalId: string;
  action: string;
  target: string;
  idempotencyKey: string;
}

export interface OperationRow extends OperationKey {
  id: OperationId;
  organizationId: OrganizationId | null;
  state: OperationState;
  fingerprint: Buffer | null;
  fingerprintKeyId: string | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
  /** Until when the outcome replays (Run 3.9); null while unfinished. */
  replayExpiresAt: Date | null;
}

export type NewOperation = OperationKey & {
  id: OperationId;
  organizationId: OrganizationId | null;
  state: OperationState;
  fingerprint: Buffer | null;
  fingerprintKeyId: string | null;
  result: Record<string, unknown> | null;
};

/** Inserts the row, or reports that a row with the same key already exists. */
export async function insertOperation(
  tx: pg.PoolClient,
  row: NewOperation,
): Promise<"inserted" | "exists"> {
  const result = await tx.query(
    `INSERT INTO app.operation
       (id, organization_id, principal_kind, principal_id, action, target, idempotency_key,
        state, fingerprint, fingerprint_key_id, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT ON CONSTRAINT operation_idempotency_key DO NOTHING`,
    [
      row.id,
      row.organizationId,
      row.principalKind,
      row.principalId,
      row.action,
      row.target,
      row.idempotencyKey,
      row.state,
      row.fingerprint,
      row.fingerprintKeyId,
      row.result === null ? null : JSON.stringify(row.result),
    ],
  );
  return result.rowCount === 1 ? "inserted" : "exists";
}

interface StoredOperation {
  id: OperationId;
  organization_id: OrganizationId | null;
  principal_kind: PrincipalKind;
  principal_id: string;
  action: string;
  target: string;
  idempotency_key: string;
  state: OperationState;
  fingerprint: Buffer | null;
  fingerprint_key_id: string | null;
  result: Record<string, unknown> | null;
  error_code: string | null;
  created_at: Date;
  completed_at: Date | null;
  replay_expires_at: Date | null;
}

const COLUMNS = `id, organization_id, principal_kind, principal_id, action, target, idempotency_key,
  state, fingerprint, fingerprint_key_id, result, error_code, created_at, completed_at,
  replay_expires_at`;

function toRow(stored: StoredOperation): OperationRow {
  return {
    id: stored.id,
    organizationId: stored.organization_id,
    principalKind: stored.principal_kind,
    principalId: stored.principal_id,
    action: stored.action,
    target: stored.target,
    idempotencyKey: stored.idempotency_key,
    state: stored.state,
    fingerprint: stored.fingerprint,
    fingerprintKeyId: stored.fingerprint_key_id,
    result: stored.result,
    errorCode: stored.error_code,
    createdAt: stored.created_at,
    completedAt: stored.completed_at,
    replayExpiresAt: stored.replay_expires_at,
  };
}

export async function findOperationByKey(
  db: Queryable,
  key: OperationKey,
): Promise<OperationRow | null> {
  const result = await db.query<StoredOperation>(
    `SELECT ${COLUMNS} FROM app.operation
      WHERE principal_kind = $1 AND principal_id = $2 AND action = $3 AND target = $4
        AND idempotency_key = $5`,
    [key.principalKind, key.principalId, key.action, key.target, key.idempotencyKey],
  );
  const stored = result.rows[0];
  return stored === undefined ? null : toRow(stored);
}

export async function findOperation(db: Queryable, id: OperationId): Promise<OperationRow | null> {
  const result = await db.query<StoredOperation>(
    `SELECT ${COLUMNS} FROM app.operation WHERE id = $1`,
    [id],
  );
  const stored = result.rows[0];
  return stored === undefined ? null : toRow(stored);
}
