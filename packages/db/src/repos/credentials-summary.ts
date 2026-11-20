// The organization's machine credentials in numbers (Run 7.7, P-139): how
// many there are in each state, and which active ones end soon. One
// transaction on one snapshot, so the counts and the list are of one moment.
// States are derived as the inventory derives them (repos/credentials.ts): an
// `active` row past its expiry counts as `expired`, whatever the sweep has
// written yet. Nothing here reads an accessor.
import { LIMITS } from "@mykey/contracts";
import type pg from "pg";
import { withTransaction } from "../tx.ts";
import { AUDIT_READ_TIMEOUT_MS, AuditReadTimeout } from "./audit-read.ts";
import type { CredentialState } from "./credentials.ts";

export interface ExpiringCredential {
  id: string;
  name: string;
  projectId: string;
  environmentId: string;
  expiresAt: Date;
}

export interface CredentialsSummary {
  /** The database's time of the read. */
  observedAt: Date;
  byState: Record<CredentialState, number>;
  /** Active credentials within the expiry warning, soonest first, at most `maxExpiring`. */
  expiring: ExpiringCredential[];
  /** More credentials are expiring than `expiring` holds. */
  expiringTruncated: boolean;
}

const WARNING = String(LIMITS.machineToken.expiryWarningSeconds);

const COUNTS = `
  SELECT CASE WHEN c.state = 'active' AND coalesce(c.effective_expires_at <= now(), false)
              THEN 'expired' ELSE c.state END AS state,
         count(*) AS count
    FROM app.machine_credential c
   WHERE c.organization_id = $1
     -- An issuance that never made a token: the inventory does not list it either.
     AND NOT (c.state = 'revoked' AND c.accessor IS NULL)
   GROUP BY 1`;

const EXPIRING = `
  SELECT c.id, c.name, c.project_id, c.environment_id, c.effective_expires_at
    FROM app.machine_credential c
   WHERE c.organization_id = $1
     AND c.state = 'active'
     AND c.effective_expires_at > now()
     AND c.effective_expires_at <= now() + make_interval(secs => ${WARNING})
   ORDER BY c.effective_expires_at, c.id
   LIMIT $2`;

/** Throws `AuditReadTimeout` when the read passes the statement deadline: the caller's `503 busy`. */
export async function readCredentialsSummary(
  pool: pg.Pool,
  organizationId: string,
  maxExpiring: number,
): Promise<CredentialsSummary> {
  let read;
  try {
    read = await withTransaction(pool, async (tx) => {
      // One snapshot for both statements; now() is the transaction's time in each.
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      await tx.query(`SET LOCAL statement_timeout = ${String(AUDIT_READ_TIMEOUT_MS)}`);
      const now = await tx.query<{ now: Date }>("SELECT now() AS now");
      const counts = await tx.query<{ state: CredentialState; count: string }>(COUNTS, [
        organizationId,
      ]);
      const expiring = await tx.query<{
        id: string;
        name: string;
        project_id: string;
        environment_id: string;
        effective_expires_at: Date;
      }>(EXPIRING, [organizationId, maxExpiring + 1]);
      const observedAt = now.rows[0]?.now;
      if (observedAt === undefined) throw new Error("the database gave no time");
      return { observedAt, counts: counts.rows, expiring: expiring.rows };
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === "57014") throw new AuditReadTimeout();
    throw error;
  }
  const byState: Record<CredentialState, number> = {
    issuing: 0,
    active: 0,
    revoking: 0,
    revoked: 0,
    expired: 0,
    needs_review: 0,
  };
  for (const row of read.counts) byState[row.state] = Number(row.count);
  return {
    observedAt: read.observedAt,
    byState,
    expiring: read.expiring.slice(0, maxExpiring).map((row) => ({
      id: row.id,
      name: row.name,
      projectId: row.project_id,
      environmentId: row.environment_id,
      expiresAt: row.effective_expires_at,
    })),
    expiringTruncated: read.expiring.length > maxExpiring,
  };
}
