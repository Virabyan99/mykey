// The way out of the audit trail (Run 6.1, P-107). A stored row's `details`
// passes its action's own strict schema again before it is served: a row
// written past `appendAudit` (by a superuser, or by an older release whose
// schema has changed since) is served with `{}` and reported invalid, so no
// field nobody allowed leaves the API.
import { AUDIT_DETAILS, type AuditAction, type AuditDetails } from "./events.ts";

export function servedDetails(
  action: AuditAction,
  details: unknown,
): { details: AuditDetails; valid: boolean } {
  const parsed = AUDIT_DETAILS[action].safeParse(details);
  if (!parsed.success) return { details: {}, valid: false };
  return { details: parsed.data as AuditDetails, valid: true };
}
