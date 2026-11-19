// The operator's clean-up of spent factor rows (Run 3.5, D-29). The API's role
// may not delete used TOTP steps or recovery codes — a compromised API must not
// erase replay evidence — so `maintenance` does it (`ops auth-cleanup`; a timer
// runs it from Run 6.9). A step older than a day is far outside its window and
// cannot be replayed any more. Run 6.1 (P-105): the deletions and their
// `operator.auth_cleanup` row are one transaction.
import { appendAudit } from "@mykey/audit";
import { withTransaction } from "@mykey/db";
import type pg from "pg";

export async function cleanUpFactors(pool: pg.Pool): Promise<{ steps: number; codes: number }> {
  return withTransaction(pool, async (tx) => {
    const steps = await tx.query(
      "DELETE FROM auth.totp_step_used WHERE used_at < now() - interval '1 day'",
    );
    const codes = await tx.query(
      `DELETE FROM auth.recovery_code
        WHERE consumed_at IS NOT NULL
           OR enrollment_id IN (SELECT id FROM auth.totp_enrollment WHERE state = 'retired')`,
    );
    const removed = { steps: steps.rowCount ?? 0, codes: codes.rowCount ?? 0 };
    await appendAudit(tx, {
      action: "operator.auth_cleanup",
      actor: { kind: "operator", id: null },
      source: "operator",
      organizationId: null,
      target: null,
      outcome: "success",
      requestId: null,
      operationId: null,
      details: { steps: removed.steps, recoveryRows: removed.codes },
    });
    return removed;
  });
}
