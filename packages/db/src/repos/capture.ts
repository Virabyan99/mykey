// Run 6.5 (P-118, D-51): the capture mode of the single service_control row,
// and the access reductions recorded while it was not idle. Only maintenance
// changes the mode (a trigger of migration 0017 refuses everyone else); while
// it is `capturing`, a write to any table of app and auth but four raises
// SQLSTATE MKC01, unless the transaction recorded an invalidation first.
import type { Queryable } from "../tx.ts";

export type CaptureMode = "idle" | "draining" | "capturing";

/** The SQLSTATE the barrier trigger raises. */
export const CAPTURE_SQLSTATE = "MKC01";

/** True for an error the barrier raised (a statement refused while capturing). */
export function isCaptureRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === CAPTURE_SQLSTATE
  );
}

export type InvalidationReason = "sign_out" | "session_revoke" | "credential_revoke" | "archive";

export async function captureMode(
  db: Queryable,
  opts: { lock?: "share" } = {},
): Promise<{ mode: CaptureMode; pairId: string | null; since: Date }> {
  const result = await db.query<{
    capture_mode: CaptureMode;
    pair_id: string | null;
    updated_at: Date;
  }>(
    `SELECT capture_mode, pair_id, updated_at FROM app.service_control${
      opts.lock === "share" ? " FOR SHARE" : ""
    }`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("app.service_control has no row");
  return { mode: row.capture_mode, pairId: row.pair_id, since: row.updated_at };
}

/**
 * As maintenance: from → to, in the caller's transaction. False when the row
 * was not in `from`. Entering `draining` starts a new epoch.
 */
export async function setCaptureMode(
  tx: Queryable,
  from: CaptureMode,
  to: CaptureMode,
  pairId: string | null,
  owner: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE app.service_control
        SET capture_mode = $2, pair_id = $3, owner = $4, updated_at = now(),
            epoch = epoch + CASE WHEN $2 = 'draining' THEN 1 ELSE 0 END
      WHERE capture_mode = $1`,
    [from, to, to === "idle" ? null : pairId, to === "idle" ? null : owner],
  );
  return result.rowCount === 1;
}

/**
 * First in each writing transaction of an action that reduces access. Idle:
 * nothing. Otherwise one invalidation row for the transaction, which lets the
 * barrier pass it. Answers whether a capture was crossed.
 */
export async function invalidateCapture(
  tx: Queryable,
  reason: InvalidationReason,
): Promise<boolean> {
  const result = await tx.query<{ crossed: boolean }>(
    "SELECT app.capture_invalidate($1) AS crossed",
    [reason],
  );
  return result.rows[0]?.crossed === true;
}

/** How many reductions were recorded in [from, to]. */
export async function invalidationsBetween(db: Queryable, from: Date, to: Date): Promise<number> {
  const result = await db.query<{ count: string }>(
    "SELECT count(*) AS count FROM app.backup_invalidation WHERE at >= $1 AND at <= $2",
    [from, to],
  );
  return Number(result.rows[0]?.count ?? 0);
}
