// Audit rows for the view tests (Run 6.1): valid details for every action of
// the closed list, and one writer that places an action's row in the right
// scope (P-106). Rows go through `appendAudit` on the superuser pool, so each
// is validated exactly as a product writer's would be. A new action fails to
// compile here until it has details.
import { randomUUID } from "node:crypto";
import {
  ACCOUNT_WITHOUT_ORGANIZATION,
  AUDIT_SCOPE,
  appendAudit,
  type AuditAction,
  type AuditDetails,
  type AuditEvent,
} from "@mykey/audit";
import type { Queryable } from "@mykey/db";

const ID = "0b8f3c7e-5a1d-4c2b-8e9f-1a2b3c4d5e6f";

export const DETAILS_OF: Readonly<Record<AuditAction, AuditDetails>> = {
  "operator.bootstrap": {},
  "operator.reset_initiate": { kind: "password" },
  "auth.reset_complete": { kind: "password" },
  "auth.reset_failed": { reason: "token" },
  "auth.sign_in": {},
  "auth.totp_enroll": {},
  "auth.totp_activate": {},
  "auth.mfa_complete": { method: "totp" },
  "auth.step_up": {},
  "auth.recovery_regenerate": {},
  "auth.password_change": { revokedSessions: 0 },
  "auth.throttled": { phase: "password" },
  "access.denied": { routeId: "projects.list", reason: "action" },
  "operator.organization_provision": { outcome: "active" },
  "project.create": { nameLength: 4 },
  "project.rename": { nameLength: 4 },
  "environment.create": { nameLength: 4 },
  "environment.rename": { nameLength: 4 },
  "project.archive": { environments: 1 },
  "environment.archive": { environments: 1 },
  "project.reactivate": { environments: 1 },
  "environment.reactivate": { environments: 1 },
  "system.environment_provision": { outcome: "active" },
  "system.drift_detected": { scope: "environment", object: "kv_data" },
  "secret.create": { name: "FIXTURE_NAME", version: 1 },
  "secret.update": { name: "FIXTURE_NAME", version: 2 },
  "secret.delete": { name: "FIXTURE_NAME", version: 2 },
  "secret.undelete": { name: "FIXTURE_NAME", version: 2 },
  "secret.restore": { name: "FIXTURE_NAME", version: 3, sourceVersion: 1 },
  "secret.reveal": { name: "FIXTURE_NAME", version: 3 },
  "secret.export": { names: 2 },
  "import.preview": { entries: 2 },
  "import.apply": { entries: 2 },
  "import.resume": { created: 2 },
  "system.operation_stuck": { action: "secrets.create" },
  "operator.reconcile_operation": { verdict: "succeeded", executorsExcluded: true },
  "operator.reconcile_environment": { names: 1, changed: 0 },
  "credential.issue": { credentialId: ID, nameLength: 4, ttlSeconds: 3600 },
  "credential.revoke": { credentialId: ID },
  "machine.keys": { names: 1, generation: "1" },
  "machine.resolve": { names: 1, generation: "1" },
  "operator.reconcile_credentials": {
    unrecordedRevoked: 0,
    revocationsCompleted: 0,
    issuancesSettled: 0,
    left: 0,
    executorsExcluded: true,
  },
  "operator.operations_expire": { expired: 0 },
  "auth.sign_out": {},
  "auth.session_revoke": { revokedSessions: 1 },
  "operator.auth_cleanup": { steps: 0, recoveryRows: 0 },
  "system.audit_archive": { stream: "app", sequence: 1, rows: 0 },
  "system.audit_purge": { rows: 0, intervals: 0 },
  "system.backup_capture": { pairId: ID },
  "system.backup_eligible": { pairId: ID },
  "system.backup_invalidated": { pairId: ID, reason: "deadline" },
  "system.backup_cleanup": { deleted: 0, kept: 1, refused: 0 },
  "operator.gate_open": { gateEpoch: 1, origin: "fresh_install" },
  "operator.gate_close": { gateEpoch: 1 },
  "operator.restore_begin": { pairId: ID },
  "operator.restore_invalidate": { sessions: 0, accounts: 0, credentials: 0, namespaces: 0 },
  "operator.restore_verify": { checks: 1, failed: 0 },
  "operator.deploy": { build: "45b5c1f3cc3a" },
};

export interface Placement {
  /** The organization of a tenant row. */
  organizationId: string;
  /** The user an account row belongs to (its actor). */
  userId: string;
  /** The target of a tenant row (a project or environment id), when the test wants one. */
  target?: { kind: string; id: string };
  operationId?: string | null;
  requestId?: string | null;
  outcome?: AuditEvent["outcome"];
}

/** Writes one row of `action` where its scope puts it; answers the row's id. */
export function writeAuditRow(
  db: Queryable,
  action: AuditAction,
  place: Placement,
): Promise<string> {
  const scope = AUDIT_SCOPE[action];
  const tenant = scope === "tenant";
  const event: AuditEvent = {
    action,
    actor: scope === "global" ? { kind: "operator", id: null } : { kind: "user", id: place.userId },
    source: scope === "global" ? "operator" : "api",
    organizationId: tenant ? place.organizationId : null,
    target: tenant ? (place.target ?? { kind: "organization", id: place.organizationId }) : null,
    outcome: place.outcome ?? "success",
    requestId: place.requestId ?? randomUUID(),
    operationId: place.operationId ?? null,
    details: DETAILS_OF[action],
  };
  // A denial of an organization the caller is not a member of names none (P-106).
  if (tenant && ACCOUNT_WITHOUT_ORGANIZATION.has(action) && place.organizationId === "") {
    event.organizationId = null;
    event.target = null;
  }
  return appendAudit(db, event);
}
