// The operator's clean-up of spent factor rows (Run 3.5, D-29). The API's role
// may not delete used TOTP steps or recovery codes — a compromised API must not
// erase replay evidence — so `maintenance` does it (`ops auth-cleanup`; a timer
// runs it from Run 6.9). A step older than a day is far outside its window and
// cannot be replayed any more.
import type { Queryable } from "@mykey/db";

export async function cleanUpFactors(db: Queryable): Promise<{ steps: number; codes: number }> {
  const steps = await db.query(
    "DELETE FROM auth.totp_step_used WHERE used_at < now() - interval '1 day'",
  );
  const codes = await db.query(
    `DELETE FROM auth.recovery_code
      WHERE consumed_at IS NOT NULL
         OR enrollment_id IN (SELECT id FROM auth.totp_enrollment WHERE state = 'retired')`,
  );
  return { steps: steps.rowCount ?? 0, codes: codes.rowCount ?? 0 };
}
