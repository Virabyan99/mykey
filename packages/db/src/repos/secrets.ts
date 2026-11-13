// The secret index (Doc 06 §5, Run 4.2): one row per name with its current
// version, state tag and byte count — never a value or anything derived from
// one. Every function takes the environment scope it acts in.
import { randomBytes, randomUUID } from "node:crypto";
import type { OperationId } from "@mykey/contracts";
import type pg from "pg";
import type { EnvironmentScope } from "../scope.ts";
import type { Queryable } from "../tx.ts";

export type IndexState = "live" | "deleted" | "needs_review";

export interface IndexRow {
  name: string;
  currentVersion: number | null;
  stateTag: string;
  state: IndexState;
  liveValueBytes: number;
  lastChangedAt: Date;
  lastOperationId: OperationId | null;
}

interface StoredIndexRow {
  name: string;
  current_version: number | null;
  state_tag: string;
  state: IndexState;
  live_value_bytes: number;
  last_changed_at: Date;
  last_operation_id: OperationId | null;
}

const INDEX_COLUMNS =
  "name, current_version, state_tag, state, live_value_bytes, last_changed_at, last_operation_id";

function toIndexRow(stored: StoredIndexRow): IndexRow {
  return {
    name: stored.name,
    currentVersion: stored.current_version,
    stateTag: stored.state_tag,
    state: stored.state,
    liveValueBytes: stored.live_value_bytes,
    lastChangedAt: stored.last_changed_at,
    lastOperationId: stored.last_operation_id,
  };
}

/** 16 random bytes, base64url (22 characters): a tag no client can predict. */
export const newStateTag = (): string => randomBytes(16).toString("base64url");

/** The name's row, locked FOR UPDATE until the transaction ends; null when absent. */
export async function lockIndexRow(
  tx: pg.PoolClient,
  scope: EnvironmentScope,
  name: string,
): Promise<IndexRow | null> {
  const result = await tx.query<StoredIndexRow>(
    `SELECT ${INDEX_COLUMNS} FROM app.secret_index
      WHERE organization_id = $1 AND environment_id = $2 AND name = $3 FOR UPDATE`,
    [scope.organizationId, scope.environmentId, name],
  );
  const stored = result.rows[0];
  return stored === undefined ? null : toIndexRow(stored);
}

export async function readIndexRow(
  db: Queryable,
  scope: EnvironmentScope,
  name: string,
): Promise<IndexRow | null> {
  const result = await db.query<StoredIndexRow>(
    `SELECT ${INDEX_COLUMNS} FROM app.secret_index
      WHERE organization_id = $1 AND environment_id = $2 AND name = $3`,
    [scope.organizationId, scope.environmentId, name],
  );
  const stored = result.rows[0];
  return stored === undefined ? null : toIndexRow(stored);
}

/**
 * One page of the index in bytewise name order, and the environment's
 * metadata generation — from one statement, so both come from one snapshot
 * (Run 4.3). `prefix` is literal; `after` is the last name of the page before.
 */
export async function listIndex(
  db: Queryable,
  scope: EnvironmentScope,
  page: { prefix: string | null; after: string | null; limit: number },
): Promise<{ rows: IndexRow[]; generation: bigint }> {
  const result = await db.query<{ generation: string } & Partial<StoredIndexRow>>(
    `SELECT e.metadata_generation::text AS generation, i.name, i.current_version, i.state_tag,
            i.state, i.live_value_bytes, i.last_changed_at, i.last_operation_id
       FROM app.environment e
       LEFT JOIN LATERAL (
         SELECT s.* FROM app.secret_index s
          WHERE s.organization_id = e.organization_id AND s.environment_id = e.id
            AND ($3::text IS NULL OR starts_with(s.name, $3::text))
            AND ($4::text IS NULL OR s.name COLLATE "C" > $4::text COLLATE "C")
          ORDER BY s.name COLLATE "C"
          LIMIT $5
       ) i ON true
      WHERE e.organization_id = $1 AND e.id = $2
      ORDER BY i.name COLLATE "C"`,
    [scope.organizationId, scope.environmentId, page.prefix, page.after, page.limit],
  );
  const first = result.rows[0];
  if (first === undefined) throw new Error("environment not found");
  const rows = result.rows
    .filter((row): row is { generation: string } & StoredIndexRow => row.name != null)
    .map(toIndexRow);
  return { rows, generation: BigInt(first.generation) };
}

export interface VersionEvent {
  version: number;
  action: string;
  actorKind: "user" | "operator" | "system" | "unknown";
  actorId: string | null;
  operationId: OperationId | null;
  occurredAt: Date;
}

/** Every version event of a name, oldest first. */
export async function versionEvents(
  db: Queryable,
  scope: EnvironmentScope,
  name: string,
): Promise<VersionEvent[]> {
  const result = await db.query<{
    version: number;
    action: string;
    actor_kind: VersionEvent["actorKind"];
    actor_id: string | null;
    operation_id: OperationId | null;
    occurred_at: Date;
  }>(
    `SELECT version, action, actor_kind, actor_id, operation_id, occurred_at
       FROM app.secret_version_event
      WHERE organization_id = $1 AND environment_id = $2 AND name = $3
      ORDER BY occurred_at, id`,
    [scope.organizationId, scope.environmentId, name],
  );
  return result.rows.map((row) => ({
    version: row.version,
    action: row.action,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    operationId: row.operation_id,
    occurredAt: row.occurred_at,
  }));
}

/** Names (any state), live bytes, the metadata generation and the advisory lock key. */
export async function environmentCounters(
  db: Queryable,
  scope: EnvironmentScope,
): Promise<{ names: number; liveBytes: number; generation: bigint; lockKey: bigint }> {
  const result = await db.query<{
    names: number;
    live_value_bytes: string;
    metadata_generation: string;
    lock_key: string;
  }>(
    `SELECT (SELECT count(*)::int FROM app.secret_index i
              WHERE i.organization_id = e.organization_id AND i.environment_id = e.id) AS names,
            e.live_value_bytes, e.metadata_generation, e.lock_key
       FROM app.environment e
      WHERE e.organization_id = $1 AND e.id = $2`,
    [scope.organizationId, scope.environmentId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("environment not found");
  return {
    names: row.names,
    liveBytes: Number(row.live_value_bytes),
    generation: BigInt(row.metadata_generation),
    lockKey: BigInt(row.lock_key),
  };
}

/** Inserts or replaces the name's row; last_changed_at = now(). */
export async function writeIndexRow(
  tx: pg.PoolClient,
  scope: EnvironmentScope,
  row: Omit<IndexRow, "lastChangedAt">,
): Promise<void> {
  await tx.query(
    `INSERT INTO app.secret_index (environment_id, name, organization_id, current_version,
       state_tag, state, live_value_bytes, last_changed_at, last_operation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
     ON CONFLICT ON CONSTRAINT secret_index_pkey DO UPDATE
       SET current_version = EXCLUDED.current_version, state_tag = EXCLUDED.state_tag,
           state = EXCLUDED.state, live_value_bytes = EXCLUDED.live_value_bytes,
           last_changed_at = EXCLUDED.last_changed_at,
           last_operation_id = EXCLUDED.last_operation_id
     WHERE app.secret_index.organization_id = EXCLUDED.organization_id`,
    [
      scope.environmentId,
      row.name,
      scope.organizationId,
      row.currentVersion,
      row.stateTag,
      row.state,
      row.liveValueBytes,
      row.lastOperationId,
    ],
  );
}

/** metadata_generation + 1 and live_value_bytes + delta; answers the new generation. */
export async function applyCounters(
  tx: pg.PoolClient,
  scope: EnvironmentScope,
  liveBytesDelta: number,
): Promise<bigint> {
  const result = await tx.query<{ metadata_generation: string }>(
    `UPDATE app.environment
        SET metadata_generation = metadata_generation + 1,
            live_value_bytes = live_value_bytes + $3
      WHERE organization_id = $1 AND id = $2
      RETURNING metadata_generation`,
    [scope.organizationId, scope.environmentId, liveBytesDelta],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("environment not found");
  return BigInt(row.metadata_generation);
}

export async function recordVersionEvent(
  tx: pg.PoolClient,
  scope: EnvironmentScope,
  event: {
    name: string;
    version: number;
    operationId: OperationId | null;
    actorKind: "user" | "operator" | "system" | "unknown";
    actorId: string | null;
    action: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO app.secret_version_event (id, organization_id, environment_id, name, version,
       operation_id, actor_kind, actor_id, action, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      randomUUID(),
      scope.organizationId,
      scope.environmentId,
      event.name,
      event.version,
      event.operationId,
      event.actorKind,
      event.actorId,
      event.action,
    ],
  );
}

/**
 * The name goes to review (P-68): its row becomes needs_review with a fresh
 * tag, keeping its version and byte count; a name without a row gets one with
 * no version.
 */
export async function markKeyReview(
  db: Queryable,
  scope: EnvironmentScope,
  name: string,
  operationId: OperationId | null,
): Promise<void> {
  await db.query(
    `INSERT INTO app.secret_index (environment_id, name, organization_id, current_version,
       state_tag, state, live_value_bytes, last_changed_at, last_operation_id)
     VALUES ($1, $2, $3, NULL, $4, 'needs_review', 0, now(), $5)
     ON CONFLICT ON CONSTRAINT secret_index_pkey DO UPDATE
       SET state = 'needs_review', state_tag = EXCLUDED.state_tag,
           last_changed_at = EXCLUDED.last_changed_at,
           last_operation_id = coalesce(EXCLUDED.last_operation_id, app.secret_index.last_operation_id)
     WHERE app.secret_index.organization_id = EXCLUDED.organization_id`,
    [scope.environmentId, name, scope.organizationId, newStateTag(), operationId],
  );
}

/** The environment goes to review (P-72), through the one function that may set it. */
export async function markEnvironmentReview(db: Queryable, scope: EnvironmentScope): Promise<void> {
  await db.query("SELECT app.mark_environment_review($1, $2)", [
    scope.organizationId,
    scope.environmentId,
  ]);
}

/** Removes the name's row (reconciliation: the backend has no such key). */
export async function deleteIndexRow(
  tx: pg.PoolClient,
  scope: EnvironmentScope,
  name: string,
): Promise<void> {
  await tx.query(
    "DELETE FROM app.secret_index WHERE organization_id = $1 AND environment_id = $2 AND name = $3",
    [scope.organizationId, scope.environmentId, name],
  );
}

/** The names of the environment's index rows. */
export async function indexNames(db: Queryable, scope: EnvironmentScope): Promise<string[]> {
  const result = await db.query<{ name: string }>(
    "SELECT name FROM app.secret_index WHERE organization_id = $1 AND environment_id = $2",
    [scope.organizationId, scope.environmentId],
  );
  return result.rows.map((row) => row.name);
}

/**
 * Reconciliation (Run 4.5): live_value_bytes becomes the sum of the live rows
 * and metadata_generation rises by one; answers the new generation.
 */
export async function recomputeCounters(
  tx: pg.PoolClient,
  scope: EnvironmentScope,
): Promise<bigint> {
  const result = await tx.query<{ metadata_generation: string }>(
    `UPDATE app.environment e
        SET live_value_bytes = (SELECT coalesce(sum(i.live_value_bytes), 0) FROM app.secret_index i
                                 WHERE i.organization_id = e.organization_id
                                   AND i.environment_id = e.id AND i.state = 'live'),
            metadata_generation = e.metadata_generation + 1
      WHERE e.organization_id = $1 AND e.id = $2
      RETURNING e.metadata_generation`,
    [scope.organizationId, scope.environmentId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("environment not found");
  return BigInt(row.metadata_generation);
}
