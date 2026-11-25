// The closed list of audit actions (P-44). Each action has a strict `details`
// schema whose fields are ids, enums, integers or booleans — or strings with a
// pattern and a maximum under 64 — so no free text, value, name or credential
// can be written into the log. The list grows only in this file, one action at
// a time, by the run that first records it.
import { SECRET_NAME_PATTERN } from "@mykey/contracts";
import { z } from "zod";

// Session 11: a route id may hold an underscore (`runtime_credentials.issue`).
const routeId = z
  .string()
  .max(48)
  .regex(/^[a-z]+(?:[._][a-z]+)+$/);

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
    // Session 11 (P-186): absent on a 30-day token's row, as before.
    kind: z.enum(["token", "runtime"]).optional(),
    cidrCount: z.int().min(0).max(8).optional(),
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
  /** Run 6.1 (P-105): a session ended by its user. */
  "auth.sign_out": z.strictObject({}),
  /** Run 6.1 (P-105): sessions ended by their user (one, or every one). */
  "auth.session_revoke": z.strictObject({ revokedSessions: z.int().nonnegative() }),
  /** Run 6.1 (P-105): spent TOTP steps and recovery rows removed. Counts only. */
  "operator.auth_cleanup": z.strictObject({
    steps: z.int().nonnegative(),
    recoveryRows: z.int().nonnegative(),
  }),
  /** Run 6.2 (P-112): one archived segment of a stream. */
  "system.audit_archive": z.strictObject({
    stream: z.enum(["app", "openbao"]),
    sequence: z.int().positive(),
    rows: z.int().nonnegative(),
  }),
  /** Run 6.2 (P-112): rows older than the retention purged, inside verified intervals. */
  "system.audit_purge": z.strictObject({
    rows: z.int().nonnegative(),
    intervals: z.int().nonnegative(),
  }),
  /** Run 6.5 (P-120): the capture of a pair; intent, success or failure. */
  "system.backup_capture": z.strictObject({ pairId: z.uuid() }),
  "system.backup_eligible": z.strictObject({ pairId: z.uuid() }),
  "system.backup_invalidated": z.strictObject({
    pairId: z.uuid(),
    reason: z.enum(["deadline", "access_reduction", "verification", "aborted"]),
  }),
  /** Run 6.6 (P-121): the retention job's counts. */
  "system.backup_cleanup": z.strictObject({
    deleted: z.int().nonnegative(),
    kept: z.int().nonnegative(),
    refused: z.int().nonnegative(),
  }),
  /** Run 6.7 (P-122): the gate. */
  "operator.gate_open": z.strictObject({
    gateEpoch: z.int().nonnegative(),
    origin: z.enum(["fresh_install", "restore"]),
  }),
  "operator.gate_close": z.strictObject({ gateEpoch: z.int().nonnegative() }),
  /** Run 6.7 (P-124): a restore, written into the restored database. */
  "operator.restore_begin": z.strictObject({ pairId: z.uuid() }),
  "operator.restore_invalidate": z.strictObject({
    sessions: z.int().nonnegative(),
    accounts: z.int().nonnegative(),
    credentials: z.int().nonnegative(),
    namespaces: z.int().nonnegative(),
  }),
  "operator.restore_verify": z.strictObject({
    checks: z.int().nonnegative(),
    failed: z.int().nonnegative(),
  }),
  /** Run 6.9 (P-127): a release deployed; the build id only. */
  "operator.deploy": z.strictObject({
    build: z
      .string()
      .max(40)
      .regex(/^[0-9a-f]{7,40}$/),
  }),
  /**
   * Session 11 (P-187): a runtime credential was exchanged for a short-lived
   * token. Actor: the credential; target: its environment. Never the client
   * secret, the token or its accessor.
   */
  "machine.exchange": z.strictObject({
    credentialId: z.uuid(),
    ttlSeconds: z.int().positive(),
  }),
  /**
   * Session 11 (P-191, P-192): an automation credential. Target: the
   * organization. Its rights as three booleans (`keysCreate` is the right
   * `secrets.create`: no details key may hold that word); its name by length;
   * never its secret, its verifier or an address.
   */
  "automation_credential.issue": z.strictObject({
    credentialId: z.uuid(),
    ownerId: z.uuid(),
    nameLength: z.int().min(1).max(64),
    ttlSeconds: z.int().positive(),
    cidrCount: z.int().min(1).max(8),
    projectsCreate: z.boolean(),
    keysCreate: z.boolean(),
    runtimeCredentialsManage: z.boolean(),
    replaces: z.uuid().optional(),
  }),
  "automation_credential.revoke": z.strictObject({ credentialId: z.uuid() }),
} as const;

export type AuditAction = keyof typeof AUDIT_DETAILS;

export const AUDIT_ACTIONS = Object.freeze(Object.keys(AUDIT_DETAILS) as AuditAction[]);

/**
 * Run 6.1 (P-106, FR-1.58): whose row an action is.
 * - `tenant`: written with the organization; served to its owners and admins.
 * - `account`: written without an organization; served to an organization
 *   whose member the row's subject user (actor, else target) is now.
 * - `global`: the infrastructure's; written without an organization, never
 *   served by the API (the operator reads it with `psql` as `maintenance`).
 * `appendAudit` refuses an organization id on a global or account action and
 * its absence on a tenant action — except `access.denied`, see below.
 */
export type AuditScope = "tenant" | "account" | "global";

export const AUDIT_SCOPE: Readonly<Record<AuditAction, AuditScope>> = Object.freeze({
  "operator.bootstrap": "tenant",
  "operator.reset_initiate": "account",
  "auth.reset_complete": "account",
  "auth.reset_failed": "account",
  "auth.sign_in": "account",
  "auth.totp_enroll": "account",
  "auth.totp_activate": "account",
  "auth.mfa_complete": "account",
  "auth.step_up": "account",
  "auth.recovery_regenerate": "account",
  "auth.password_change": "account",
  "auth.throttled": "global",
  "access.denied": "tenant",
  "operator.organization_provision": "tenant",
  "project.create": "tenant",
  "project.rename": "tenant",
  "environment.create": "tenant",
  "environment.rename": "tenant",
  "project.archive": "tenant",
  "environment.archive": "tenant",
  "project.reactivate": "tenant",
  "environment.reactivate": "tenant",
  "system.environment_provision": "tenant",
  "system.drift_detected": "tenant",
  "secret.create": "tenant",
  "secret.update": "tenant",
  "secret.delete": "tenant",
  "secret.undelete": "tenant",
  "secret.restore": "tenant",
  "secret.reveal": "tenant",
  "secret.export": "tenant",
  "import.preview": "tenant",
  "import.apply": "tenant",
  "import.resume": "tenant",
  "system.operation_stuck": "tenant",
  "operator.reconcile_operation": "tenant",
  "operator.reconcile_environment": "tenant",
  "credential.issue": "tenant",
  "credential.revoke": "tenant",
  "machine.keys": "tenant",
  "machine.resolve": "tenant",
  "operator.reconcile_credentials": "tenant",
  "operator.operations_expire": "global",
  "auth.sign_out": "account",
  "auth.session_revoke": "account",
  "operator.auth_cleanup": "global",
  "system.audit_archive": "global",
  "system.audit_purge": "global",
  "system.backup_capture": "global",
  "system.backup_eligible": "global",
  "system.backup_invalidated": "global",
  "system.backup_cleanup": "global",
  "operator.gate_open": "global",
  "operator.gate_close": "global",
  "operator.restore_begin": "global",
  "operator.restore_invalidate": "global",
  "operator.restore_verify": "global",
  "operator.deploy": "global",
  "machine.exchange": "tenant",
  "automation_credential.issue": "tenant",
  "automation_credential.revoke": "tenant",
} satisfies Record<AuditAction, AuditScope>);

/**
 * A denial is the organization's row when the caller is its member; a
 * request against an organization the caller does not belong to names none
 * (the hidden 404 must not attribute it) and is then the caller's account row.
 */
export const ACCOUNT_WITHOUT_ORGANIZATION: ReadonlySet<AuditAction> = new Set(["access.denied"]);

/** The actions an organization's audit view may serve (P-107): tenant and account. */
export const SERVED_ACTIONS: readonly AuditAction[] = Object.freeze(
  AUDIT_ACTIONS.filter((action) => AUDIT_SCOPE[action] !== "global"),
);

/** The product's actions, for the workspace's activity timeline (P-108). */
export const ACTIVITY_ACTIONS: readonly AuditAction[] = Object.freeze(
  AUDIT_ACTIONS.filter(
    (action) =>
      /^(project|environment|secret|import|credential|machine|automation_credential)\./.test(
        action,
      ) ||
      action === "system.operation_stuck" ||
      action === "system.drift_detected" ||
      action === "system.environment_provision",
  ),
);

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
