// The operation record (Doc 06 §6). Insert and lookup by the idempotency key
// (Run 3.9); the scope columns, the dispatch claim, the conditional finish,
// the heartbeat and the operator's expiry (Run 4.1, P-63, P-65).
import type {
  EnvironmentId,
  ErrorCode,
  OperationId,
  OperationState,
  OrganizationId,
  ProjectId,
} from "@mykey/contracts";
import type pg from "pg";
import type { EnvironmentScope } from "../scope.ts";
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
  projectId: ProjectId | null;
  environmentId: EnvironmentId | null;
  secretName: string | null;
  parentOperationId: OperationId | null;
  state: OperationState;
  fingerprint: Buffer | null;
  fingerprintKeyId: string | null;
  expected: Record<string, unknown> | null;
  executorBootId: string | null;
  dispatchedAt: Date | null;
  heartbeatAt: Date | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
  /** Until when the outcome replays (Run 3.9); null while unfinished. */
  replayExpiresAt: Date | null;
  /** replay_expires_at < now(), computed in the statement (database time). */
  expired: boolean;
}

export type NewOperation = OperationKey & {
  id: OperationId;
  organizationId: OrganizationId | null;
  state: OperationState;
  fingerprint: Buffer | null;
  fingerprintKeyId: string | null;
  result: Record<string, unknown> | null;
  projectId?: ProjectId;
  environmentId?: EnvironmentId;
  secretName?: string;
  parentOperationId?: OperationId;
  expected?: Record<string, unknown>;
  executorBootId?: string;
};

const json = (value: Record<string, unknown> | null | undefined) =>
  value === null || value === undefined ? null : JSON.stringify(value);

/** Inserts the row, or reports that a row with the same key already exists. */
export async function insertOperation(
  tx: pg.PoolClient,
  row: NewOperation,
): Promise<"inserted" | "exists"> {
  const result = await tx.query(
    `INSERT INTO app.operation
       (id, organization_id, principal_kind, principal_id, action, target, idempotency_key,
        state, fingerprint, fingerprint_key_id, result, project_id, environment_id, secret_name,
        parent_operation_id, expected, executor_boot_id, heartbeat_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
             CASE WHEN $17::uuid IS NULL THEN NULL ELSE now() END)
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
      json(row.result),
      row.projectId ?? null,
      row.environmentId ?? null,
      row.secretName ?? null,
      row.parentOperationId ?? null,
      json(row.expected),
      row.executorBootId ?? null,
    ],
  );
  return result.rowCount === 1 ? "inserted" : "exists";
}

interface StoredOperation {
  id: OperationId;
  organization_id: OrganizationId | null;
  project_id: ProjectId | null;
  environment_id: EnvironmentId | null;
  secret_name: string | null;
  parent_operation_id: OperationId | null;
  principal_kind: PrincipalKind;
  principal_id: string;
  action: string;
  target: string;
  idempotency_key: string;
  state: OperationState;
  fingerprint: Buffer | null;
  fingerprint_key_id: string | null;
  expected: Record<string, unknown> | null;
  executor_boot_id: string | null;
  dispatched_at: Date | null;
  heartbeat_at: Date | null;
  result: Record<string, unknown> | null;
  error_code: string | null;
  created_at: Date;
  completed_at: Date | null;
  replay_expires_at: Date | null;
  expired: boolean;
}

export const OPERATION_COLUMNS = `id, organization_id, project_id, environment_id, secret_name,
  parent_operation_id, principal_kind, principal_id, action, target, idempotency_key,
  state, fingerprint, fingerprint_key_id, expected, executor_boot_id, dispatched_at, heartbeat_at,
  result, error_code, created_at, completed_at, replay_expires_at,
  coalesce(replay_expires_at < now(), false) AS expired`;
const COLUMNS = OPERATION_COLUMNS;

export function toOperationRow(stored: StoredOperation): OperationRow {
  return {
    id: stored.id,
    organizationId: stored.organization_id,
    projectId: stored.project_id,
    environmentId: stored.environment_id,
    secretName: stored.secret_name,
    parentOperationId: stored.parent_operation_id,
    principalKind: stored.principal_kind,
    principalId: stored.principal_id,
    action: stored.action,
    target: stored.target,
    idempotencyKey: stored.idempotency_key,
    state: stored.state,
    fingerprint: stored.fingerprint,
    fingerprintKeyId: stored.fingerprint_key_id,
    expected: stored.expected,
    executorBootId: stored.executor_boot_id,
    dispatchedAt: stored.dispatched_at,
    heartbeatAt: stored.heartbeat_at,
    result: stored.result,
    errorCode: stored.error_code,
    createdAt: stored.created_at,
    completedAt: stored.completed_at,
    replayExpiresAt: stored.replay_expires_at,
    expired: stored.expired,
  };
}
const toRow = toOperationRow;

export type { StoredOperation };

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

/**
 * Marks the operation succeeded with its result; its outcome replays for the
 * retention of terminal records (Doc 06 §6.1). Answers the stored row. For the
 * database-only routes of Session 3, whose operation is one transaction.
 */
export async function completeOperation(
  tx: Queryable,
  id: OperationId,
  result: Record<string, unknown>,
  retentionDays: number,
): Promise<OperationRow> {
  const updated = await tx.query<StoredOperation>(
    `UPDATE app.operation
        SET state = 'succeeded', result = $2, error_code = NULL, completed_at = now(),
            replay_expires_at = now() + make_interval(days => $3)
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, JSON.stringify(result), retentionDays],
  );
  const stored = updated.rows[0];
  if (stored === undefined) throw new Error("operation to complete not found");
  return toRow(stored);
}

/** accepted → executing for the executor `bootId`; the dispatch marker (Doc 06 §6.2 step 3). */
export async function claimDispatch(
  tx: pg.PoolClient,
  id: OperationId,
  bootId: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE app.operation
        SET state = 'executing', dispatched_at = now(), heartbeat_at = now()
      WHERE id = $1 AND executor_boot_id = $2 AND state = 'accepted'`,
    [id, bootId],
  );
  return result.rowCount === 1;
}

export type Finish =
  | { state: "succeeded" | "partial"; result: Record<string, unknown> }
  | { state: "rejected"; errorCode: ErrorCode }
  | { state: "uncertain" }
  | { state: "awaiting_input" };

/**
 * One conditional update: only the executor `bootId` may finish an operation
 * that is still accepted or executing. Null: nothing changed (another executor
 * or the sweep owns it now, or it is already terminal).
 */
export async function finishOperation(
  tx: pg.PoolClient,
  id: OperationId,
  bootId: string,
  finish: Finish,
  retentionDays: number,
): Promise<OperationRow | null> {
  const terminal =
    finish.state === "succeeded" || finish.state === "partial" || finish.state === "rejected";
  const result =
    finish.state === "succeeded" || finish.state === "partial"
      ? JSON.stringify(finish.result)
      : null;
  const errorCode = finish.state === "rejected" ? finish.errorCode : null;
  const updated = await tx.query<StoredOperation>(
    `UPDATE app.operation
        SET state = $3,
            result = CASE WHEN $4 THEN $5::jsonb ELSE result END,
            error_code = CASE WHEN $4 THEN $6 ELSE error_code END,
            completed_at = CASE WHEN $4 THEN now() ELSE completed_at END,
            replay_expires_at = CASE WHEN $4 THEN now() + make_interval(days => $7)
                                     ELSE replay_expires_at END
      WHERE id = $1 AND executor_boot_id = $2 AND state IN ('accepted', 'executing')
      RETURNING ${COLUMNS}`,
    [id, bootId, finish.state, terminal, result, errorCode, retentionDays],
  );
  const stored = updated.rows[0];
  return stored === undefined ? null : toRow(stored);
}

/** heartbeat_at = now(), while `bootId` still owns the unfinished operation. */
export async function touchOperation(
  tx: Queryable,
  id: OperationId,
  bootId: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE app.operation SET heartbeat_at = now()
      WHERE id = $1 AND executor_boot_id = $2 AND state IN ('accepted', 'executing')`,
    [id, bootId],
  );
  return result.rowCount === 1;
}

export async function hasTombstone(db: Queryable, key: OperationKey): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM app.operation_tombstone
      WHERE principal_kind = $1 AND principal_id = $2 AND action = $3 AND target = $4
        AND idempotency_key = $5`,
    [key.principalKind, key.principalId, key.action, key.target, key.idempotencyKey],
  );
  return result.rowCount === 1;
}

/**
 * The operator's expiry (P-65): every terminal row whose replay record has
 * expired gets a tombstone and loses what only replay needed (fingerprint, key
 * id, expected, result). The row itself stays for attribution and the audit
 * link. Unfinished rows never expire. Answers the number of rows expired.
 */
export async function expireOperations(tx: pg.PoolClient): Promise<number> {
  const expiring = `state IN ('succeeded', 'partial', 'rejected') AND replay_expires_at < now()
    AND (fingerprint IS NOT NULL OR fingerprint_key_id IS NOT NULL OR expected IS NOT NULL
         OR result IS NOT NULL)`;
  await tx.query(
    `INSERT INTO app.operation_tombstone
       (principal_kind, principal_id, action, target, idempotency_key, expired_at)
     SELECT principal_kind, principal_id, action, target, idempotency_key, now()
       FROM app.operation WHERE ${expiring}
     ON CONFLICT ON CONSTRAINT operation_tombstone_pkey DO NOTHING`,
  );
  const updated = await tx.query(
    `UPDATE app.operation
        SET fingerprint = NULL, fingerprint_key_id = NULL, expected = NULL, result = NULL
      WHERE ${expiring}`,
  );
  return updated.rowCount ?? 0;
}

/**
 * The operations of one environment, newest first (P-63). Children of an
 * import are not listed. `principalId` limits the list to that user's rows.
 * `anchor` (microseconds since the epoch of the first page's first row)
 * bounds every later page, so operations made while paging never appear;
 * `after` is the sort key of the previous page's last row. Each row carries
 * its sort key "<created_at in microseconds>|<id>".
 */
export async function listOperations(
  db: Queryable,
  scope: EnvironmentScope,
  filter: { principalId: string | null; unfinishedOnly: boolean },
  page: { anchor: string | null; after: string | null; limit: number },
): Promise<(OperationRow & { sortKey: string })[]> {
  const [afterMicros, afterId] = page.after === null ? [null, null] : page.after.split("|");
  const result = await db.query<StoredOperation & { sort_key: string }>(
    `SELECT ${COLUMNS},
            (extract(epoch FROM created_at) * 1000000)::bigint::text || '|' || id AS sort_key
       FROM app.operation
      WHERE organization_id = $1 AND environment_id = $2 AND parent_operation_id IS NULL
        AND ($3::text IS NULL OR (principal_kind = 'user' AND principal_id = $3))
        AND (NOT $4 OR state IN ('accepted', 'executing', 'awaiting_input', 'uncertain'))
        AND ($5::bigint IS NULL
             OR created_at <= 'epoch'::timestamptz + $5::bigint * interval '1 microsecond')
        AND ($6::bigint IS NULL
             OR (created_at, id) < ('epoch'::timestamptz + $6::bigint * interval '1 microsecond',
                                    $7::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $8`,
    [
      scope.organizationId,
      scope.environmentId,
      filter.principalId,
      filter.unfinishedOnly,
      page.anchor,
      afterMicros ?? null,
      afterId ?? null,
      page.limit,
    ],
  );
  return result.rows.map((stored) => ({ ...toRow(stored), sortKey: stored.sort_key }));
}

/** An operation an operator must settle (Run 4.5, P-75). */
export interface Unresolved {
  id: OperationId;
  action: string;
  environmentId: EnvironmentId | null;
  secretName: string | null;
  state: OperationState;
  heartbeatAt: Date | null;
  /** accepted or executing with a heartbeat older than `staleSeconds`. */
  stale: boolean;
  holdsSlot: boolean;
  /** Seconds since the row was created (database time). */
  ageSeconds: number;
}

/** The rule of P-75; infra/hosts/checks/status.sh counts the same rows over all organizations. */
const UNRESOLVED = `((o.state = 'uncertain' AND o.completed_at IS NULL)
  OR (o.state IN ('accepted', 'executing') AND o.heartbeat_at < now() - make_interval(secs => $2)))`;

/**
 * Uncertain operations not closed, and accepted or executing ones whose
 * heartbeat is older than `staleSeconds` (120 s): the operations the
 * operator must settle, oldest first.
 */
export async function listUnresolved(
  db: Queryable,
  organizationId: OrganizationId,
  staleSeconds = 120,
): Promise<Unresolved[]> {
  const result = await db.query<{
    id: OperationId;
    action: string;
    environment_id: EnvironmentId | null;
    secret_name: string | null;
    state: OperationState;
    heartbeat_at: Date | null;
    stale: boolean;
    holds_slot: boolean;
    age_seconds: number;
  }>(
    `SELECT o.id, o.action, o.environment_id, o.secret_name, o.state, o.heartbeat_at,
            o.state IN ('accepted', 'executing') AS stale,
            EXISTS (SELECT 1 FROM app.effect_slot s WHERE s.operation_id = o.id) AS holds_slot,
            floor(extract(epoch FROM now() - o.created_at))::int AS age_seconds
       FROM app.operation o
      WHERE o.organization_id = $1 AND ${UNRESOLVED}
      ORDER BY o.created_at, o.id`,
    [organizationId, staleSeconds],
  );
  return result.rows.map((row) => ({
    id: row.id,
    action: row.action,
    environmentId: row.environment_id,
    secretName: row.secret_name,
    state: row.state,
    heartbeatAt: row.heartbeat_at,
    stale: row.stale,
    holdsSlot: row.holds_slot,
    ageSeconds: row.age_seconds,
  }));
}

export type Settlement =
  | { state: "succeeded" | "partial"; result: Record<string, unknown> }
  | { state: "rejected"; errorCode: ErrorCode }
  /** Closed as unknown: stays uncertain for ever, no longer unresolved (rule 11). */
  | { state: "uncertain" };

/**
 * The operator's settlement of an unresolved operation (Run 4.5): only from
 * uncertain with completed_at NULL. Sets completed_at; a succeeded or rejected
 * outcome replays for the retention of terminal records, an uncertain one
 * keeps answering outcome_unknown. False: nothing changed.
 */
export async function settleOperation(
  tx: pg.PoolClient,
  id: OperationId,
  verdict: Settlement,
  retentionDays: number,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE app.operation
        SET state = $2,
            result = $3::jsonb,
            error_code = $4,
            completed_at = now(),
            replay_expires_at = CASE WHEN $2 = 'uncertain' THEN NULL
                                     ELSE now() + make_interval(days => $5) END,
            executor_boot_id = NULL
      WHERE id = $1 AND state = 'uncertain' AND completed_at IS NULL`,
    [
      id,
      verdict.state,
      verdict.state === "succeeded" || verdict.state === "partial"
        ? JSON.stringify(verdict.result)
        : null,
      verdict.state === "rejected" ? verdict.errorCode : null,
      retentionDays,
    ],
  );
  return result.rowCount === 1;
}

/**
 * An import waiting for its owner resumes (Run 4.7): awaiting_input becomes
 * executing under the new executor, heartbeat now. False: it was not waiting
 * (another resume claimed it first, or it is no longer resumable).
 */
export async function claimResume(
  tx: Queryable,
  id: OperationId,
  bootId: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE app.operation SET state = 'executing', executor_boot_id = $2, heartbeat_at = now()
      WHERE id = $1 AND state = 'awaiting_input'`,
    [id, bootId],
  );
  return result.rowCount === 1;
}

/**
 * Run 5.2 (P-89): every uncertain, unclosed revocation whose step targets the
 * credential becomes succeeded, now that a lookup proved its token gone.
 * Answers the ids it settled.
 */
export async function settleRevocations(
  tx: pg.PoolClient,
  credentialId: string,
  retentionDays: number,
): Promise<OperationId[]> {
  const result = await tx.query<{ id: OperationId }>(
    `UPDATE app.operation o
        SET state = 'succeeded', result = jsonb_build_object('credentialId', $1::text, 'state', 'revoked'),
            error_code = NULL, completed_at = now(),
            replay_expires_at = now() + make_interval(days => $2), executor_boot_id = NULL
      WHERE o.action = 'credentials.revoke' AND o.state = 'uncertain' AND o.completed_at IS NULL
        AND EXISTS (SELECT 1 FROM app.operation_step s
                     WHERE s.operation_id = o.id AND s.target = $1::text)
      RETURNING o.id`,
    [credentialId, retentionDays],
  );
  return result.rows.map((row) => row.id);
}

/** Run 5.2 (P-89): a revocation of the credential executing with a heartbeat younger than `freshSeconds`. */
export async function liveRevocation(
  db: Queryable,
  credentialId: string,
  freshSeconds: number,
): Promise<OperationId | null> {
  const result = await db.query<{ id: OperationId }>(
    `SELECT o.id FROM app.operation o
      WHERE o.action = 'credentials.revoke' AND o.state IN ('accepted', 'executing')
        AND o.heartbeat_at >= now() - make_interval(secs => $2)
        AND EXISTS (SELECT 1 FROM app.operation_step s
                     WHERE s.operation_id = o.id AND s.target = $1::text)
      LIMIT 1`,
    [credentialId, freshSeconds],
  );
  return result.rows[0]?.id ?? null;
}
