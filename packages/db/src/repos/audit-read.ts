// Reading the audit trail for an organization (Run 6.1, P-106, P-107). One
// statement: the organization's tenant rows, UNION ALL the account rows whose
// subject user is a member of it now, both bounded by the window, the anchor
// and the keyset, each branch ordered and limited on its own index, ordered
// and limited once more outside. Global rows (no organization, no member
// subject) are never reached. The statement runs under a 5 s timeout.
import type { OrganizationId } from "@mykey/contracts";
import type pg from "pg";
import { withTransaction, type Queryable } from "../tx.ts";

export interface AuditFilter {
  organizationId: OrganizationId;
  from: Date;
  to: Date;
  /** Microseconds since the epoch, database time of the first page. */
  anchorMicros: string;
  /** The last row of the previous page: microseconds since the epoch, and its id. */
  after?: { occurredAtMicros: string; id: string };
  actions: readonly string[];
  outcome?: string;
  actorKind?: string;
  actorId?: string;
  /** The row's target is one of these (a project and its environments, or one environment). */
  targetIds?: readonly string[];
  operationId?: string;
  requestId?: string;
  /** Rows to return: the caller asks for one more than it serves. */
  limit: number;
}

export interface AuditRow {
  id: string;
  occurredAt: Date;
  /** Microseconds since the epoch: the keyset value, exact. */
  occurredAtMicros: string;
  actorKind: string;
  actorId: string | null;
  source: string | null;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  outcome: string;
  requestId: string | null;
  operationId: string | null;
  details: unknown;
}

/** The statement's own deadline (P-107); a timeout is the caller's `503 busy`. */
export const AUDIT_READ_TIMEOUT_MS = 5000;

/** The class of a statement that ran past AUDIT_READ_TIMEOUT_MS (SQLSTATE 57014). */
export class AuditReadTimeout extends Error {
  constructor() {
    super("the audit read timed out");
    this.name = "AuditReadTimeout";
  }
}

const FILTER = `
  e.action = ANY ($2::text[])
  AND e.occurred_at <= timestamptz 'epoch' + $3::bigint * interval '1 microsecond'
  AND e.occurred_at >= $4::timestamptz AND e.occurred_at <= $5::timestamptz
  AND ($6::bigint IS NULL
       OR (e.occurred_at, e.id) < (timestamptz 'epoch' + $6::bigint * interval '1 microsecond', $7::uuid))
  AND ($8::text IS NULL OR e.outcome = $8)
  AND ($9::text IS NULL OR e.actor_kind = $9)
  AND ($10::text IS NULL OR e.actor_id = $10)
  AND ($11::text[] IS NULL OR e.target_id = ANY ($11::text[]))
  AND ($12::uuid IS NULL OR e.operation_id = $12)
  AND ($13::text IS NULL OR e.request_id = $13)`;

const COLUMNS = `e.id, e.occurred_at, (extract(epoch FROM e.occurred_at) * 1000000)::bigint::text AS micros,
  e.actor_kind, e.actor_id, e.source_category, e.action, e.target_kind, e.target_id, e.outcome,
  e.request_id, e.operation_id, e.details`;

const QUERY = `
SELECT * FROM (
  (SELECT ${COLUMNS} FROM audit.event e
    WHERE e.organization_id = $1 AND ${FILTER}
    ORDER BY e.occurred_at DESC, e.id DESC LIMIT $14)
  UNION ALL
  (SELECT ${COLUMNS} FROM audit.event e
    WHERE e.organization_id IS NULL
      AND e.subject_user_id IN (SELECT m.user_id::text FROM app.membership m
                                 WHERE m.organization_id = $1 AND m.state = 'active')
      AND ${FILTER}
    ORDER BY e.occurred_at DESC, e.id DESC LIMIT $14)
) served
ORDER BY occurred_at DESC, id DESC
LIMIT $14`;

interface Raw {
  id: string;
  occurred_at: Date;
  micros: string;
  actor_kind: string;
  actor_id: string | null;
  source_category: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  outcome: string;
  request_id: string | null;
  operation_id: string | null;
  details: unknown;
}

/** The statement and its parameters (exported for the EXPLAIN of the run note). */
export function auditListStatement(f: AuditFilter): { text: string; values: unknown[] } {
  return {
    text: QUERY,
    values: [
      f.organizationId,
      f.actions,
      f.anchorMicros,
      f.from,
      f.to,
      f.after?.occurredAtMicros ?? null,
      f.after?.id ?? null,
      f.outcome ?? null,
      f.actorKind ?? null,
      f.actorId ?? null,
      f.targetIds ?? null,
      f.operationId ?? null,
      f.requestId ?? null,
      f.limit,
    ],
  };
}

export async function listAuditEvents(pool: pg.Pool, f: AuditFilter): Promise<AuditRow[]> {
  const statement = auditListStatement(f);
  let rows: Raw[];
  try {
    rows = await withTransaction(pool, async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = ${String(AUDIT_READ_TIMEOUT_MS)}`);
      return (await tx.query<Raw>(statement.text, statement.values)).rows;
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === "57014") throw new AuditReadTimeout();
    throw error;
  }
  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at,
    occurredAtMicros: row.micros,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    source: row.source_category,
    action: row.action,
    targetKind: row.target_kind,
    targetId: row.target_id,
    outcome: row.outcome,
    requestId: row.request_id,
    operationId: row.operation_id,
    details: row.details,
  }));
}

/** Database time now, in microseconds since the epoch: the anchor of a first page. */
export async function databaseNowMicros(db: Queryable): Promise<string> {
  const result = await db.query<{ micros: string }>(
    "SELECT (extract(epoch FROM now()) * 1000000)::bigint::text AS micros",
  );
  const micros = result.rows[0]?.micros;
  if (micros === undefined) throw new Error("now() answered no row");
  return micros;
}

/** The ids a project filter covers: the project and its environments (P-107). */
export async function projectTargetIds(
  db: Queryable,
  organizationId: OrganizationId,
  projectId: string,
): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT id::text FROM app.project WHERE id = $2 AND organization_id = $1
     UNION ALL
     SELECT id::text FROM app.environment WHERE project_id = $2 AND organization_id = $1`,
    [organizationId, projectId],
  );
  return result.rows.map((row) => row.id);
}

/** The current state and action of each operation of the organization (P-108). */
export async function operationStates(
  db: Queryable,
  organizationId: OrganizationId,
  ids: readonly string[],
): Promise<Map<string, { state: string; action: string }>> {
  if (ids.length === 0) return new Map();
  const result = await db.query<{ id: string; state: string; action: string }>(
    "SELECT id, state, action FROM app.operation WHERE organization_id = $1 AND id = ANY ($2::uuid[])",
    [organizationId, ids],
  );
  return new Map(result.rows.map((row) => [row.id, { state: row.state, action: row.action }]));
}

/** The current names of the organization's projects and environments among `ids` (P-108). */
export async function targetNames(
  db: Queryable,
  organizationId: OrganizationId,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await db.query<{ id: string; name: string }>(
    `SELECT id::text, name FROM app.project WHERE organization_id = $1 AND id = ANY ($2::uuid[])
     UNION ALL
     SELECT id::text, name FROM app.environment WHERE organization_id = $1 AND id = ANY ($2::uuid[])`,
    [organizationId, ids],
  );
  return new Map(result.rows.map((row) => [row.id, row.name]));
}
