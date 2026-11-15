// The credential rules of the stale-work sweep (Run 5.2, P-90, D-40). Each
// rule is one conditional update; the operation rules also clear
// `executor_boot_id`, so the executor that comes back late can no longer
// finalize (finishOperation answers null). Two sweepers at once: the row lock
// lets one update a row, the other's re-checked condition no longer holds —
// one audit row each.
//
// - an issuance executing with a heartbeat older than 120 s → uncertain, its
//   credential issuing → needs_review (it blocks the next issuance until the
//   operator settles it); `system.operation_stuck`.
// - a revocation likewise → uncertain; its credential stays `revoking` (closed
//   first: it never reads active again); `system.operation_stuck`.
// - an active credential past its expiry → expired (not an operation: no
//   audit row; every reader already compares the expiry with now()).
//
// It touches PostgreSQL only: it works while OpenBao is unreachable.
import { appendAudit } from "@mykey/audit";
import {
  LIMITS,
  type EnvironmentId,
  type OperationId,
  type OrganizationId,
} from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import type pg from "pg";

export const CREDENTIAL_ACTIONS = ["credentials.issue", "credentials.revoke"] as const;

export interface CredentialSweepResult {
  uncertain: OperationId[];
  expired: number;
}

export async function sweepCredentials(
  pool: pg.Pool,
  opts: { staleSeconds?: number; environmentId?: EnvironmentId } = {},
): Promise<CredentialSweepResult> {
  const staleSeconds = opts.staleSeconds ?? LIMITS.operation.stuckAlertSeconds;
  const environmentId = opts.environmentId ?? null;

  const uncertain = await withTransaction(pool, async (tx) => {
    const rows = await tx.query<{
      id: OperationId;
      organization_id: OrganizationId;
      environment_id: EnvironmentId;
      action: string;
    }>(
      `UPDATE app.operation SET state = 'uncertain', executor_boot_id = NULL
        WHERE action = ANY($1::text[]) AND state = 'executing'
          AND heartbeat_at < now() - make_interval(secs => $2)
          AND ($3::uuid IS NULL OR environment_id = $3)
        RETURNING id, organization_id, environment_id, action`,
      [[...CREDENTIAL_ACTIONS], staleSeconds, environmentId],
    );
    for (const row of rows.rows) {
      if (row.action === "credentials.issue") {
        await tx.query(
          `UPDATE app.machine_credential SET state = 'needs_review'
            WHERE issuance_operation_id = $1 AND state = 'issuing'`,
          [row.id],
        );
      }
      await appendAudit(tx, {
        action: "system.operation_stuck",
        actor: { kind: "system", id: null },
        source: "api",
        organizationId: row.organization_id,
        target: { kind: "environment", id: row.environment_id },
        outcome: "unknown",
        requestId: null,
        operationId: row.id,
        details: { action: row.action },
      });
    }
    return rows.rows.map((row) => row.id);
  });

  const expired = await pool.query(
    `UPDATE app.machine_credential SET state = 'expired'
      WHERE state = 'active' AND effective_expires_at <= now()
        AND ($1::uuid IS NULL OR environment_id = $1)`,
    [environmentId],
  );

  return { uncertain, expired: expired.rowCount ?? 0 };
}
