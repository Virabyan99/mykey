// The closed list of audit actions (P-44). Each action has a strict `details`
// schema whose fields are ids, enums, integers or booleans — or strings with a
// pattern and a maximum under 64 — so no free text, value, name or credential
// can be written into the log. The list grows only in this file, one action at
// a time, by the run that first records it.
import { z } from "zod";

const routeId = z
  .string()
  .max(48)
  .regex(/^[a-z]+(?:\.[a-z]+)+$/);

const factorReason = z.enum(["invalid", "replayed", "expired", "wrong_state", "not_fresh"]);

export const AUDIT_DETAILS = {
  /** Run 3.2: the owner bootstrap. Ids are in actor and target. */
  "operator.bootstrap": z.strictObject({}),
  /** Run 3.6: an operator reset was issued. */
  "operator.reset_initiate": z.strictObject({ kind: z.enum(["password", "mfa"]) }),
  /** Run 3.6: a reset completed; or refused, with the reason. */
  "auth.reset_complete": z.strictObject({ kind: z.enum(["password", "mfa"]) }),
  "auth.reset_failed": z.strictObject({
    reason: z.enum(["token", "factor", "state", "password"]),
  }),
  /** Run 3.2: a password sign-in attempt. */
  "auth.sign_in": z.strictObject({
    reason: z.enum(["credentials", "account", "epoch"]).optional(),
  }),
  /** Run 3.4: the factor steps; on failure the reason, never the code. */
  "auth.totp_enroll": z.strictObject({ reason: factorReason.optional() }),
  "auth.totp_activate": z.strictObject({ reason: factorReason.optional() }),
  "auth.mfa_complete": z.strictObject({
    method: z.enum(["totp", "recovery"]),
    reason: factorReason.optional(),
  }),
  "auth.step_up": z.strictObject({ reason: factorReason.optional() }),
  "auth.recovery_regenerate": z.strictObject({ reason: factorReason.optional() }),
  /** Run 3.5: the product-owned password change. */
  "auth.password_change": z.strictObject({ revokedSessions: z.int().nonnegative() }),
  /** Run 3.3: an attempt refused by throttling before any credential was checked. */
  "auth.throttled": z.strictObject({
    phase: z.enum(["password", "factor", "reset"]),
  }),
  /** Run 3.7: a request of an authenticated caller that the pipeline refused. */
  "access.denied": z.strictObject({
    routeId,
    reason: z.enum(["hidden", "action", "state", "fresh"]),
  }),
  /** Run 3.8: the organization became active, or stopped for review at a step. */
  "operator.organization_provision": z.strictObject({
    outcome: z.enum(["active", "review"]),
    step: z
      .string()
      .max(32)
      .regex(/^[a-z]+(?:[-:][a-z]+)*$/)
      .optional(),
  }),
  /** Run 3.8: the provisioner finished an environment, or sent it to review. */
  "system.environment_provision": z.strictObject({
    outcome: z.enum(["active", "review"]),
    reason: z.enum(["backend_inconsistent", "provisioning_failed"]).optional(),
  }),
  /** Run 3.8: the drift sweep found an object that differs from what was provisioned. */
  "system.drift_detected": z.strictObject({
    scope: z.enum(["organization", "environment"]),
    object: z.enum([
      "kv_mount",
      "kv_config",
      "policy_runtime",
      "policy_issuer",
      "policy_provisioner",
      "provisioner_login",
      "machine_policy",
      "machine_token_role",
    ]),
  }),
} as const;

export type AuditAction = keyof typeof AUDIT_DETAILS;

export const AUDIT_ACTIONS = Object.freeze(Object.keys(AUDIT_DETAILS) as AuditAction[]);

export type AuditDetails = Record<string, string | number | boolean | null>;

export interface AuditEvent {
  action: AuditAction;
  actor: { kind: "user" | "machine" | "operator" | "system" | "anonymous"; id: string | null };
  source: "web" | "cli" | "api" | "operator" | "system";
  organizationId: string | null;
  target: { kind: string; id: string | null } | null;
  outcome: "success" | "denied" | "failure";
  requestId: string | null;
  operationId: string | null;
  details: AuditDetails;
}

/** The parts of an event outside `details`: ids, enums and a short kind name. */
export const auditEnvelopeSchema = z.strictObject({
  action: z.enum(AUDIT_ACTIONS as [AuditAction, ...AuditAction[]]),
  actor: z.strictObject({
    kind: z.enum(["user", "machine", "operator", "system", "anonymous"]),
    // A user, machine credential or operation id; the operator and the system have none.
    id: z.uuid().nullable(),
  }),
  source: z.enum(["web", "cli", "api", "operator", "system"]),
  organizationId: z.uuid().nullable(),
  target: z
    .strictObject({
      kind: z
        .string()
        .max(32)
        .regex(/^[a-z_]+$/),
      id: z.uuid().nullable(),
    })
    .nullable(),
  outcome: z.enum(["success", "denied", "failure"]),
  requestId: z.uuid().nullable(),
  operationId: z.uuid().nullable(),
  details: z.record(z.string(), z.unknown()),
});
