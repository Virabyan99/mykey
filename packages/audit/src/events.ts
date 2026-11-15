// The closed list of audit actions (P-44). Each action has a strict `details`
// schema whose fields are ids, enums, integers or booleans — or strings with a
// pattern and a maximum under 64 — so no free text, value, name or credential
// can be written into the log. The list grows only in this file, one action at
// a time, by the run that first records it.
import { SECRET_NAME_PATTERN } from "@mykey/contracts";
import { z } from "zod";

const routeId = z
  .string()
  .max(48)
  .regex(/^[a-z]+(?:\.[a-z]+)+$/);

/** A secret's name (P-71): the one string up to 128 characters, under the name pattern. */
const secretName = z.string().max(128).regex(SECRET_NAME_PATTERN);
const version = z.int().positive();
/** One audit row per secret action; never a value, a value's length or a digest. */
const secretDetails = z.strictObject({ name: secretName, version: version.optional() });
const importCounts = z.strictObject({
  entries: z.int().nonnegative().optional(),
  created: z.int().nonnegative().optional(),
  updated: z.int().nonnegative().optional(),
  unchanged: z.int().nonnegative().optional(),
  conflict: z.int().nonnegative().optional(),
  rejected: z.int().nonnegative().optional(),
  uncertain: z.int().nonnegative().optional(),
  not_attempted: z.int().nonnegative().optional(),
});

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
  /** Run 3.9: project and environment metadata; ids in target, the name's length only. */
  "project.create": z.strictObject({ nameLength: z.int().min(1).max(64) }),
  "project.rename": z.strictObject({ nameLength: z.int().min(1).max(64) }),
  "environment.create": z.strictObject({ nameLength: z.int().min(1).max(64) }),
  "environment.rename": z.strictObject({ nameLength: z.int().min(1).max(64) }),
  /** Run 5.3 (P-91, P-92): how many environments the archive or reactivation covers. */
  "project.archive": z.strictObject({ environments: z.int().nonnegative() }),
  "environment.archive": z.strictObject({ environments: z.int().nonnegative() }),
  "project.reactivate": z.strictObject({ environments: z.int().nonnegative() }),
  "environment.reactivate": z.strictObject({ environments: z.int().nonnegative() }),
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
      // Run 4.2 (P-71): a runtime request was refused, or the index and KV disagree.
      "kv_data",
    ]),
  }),
  /** Run 4.2 (P-71): the secret actions. Target is the environment; the name is in details. */
  "secret.create": secretDetails,
  "secret.update": secretDetails,
  "secret.delete": secretDetails,
  "secret.undelete": secretDetails,
  "secret.restore": z.strictObject({
    name: secretName,
    version: version.optional(),
    sourceVersion: version.optional(),
  }),
  "secret.reveal": secretDetails,
  /** Run 4.9: the complete read behind an export; the number of names only. */
  "secret.export": z.strictObject({ names: z.int().nonnegative() }),
  /** Run 4.7: import preview, apply and resume. */
  "import.preview": importCounts,
  "import.apply": importCounts,
  "import.resume": importCounts,
  /** Run 4.5: the stale-work sweep made an executing operation uncertain. */
  "system.operation_stuck": z.strictObject({
    action: routeId,
    name: secretName.optional(),
  }),
  /** Run 4.5: the operator settled an operation or rebuilt an environment. */
  "operator.reconcile_operation": z.strictObject({
    name: secretName.optional(),
    verdict: z.enum(["succeeded", "rejected", "closed_unknown"]),
    executorsExcluded: z.boolean(),
  }),
  "operator.reconcile_environment": z.strictObject({
    names: z.int().nonnegative(),
    changed: z.int().nonnegative(),
  }),
  /**
   * Run 5.1 (P-95): machine credentials. Target is the environment; the
   * credential's id is in details, its name by length only (as a project's).
   * Never an accessor, a token or a digest of one.
   */
  "credential.issue": z.strictObject({
    credentialId: z.uuid(),
    nameLength: z.int().min(1).max(64),
    ttlSeconds: z.int().positive(),
  }),
  "credential.revoke": z.strictObject({ credentialId: z.uuid() }),
  /**
   * Run 5.4 (P-94, P-95): a machine read of its environment. Actor: the
   * credential. The number of names and the generation; never a name.
   */
  "machine.keys": z.strictObject({
    names: z.int().nonnegative(),
    generation: z
      .string()
      .max(20)
      .regex(/^(0|[1-9][0-9]*)$/),
  }),
  "machine.resolve": z.strictObject({
    names: z.int().nonnegative(),
    generation: z
      .string()
      .max(20)
      .regex(/^(0|[1-9][0-9]*)$/),
  }),
  /** Run 5.2 (P-90): the operator settled an environment's credentials. Counts only. */
  "operator.reconcile_credentials": z.strictObject({
    unrecordedRevoked: z.int().nonnegative(),
    revocationsCompleted: z.int().nonnegative(),
    issuancesSettled: z.int().nonnegative(),
    left: z.int().nonnegative(),
    executorsExcluded: z.boolean(),
  }),
  /** Run 4.1: the operator expired terminal operation records (P-65). */
  "operator.operations_expire": z.strictObject({ expired: z.int().nonnegative() }),
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
  /** `intent` is written before an effect is sent; `unknown` when its result cannot be known (Run 4.2). */
  outcome: "success" | "denied" | "failure" | "intent" | "unknown";
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
  outcome: z.enum(["success", "denied", "failure", "intent", "unknown"]),
  requestId: z.uuid().nullable(),
  operationId: z.uuid().nullable(),
  details: z.record(z.string(), z.unknown()),
});
