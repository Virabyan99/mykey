// Fresh verification (FR-1.77, Run 3.4): a session is fresh while its last TOTP
// verification is younger than LIMITS.session.freshTotpSeconds — on database
// time — and the enrollment it was made with is still the user's active one.
import { LIMITS } from "@mykey/contracts";
import type { Queryable } from "@mykey/db";

export async function hasFreshTotp(db: Queryable, sessionId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
       FROM auth.session s
       JOIN auth.totp_enrollment e ON e.id = s.enrollment_id
      WHERE s.id = $1
        AND e.state = 'active'
        AND e.user_id = s.user_id
        AND s.totp_verified_at > now() - make_interval(secs => $2)`,
    [sessionId, LIMITS.session.freshTotpSeconds],
  );
  return result.rowCount === 1;
}
