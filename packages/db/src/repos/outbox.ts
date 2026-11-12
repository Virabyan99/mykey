// The transactional outbox (Doc 06 §6): a row is written in the transaction of
// the change it announces, and a dispatcher turns it into a job afterwards.
// A row names an operation and a job kind, nothing else.
import { randomUUID } from "node:crypto";
import type { OperationId } from "@mykey/contracts";
import type pg from "pg";

export interface OutboxRow {
  id: string;
  operationId: OperationId;
  jobKind: string;
}

export async function enqueueOutbox(
  tx: pg.PoolClient,
  operationId: OperationId,
  jobKind: string,
): Promise<void> {
  await tx.query(
    "INSERT INTO app.outbox (id, operation_id, job_kind, state) VALUES ($1, $2, $3, 'pending')",
    [randomUUID(), operationId, jobKind],
  );
}

/** The oldest pending rows, locked for this transaction; rows another dispatcher holds are skipped. */
export async function claimOutbox(tx: pg.PoolClient, limit: number): Promise<OutboxRow[]> {
  const result = await tx.query<{ id: string; operation_id: OperationId; job_kind: string }>(
    `SELECT id, operation_id, job_kind FROM app.outbox
      WHERE state = 'pending'
      ORDER BY created_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    operationId: row.operation_id,
    jobKind: row.job_kind,
  }));
}

export async function markOutboxDelivered(tx: pg.PoolClient, id: string): Promise<void> {
  await tx.query(
    "UPDATE app.outbox SET state = 'delivered', delivered_at = now() WHERE id = $1 AND state = 'pending'",
    [id],
  );
}
