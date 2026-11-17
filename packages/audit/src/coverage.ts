// The audit coverage table (Run 6.1, P-105, FR-1.56). Every route of the
// route table, every path the auth module serves, every operator command, and
// every timer of the API and the provisioner has one entry: the actions it
// writes, or the reason it writes none. `tests/unit/audit/coverage.test.ts`
// fails for a route, path, command or timer without an entry and for an
// action that no entry names; `docs/runbooks/audit.md` renders this table.
//
// Reads of metadata (lists, history, operation status, the reference, the
// activity signal) write nothing: FR-1.56 does not list them, and a row per
// list request would bury the trail. A request refused before a principal is
// known (401, malformed, origin, quarantined, rate limits) is a log line
// (FR-1.81); only `auth.throttled` and `access.denied` are rows.
import type { AuditAction } from "./events.ts";

export type Coverage = { readonly actions: readonly AuditAction[] } | { readonly none: string };

const READ = "a read of metadata; FR-1.56 does not list it and a row per read buries the trail";
const PUBLIC = "public and unauthenticated; refusals here are log lines only (FR-1.81)";
const REFERENCE = "serves the API reference; documentation, not a product action";
const DENIED = "access.denied" as const;

const routes: Record<string, Coverage> = {
  "health.get": { none: PUBLIC },
  "version.get": { none: PUBLIC },
  "organizations.list": { none: READ },
  "projects.list": { none: READ },
  "projects.create": { actions: ["project.create", DENIED] },
  "projects.rename": { actions: ["project.rename", DENIED] },
  "projects.archive": { actions: ["project.archive", DENIED] },
  "projects.reactivate": { actions: ["project.reactivate", DENIED] },
  "environments.list": { none: READ },
  "environments.create": { actions: ["environment.create", DENIED] },
  "environments.rename": { actions: ["environment.rename", DENIED] },
  "environments.archive": { actions: ["environment.archive", DENIED] },
  "environments.reactivate": { actions: ["environment.reactivate", DENIED] },
  "secrets.list": { actions: [DENIED] },
  "secrets.history": { actions: [DENIED] },
  "secrets.reveal": { actions: ["secret.reveal", "system.drift_detected", DENIED] },
  "secrets.create": { actions: ["secret.create", "system.drift_detected", DENIED] },
  "secrets.update": { actions: ["secret.update", "system.drift_detected", DENIED] },
  "secrets.delete": { actions: ["secret.delete", "system.drift_detected", DENIED] },
  "secrets.undelete": { actions: ["secret.undelete", "system.drift_detected", DENIED] },
  "secrets.restore": { actions: ["secret.restore", "system.drift_detected", DENIED] },
  "import.preview": { actions: ["import.preview", DENIED] },
  "import.apply": { actions: ["import.apply", "secret.create", "secret.update", DENIED] },
  "import.resume": { actions: ["import.resume", "secret.create", "secret.update", DENIED] },
  "export.create": { actions: ["secret.export", "system.drift_detected", DENIED] },
  "credentials.list": { actions: [DENIED] },
  "credentials.issue": { actions: ["credential.issue", "system.drift_detected", DENIED] },
  "credentials.revoke": { actions: ["credential.revoke", DENIED] },
  "operations.get": { actions: [DENIED] },
  "operations.list": { actions: [DENIED] },
  "audit.list": { actions: [DENIED] },
  "activity.list": { actions: [DENIED] },
  "overview.get": { actions: [DENIED] },
  "credentials.summary": { actions: [DENIED] },
  "metrics.get": { actions: [DENIED] },
  "session.activity": { none: "the activity signal of a session; it changes no authority" },
  "auth.reset.complete": {
    actions: ["auth.reset_complete", "auth.reset_failed", "auth.throttled"],
  },
  "reference.get": { none: REFERENCE },
  "openapi.get": { none: REFERENCE },
  "machine.keys": { actions: ["machine.keys", "system.drift_detected", DENIED] },
  "machine.resolve": { actions: ["machine.resolve", "system.drift_detected", DENIED] },
};

const auth: Record<string, Coverage> = {
  "POST /v1/auth/sign-in/email": { actions: ["auth.sign_in", "auth.throttled"] },
  "POST /v1/auth/sign-out": { actions: ["auth.sign_out"] },
  "GET /v1/auth/get-session": { none: "reads the caller's own session; it changes nothing" },
  "POST /v1/auth/revoke-sessions": { actions: ["auth.session_revoke"] },
  "POST /v1/auth/change-password": { actions: ["auth.password_change", "auth.throttled"] },
  "GET /v1/auth/sessions": { none: "lists the caller's own sessions; it changes nothing" },
  "POST /v1/auth/sessions/revoke": { actions: ["auth.session_revoke"] },
  "POST /v1/auth/totp/enroll": { actions: ["auth.totp_enroll", "auth.throttled"] },
  "POST /v1/auth/totp/activate": { actions: ["auth.totp_activate", "auth.throttled"] },
  "POST /v1/auth/totp/verify": { actions: ["auth.mfa_complete", "auth.throttled"] },
  "POST /v1/auth/totp/step-up": { actions: ["auth.step_up", "auth.throttled"] },
  "POST /v1/auth/recovery/verify": { actions: ["auth.mfa_complete", "auth.throttled"] },
  "POST /v1/auth/recovery/regenerate": { actions: ["auth.recovery_regenerate", "auth.throttled"] },
};

/**
 * Operator commands: the files of `apps/ops/src/commands`, and the host
 * tooling of `scripts/host.ts` that writes audit (named `host <command>`).
 * An entry whose writer arrives in a later run names that run.
 */
const ops: Record<string, Coverage> = {
  "bootstrap-owner": { actions: ["operator.bootstrap"] },
  "auth-cleanup": { actions: ["operator.auth_cleanup"] },
  "reset-account": { actions: ["operator.reset_initiate"] },
  "provision-organization": { actions: ["operator.organization_provision"] },
  "verify-organization": {
    none: "compares the organization with OpenBao and prints it; reads only",
  },
  "operations-expire": { actions: ["operator.operations_expire"] },
  operations: { none: "lists an organization's unresolved operations; reads only" },
  "reconcile-operation": { actions: ["operator.reconcile_operation"] },
  "reconcile-environment": { actions: ["operator.reconcile_environment"] },
  "reconcile-credentials": { actions: ["operator.reconcile_credentials"] },
  // Run 6.2 (P-112).
  "audit-archive": { actions: ["system.audit_archive", "system.audit_purge"] },
  // Run 6.5 (P-120).
  capture: { actions: ["system.backup_capture", "system.backup_invalidated"] },
  pair: {
    actions: ["system.backup_eligible", "system.backup_invalidated", "system.backup_cleanup"],
  },
  // Run 6.7 (P-124).
  "restore-invalidate": { actions: ["operator.restore_begin", "operator.restore_invalidate"] },
  "restore-verify": { actions: ["operator.restore_verify"] },
  // Run 6.9 (P-129): the API's PostgreSQL sweeps, run once by the host timer.
  sweep: { actions: ["system.operation_stuck"] },
  // The step functions around them: their audit is restore-invalidate's and restore-verify's.
  restore: { none: "drives restore-invalidate; audits through it" },
  "verify-journey": { none: "HTTP requests to the listener; each is audited by its route" },
  // Run 6.7 / 6.9 (P-122, P-127): host tooling.
  "host gate": { actions: ["operator.gate_open", "operator.gate_close"] },
  "host deploy": { actions: ["operator.deploy"] },
};

/** `<app>/<file>` of each timer of the API and the provisioner. */
const timers: Record<string, Coverage> = {
  "api/operation-sweep": {
    actions: ["system.operation_stuck", "secret.create", "project.archive", "environment.archive"],
  },
  "api/outbox-dispatcher": { none: "hands committed jobs to the queue; the job audits its effect" },
  "api/throttle-sweep": {
    none: "removes expired sessions and old rate counters; neither changes authority",
  },
  "api/health": { none: "a deadline on one health probe; not a recurring job" },
  "provisioner/worker": {
    actions: ["system.environment_provision", "system.drift_detected"],
  },
};

export const AUDIT_COVERAGE: {
  readonly routes: Readonly<Record<string, Coverage>>;
  readonly auth: Readonly<Record<string, Coverage>>;
  readonly ops: Readonly<Record<string, Coverage>>;
  readonly timers: Readonly<Record<string, Coverage>>;
} = Object.freeze({ routes, auth, ops, timers });

const SECTIONS = [
  ["routes", "Routes of the route table"],
  ["auth", "Paths of the auth module"],
  ["ops", "Operator commands and host tooling"],
  ["timers", "Timers of the API and the provisioner"],
] as const;

/**
 * The coverage table as the Markdown list `docs/runbooks/audit.md` holds
 * between its coverage markers (written by `pnpm run audit:coverage`).
 */
export function renderCoverage(): string {
  const lines: string[] = [];
  for (const [key, title] of SECTIONS) {
    lines.push(`### ${title}`, "");
    for (const [id, entry] of Object.entries(AUDIT_COVERAGE[key])) {
      const what =
        "actions" in entry
          ? entry.actions.map((action) => `\`${action}\``).join(", ")
          : `nothing — ${entry.none}`;
      lines.push(`- \`${id}\`: ${what}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
