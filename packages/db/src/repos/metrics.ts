// The organization's outcomes by UTC day (Run 7.8, P-139). Counted from the
// audit rows the organization's listings serve: its tenant rows and the
// account rows of its members now, the same two branches as audit-read.ts.
// One read-only transaction on one snapshot, so the days, the first row and
// the operations are of one moment. Nothing here reads a detail of a row.
import type pg from "pg";
import { withTransaction } from "../tx.ts";
import { AUDIT_READ_TIMEOUT_MS, AuditReadTimeout } from "./audit-read.ts";

export interface DayCounts {
  success: number;
  failure: number;
  unknown: number;
  denied: number;
}

export interface Metrics {
  /** The database's time of the read; the end of the window. */
  observedAt: Date;
  /** 00:00 UTC of the first day of the window. */
  from: Date;
  /** The organization's oldest row, or null when it has none: nothing before it was measured. */
  measuredFrom: Date | null;
  /** The days of the window that have a row, by `YYYY-MM-DD` (UTC). */
  days: Map<string, DayCounts>;
  operations: { unresolved: number; uncertain: number };
}

const WINDOW = `
  SELECT now() AS now,
         (date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => $1::int - 1))
           AT TIME ZONE 'UTC' AS from_at`;

const FIRST = `SELECT min(occurred_at) AS first FROM audit.event WHERE organization_id = $1`;

const SERVED = `
  e.occurred_at >= $2::timestamptz AND e.occurred_at <= now()
  AND (e.action = ANY ($3::text[]) OR e.action = $4)`;

const COUNTS = `
  SELECT (served.occurred_at AT TIME ZONE 'UTC')::date::text AS day,
         count(*) FILTER (WHERE served.action <> $4 AND served.outcome = 'success') AS success,
         count(*) FILTER (WHERE served.action <> $4 AND served.outcome = 'failure') AS failure,
         count(*) FILTER (WHERE served.action <> $4 AND served.outcome = 'unknown') AS unknown,
         count(*) FILTER (WHERE served.action = $4) AS denied
    FROM (
      SELECT e.occurred_at, e.action, e.outcome FROM audit.event e
       WHERE e.organization_id = $1 AND ${SERVED}
      UNION ALL
      SELECT e.occurred_at, e.action, e.outcome FROM audit.event e
       WHERE e.organization_id IS NULL
         AND e.subject_user_id IN (SELECT m.user_id::text FROM app.membership m
                                    WHERE m.organization_id = $1 AND m.state = 'active')
         AND ${SERVED}
    ) served
   GROUP BY 1`;

// Top-level operations, as the operations list shows them: an import's entries are not counted.
const OPERATIONS = `
  SELECT count(*) FILTER (WHERE state <> 'uncertain' OR completed_at IS NULL) AS unresolved,
         count(*) FILTER (WHERE state = 'uncertain') AS uncertain
    FROM app.operation
   WHERE organization_id = $1 AND parent_operation_id IS NULL
     AND state IN ('accepted', 'executing', 'awaiting_input', 'uncertain')`;

/**
 * `days` UTC days that end with today. `productActions` are the actions whose
 * outcomes are counted; `deniedAction` is counted by itself. Throws
 * `AuditReadTimeout` when a statement passes the deadline: the caller's `503 busy`.
 */
export async function readMetrics(
  pool: pg.Pool,
  organizationId: string,
  days: number,
  productActions: readonly string[],
  deniedAction: string,
): Promise<Metrics> {
  try {
    return await withTransaction(pool, async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      await tx.query(`SET LOCAL statement_timeout = ${String(AUDIT_READ_TIMEOUT_MS)}`);
      const window = await tx.query<{ now: Date; from_at: Date }>(WINDOW, [days]);
      const bounds = window.rows[0];
      if (bounds === undefined) throw new Error("the database gave no time");
      const first = await tx.query<{ first: Date | null }>(FIRST, [organizationId]);
      const counts = await tx.query<{
        day: string;
        success: string;
        failure: string;
        unknown: string;
        denied: string;
      }>(COUNTS, [organizationId, bounds.from_at, productActions, deniedAction]);
      const operations = await tx.query<{ unresolved: string; uncertain: string }>(OPERATIONS, [
        organizationId,
      ]);
      return {
        observedAt: bounds.now,
        from: bounds.from_at,
        measuredFrom: first.rows[0]?.first ?? null,
        days: new Map(
          counts.rows.map((row) => [
            row.day,
            {
              success: Number(row.success),
              failure: Number(row.failure),
              unknown: Number(row.unknown),
              denied: Number(row.denied),
            },
          ]),
        ),
        operations: {
          unresolved: Number(operations.rows[0]?.unresolved ?? 0),
          uncertain: Number(operations.rows[0]?.uncertain ?? 0),
        },
      };
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === "57014") throw new AuditReadTimeout();
    throw error;
  }
}
