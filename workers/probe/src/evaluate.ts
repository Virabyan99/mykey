// The probe's decision function (Run 2.6, D-22; Run 6.4, P-116, D-50). Pure:
// no I/O, time passed in.
//
// - heartbeat_missing: no heartbeat for longer than the grace (or none ever and
//   the host known for longer than the grace);
// - health_failing: the public probe has failed continuously for the grace;
// - the reported conditions read the last heartbeat. Each reading is bad, good
//   or unknown. **Unknown is not healthy** (M-4): it never opens a condition
//   and never resolves one; an open condition stays open and keeps reminding.
//   A bad reading opens after the condition's grace (the reported grace for
//   states that flap, none for those whose threshold is already a time).
// - checks_unknown: a check of a version 2 heartbeat has been unknown for
//   longer than the reported grace. The old shapes cannot report the new
//   checks, so they never open it.
// - A heartbeat older than the heartbeat grace freezes every reported
//   condition: heartbeat_missing says what is known.
// A condition resolves at the first good reading. An `opened`, `reminder` or
// `resolved` intent is produced on every evaluation until markDelivered has
// recorded it: nothing counts as sent that was not sent.

export type Condition =
  | "heartbeat_missing"
  | "health_failing"
  | "openbao_sealed"
  | "kms_unreachable"
  | "review_open"
  | "operations_unresolved"
  | "disk_low"
  | "audit_failing"
  | "capture_frozen"
  | "backup_stale"
  | "certificate_expiring"
  | "credential_expiring"
  | "firewall_unloaded"
  | "unit_failed"
  | "checks_unknown";

type Reported = Exclude<Condition, "heartbeat_missing" | "health_failing" | "checks_unknown">;

export const CONDITIONS: readonly Condition[] = [
  "heartbeat_missing",
  "health_failing",
  "openbao_sealed",
  "kms_unreachable",
  "review_open",
  "operations_unresolved",
  "disk_low",
  "audit_failing",
  "capture_frozen",
  "backup_stale",
  "certificate_expiring",
  "credential_expiring",
  "firewall_unloaded",
  "unit_failed",
  "checks_unknown",
];

/** The heartbeat of Sessions 2–4: three key sets, still accepted. */
export interface Heartbeat {
  bootId: string;
  sealed: boolean | null;
  kmsReachable: boolean | null;
  /** Scopes in needs_review (Run 3.8); null when the host could not count them. Absent from older hosts. */
  reviewOpen?: number | null;
  /** Unresolved secret operations (Run 4.5); null when unread. Absent from older hosts. */
  operationsUnresolved?: number | null;
}

export interface Certificate {
  name: string;
  notBefore: string;
  notAfter: string;
}

/** Version 2's checks. `null` is unknown; `captureSince` absent is unknown, `null` is idle. */
export interface Checks {
  sealed: boolean | null;
  kmsReachable: boolean | null;
  reviewOpen: number | null;
  operationsUnresolved: number | null;
  firewallLoaded: boolean | null;
  diskLow: boolean | null;
  auditFailing: boolean | null;
  captureSince?: string | null;
  backup: { expected: boolean; newestEligibleCaptureAt: string | null } | null;
  certificates: Certificate[] | null;
  credentialExpiring: number | null;
  unitsFailed: string[] | null;
}

export interface HeartbeatV2 {
  v: 2;
  bootId: string;
  observedAt: string;
  checks: Checks;
}

type CheckName = keyof Checks;
const CHECK_NAMES: readonly CheckName[] = [
  "sealed",
  "kmsReachable",
  "reviewOpen",
  "operationsUnresolved",
  "firewallLoaded",
  "diskLow",
  "auditFailing",
  "captureSince",
  "backup",
  "certificates",
  "credentialExpiring",
  "unitsFailed",
];

export interface OpenCondition {
  openedAt: number;
  sinceMs: number;
  lastAlertAt: number | null;
}

export interface HostState {
  host: string;
  /** When the Worker first had this host on its list; used while no heartbeat ever came. */
  knownSince: number;
  lastHeartbeatAt: number | null;
  lastHeartbeat: Heartbeat | HeartbeatV2 | null;
  failingSince: number | null;
  /** Since when each reported condition has read bad without a good reading between. */
  badSince: Partial<Record<Reported, number>>;
  /** Since when each check of a version 2 heartbeat has been unknown. */
  unknownSince: Partial<Record<CheckName, number>>;
  open: Partial<Record<Condition, OpenCondition>>;
  /** Resolved conditions whose message has not been delivered yet: the start of their bad period. */
  pendingResolved: Partial<Record<Condition, number>>;
}

export interface ProbeLimits {
  heartbeatGraceSeconds: number;
  healthGraceSeconds: number;
  reportedGraceSeconds: number;
  reminderSeconds: number;
  /** LIMITS.backup.freezeAlertSeconds: a capture running longer than this is frozen. */
  captureFreezeSeconds: number;
  /** LIMITS.backup.maxAgeAlertSeconds: the newest eligible capture may be this old. */
  backupMaxAgeSeconds: number;
}

export interface AlertIntent {
  host: string;
  condition: Condition;
  kind: "opened" | "reminder" | "resolved";
  /** Start of the bad period. */
  sinceMs: number;
}

/** Reported conditions that open only after the reported grace (states that can flap). */
const WITH_GRACE: ReadonlySet<Condition> = new Set([
  "openbao_sealed",
  "kms_unreachable",
  "disk_low",
  "audit_failing",
  "firewall_unloaded",
  "unit_failed",
]);

/** Conditions that a host not in service never raises (it is not serving or backing up yet). */
const SILENT_OUT_OF_SERVICE: ReadonlySet<Condition> = new Set(["health_failing", "backup_stale"]);

const DAY_MS = 86_400_000;

export function initialState(host: string, nowMs: number): HostState {
  return {
    host,
    knownSince: nowMs,
    lastHeartbeatAt: null,
    lastHeartbeat: null,
    failingSince: null,
    badSince: {},
    unknownSince: {},
    open: {},
    pendingResolved: {},
  };
}

// ---- reading a heartbeat body ----

const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;
const CERTIFICATE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UNIT_NAME = /^[A-Za-z0-9@._:-]{1,128}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const flag = (v: unknown): v is boolean | null => v === null || typeof v === "boolean";
const count = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1_000_000);
const time = (v: unknown): v is string =>
  typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v));
const keysAre = (record: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(record).sort().join(",") === [...keys].sort().join(",");

function readV1(record: Record<string, unknown>): Heartbeat | null {
  // Run 3.8 adds reviewOpen and Run 4.5 operationsUnresolved; a host that has
  // not been updated yet still sends the older fields.
  const keys = Object.keys(record).sort().join(",");
  if (
    keys !== "bootId,kmsReachable,sealed" &&
    keys !== "bootId,kmsReachable,reviewOpen,sealed" &&
    keys !== "bootId,kmsReachable,operationsUnresolved,reviewOpen,sealed"
  ) {
    return null;
  }
  if (typeof record.bootId !== "string" || record.bootId.length > 64) return null;
  if (!flag(record.sealed) || !flag(record.kmsReachable)) return null;
  const review = record.reviewOpen;
  const unresolved = record.operationsUnresolved;
  if (
    (review !== undefined && !count(review)) ||
    (unresolved !== undefined && !count(unresolved))
  ) {
    return null;
  }
  return {
    bootId: record.bootId,
    sealed: record.sealed,
    kmsReachable: record.kmsReachable,
    ...(review === undefined ? {} : { reviewOpen: review }),
    ...(unresolved === undefined ? {} : { operationsUnresolved: unresolved }),
  };
}

function readChecks(value: unknown): Checks | null {
  if (!isRecord(value)) return null;
  const required = CHECK_NAMES.filter((name) => name !== "captureSince");
  const keys = "captureSince" in value ? CHECK_NAMES : required;
  if (!keysAre(value, keys)) return null;
  const c = value;
  for (const name of ["sealed", "kmsReachable", "firewallLoaded", "diskLow", "auditFailing"]) {
    if (!flag(c[name])) return null;
  }
  for (const name of ["reviewOpen", "operationsUnresolved", "credentialExpiring"]) {
    if (!count(c[name])) return null;
  }
  if ("captureSince" in c && c.captureSince !== null && !time(c.captureSince)) return null;
  const backup = c.backup;
  if (backup !== null) {
    if (!isRecord(backup) || !keysAre(backup, ["expected", "newestEligibleCaptureAt"])) return null;
    if (typeof backup.expected !== "boolean") return null;
    if (backup.newestEligibleCaptureAt !== null && !time(backup.newestEligibleCaptureAt))
      return null;
  }
  const certificates = c.certificates;
  if (certificates !== null) {
    if (!Array.isArray(certificates) || certificates.length > 32) return null;
    for (const entry of certificates as unknown[]) {
      if (!isRecord(entry) || !keysAre(entry, ["name", "notBefore", "notAfter"])) return null;
      if (typeof entry.name !== "string" || !CERTIFICATE_NAME.test(entry.name)) return null;
      if (!time(entry.notBefore) || !time(entry.notAfter)) return null;
    }
  }
  const units = c.unitsFailed;
  if (units !== null) {
    if (!Array.isArray(units) || units.length > 32) return null;
    for (const unit of units as unknown[]) {
      if (typeof unit !== "string" || !UNIT_NAME.test(unit)) return null;
    }
  }
  return value as unknown as Checks;
}

/** The three old key sets, or version 2, strictly; anything else is null. */
export function readHeartbeat(body: unknown): Heartbeat | HeartbeatV2 | null {
  if (!isRecord(body)) return null;
  if (!("v" in body)) return readV1(body);
  if (!keysAre(body, ["v", "bootId", "observedAt", "checks"]) || body.v !== 2) return null;
  if (typeof body.bootId !== "string" || body.bootId.length > 64) return null;
  if (!time(body.observedAt)) return null;
  const checks = readChecks(body.checks);
  if (checks === null) return null;
  return { v: 2, bootId: body.bootId, observedAt: body.observedAt, checks };
}

const isV2 = (beat: Heartbeat | HeartbeatV2): beat is HeartbeatV2 => "v" in beat;

// ---- readings ----

/**
 * P-116: certificate_expiring opens 30 days before expiry for a certificate
 * that lives longer than 60 days, and at a third of its lifetime otherwise —
 * a console KMS certificate lives 30 days and would be in alarm from its
 * first hour.
 */
export function certificateThresholdMs(notBefore: string, notAfter: string): number {
  const lifetime = Date.parse(notAfter) - Date.parse(notBefore);
  return lifetime > 60 * DAY_MS ? 30 * DAY_MS : lifetime / 3;
}

type Reading = "bad" | "good" | "unknown";
const fromFlag = (value: boolean | null | undefined, badWhen: boolean): Reading =>
  value === null || value === undefined ? "unknown" : value === badWhen ? "bad" : "good";
const fromCount = (value: number | null | undefined): Reading =>
  value === null || value === undefined ? "unknown" : value > 0 ? "bad" : "good";

/** One condition's reading of a version 2 heartbeat at `nowMs`. */
export function reading(
  condition: Condition,
  beat: HeartbeatV2,
  nowMs: number,
  limits: ProbeLimits,
): Reading {
  const c = beat.checks;
  switch (condition) {
    case "openbao_sealed":
      return fromFlag(c.sealed, true);
    case "kms_unreachable":
      return fromFlag(c.kmsReachable, false);
    case "review_open":
      return fromCount(c.reviewOpen);
    case "operations_unresolved":
      return fromCount(c.operationsUnresolved);
    case "disk_low":
      return fromFlag(c.diskLow, true);
    case "audit_failing":
      return fromFlag(c.auditFailing, true);
    case "firewall_unloaded":
      return fromFlag(c.firewallLoaded, false);
    case "credential_expiring":
      return fromCount(c.credentialExpiring);
    case "unit_failed":
      return c.unitsFailed === null ? "unknown" : c.unitsFailed.length > 0 ? "bad" : "good";
    case "capture_frozen":
      if (c.captureSince === undefined) return "unknown";
      if (c.captureSince === null) return "good";
      return nowMs - Date.parse(c.captureSince) > limits.captureFreezeSeconds * 1000
        ? "bad"
        : "good";
    case "backup_stale": {
      if (c.backup === null) return "unknown";
      if (!c.backup.expected) return "good";
      const newest = c.backup.newestEligibleCaptureAt;
      if (newest === null) return "bad";
      return nowMs - Date.parse(newest) > limits.backupMaxAgeSeconds * 1000 ? "bad" : "good";
    }
    case "certificate_expiring":
      if (c.certificates === null) return "unknown";
      return c.certificates.some(
        (cert) =>
          Date.parse(cert.notAfter) - nowMs < certificateThresholdMs(cert.notBefore, cert.notAfter),
      )
        ? "bad"
        : "good";
    case "heartbeat_missing":
    case "health_failing":
    case "checks_unknown":
      // Not read from a heartbeat's checks.
      return "unknown";
  }
}

/** The old shapes report four conditions; the others are unknown to them. */
function readingV1(condition: Reported, beat: Heartbeat): Reading {
  switch (condition) {
    case "openbao_sealed":
      return fromFlag(beat.sealed, true);
    case "kms_unreachable":
      return fromFlag(beat.kmsReachable, false);
    case "review_open":
      return fromCount(beat.reviewOpen);
    case "operations_unresolved":
      return fromCount(beat.operationsUnresolved);
    default:
      return "unknown";
  }
}

const isReported = (condition: Condition): condition is Reported =>
  condition !== "heartbeat_missing" &&
  condition !== "health_failing" &&
  condition !== "checks_unknown";

/** A heartbeat as the Worker received it, stamped with the Worker's clock. */
export function recordHeartbeat(
  state: HostState,
  nowMs: number,
  beat: Heartbeat | HeartbeatV2,
): HostState {
  return { ...state, lastHeartbeatAt: nowMs, lastHeartbeat: beat };
}

/** Whether a condition holds now (with the start of its bad period), does not, or cannot be told. */
type Verdict = { kind: "bad"; since: number } | { kind: "good" } | { kind: "unknown" };

function without<K extends string, V>(
  record: Partial<Record<K, V>>,
  key: K,
): Partial<Record<K, V>> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key)) as Partial<
    Record<K, V>
  >;
}

/**
 * `inService: false` (a host that is deliberately not serving yet, such as a
 * production host with its gate closed): health_failing and backup_stale
 * never open, and an open one is closed without a message, because
 * "resolved" would claim the host is healthy. Every other condition is
 * evaluated as usual.
 */
export function evaluate(
  nowMs: number,
  state: HostState,
  probeOk: boolean,
  limits: ProbeLimits,
  opts: { inService?: boolean } = {},
): { next: HostState; alerts: AlertIntent[] } {
  const next: HostState = {
    ...state,
    failingSince: probeOk ? null : (state.failingSince ?? nowMs),
    badSince: { ...state.badSince },
    unknownSince: { ...state.unknownSince },
    open: { ...state.open },
    pendingResolved: { ...state.pendingResolved },
  };
  const beat = state.lastHeartbeat;
  const beatAt = state.lastHeartbeatAt;
  const fresh =
    beat !== null && beatAt !== null && nowMs - beatAt <= limits.heartbeatGraceSeconds * 1000;

  // The unknown checks of a fresh version 2 heartbeat.
  if (fresh && isV2(beat)) {
    for (const name of CHECK_NAMES) {
      const value = beat.checks[name];
      const unknown = value === null ? name !== "captureSince" : value === undefined;
      if (unknown) next.unknownSince[name] = next.unknownSince[name] ?? beatAt;
      else next.unknownSince = without(next.unknownSince, name);
    }
  } else if (fresh) {
    next.unknownSince = {};
  }

  const verdict = (condition: Condition): Verdict => {
    switch (condition) {
      case "heartbeat_missing": {
        const since = beatAt ?? state.knownSince;
        return nowMs - since > limits.heartbeatGraceSeconds * 1000
          ? { kind: "bad", since }
          : { kind: "good" };
      }
      case "health_failing":
        return next.failingSince !== null &&
          nowMs - next.failingSince >= limits.healthGraceSeconds * 1000
          ? { kind: "bad", since: next.failingSince }
          : { kind: "good" };
      case "checks_unknown": {
        if (!fresh) return { kind: "unknown" };
        const starts = Object.values(next.unknownSince);
        if (starts.length === 0) return { kind: "good" };
        const since = Math.min(...starts);
        return nowMs - since > limits.reportedGraceSeconds * 1000
          ? { kind: "bad", since }
          : { kind: "unknown" };
      }
      default: {
        if (!fresh) return { kind: "unknown" };
        const read = isV2(beat)
          ? reading(condition, beat, nowMs, limits)
          : readingV1(condition, beat);
        if (read === "good") {
          next.badSince = without(next.badSince, condition);
          return { kind: "good" };
        }
        if (read === "unknown") return { kind: "unknown" };
        const since = next.badSince[condition] ?? beatAt;
        next.badSince[condition] = since;
        const grace = WITH_GRACE.has(condition) ? limits.reportedGraceSeconds * 1000 : 0;
        return nowMs - since >= grace ? { kind: "bad", since } : { kind: "unknown" };
      }
    }
  };

  const alerts: AlertIntent[] = [];
  for (const condition of CONDITIONS) {
    if (opts.inService === false && SILENT_OUT_OF_SERVICE.has(condition)) {
      next.open = without(next.open, condition);
      next.pendingResolved = without(next.pendingResolved, condition);
      if (isReported(condition)) next.badSince = without(next.badSince, condition);
      continue;
    }
    const now = verdict(condition);
    const open = next.open[condition];
    if (now.kind === "bad") {
      next.pendingResolved = without(next.pendingResolved, condition);
      if (open === undefined) {
        next.open[condition] = { openedAt: nowMs, sinceMs: now.since, lastAlertAt: null };
        alerts.push({ host: state.host, condition, kind: "opened", sinceMs: now.since });
        continue;
      }
    }
    if (now.kind === "good" && open !== undefined) {
      next.open = without(next.open, condition);
      if (open.lastAlertAt !== null) next.pendingResolved[condition] = open.sinceMs;
    }
    const stillOpen = next.open[condition];
    if (stillOpen !== undefined) {
      // Bad or unknown: an open condition stays open and keeps its messages.
      if (stillOpen.lastAlertAt === null) {
        alerts.push({ host: state.host, condition, kind: "opened", sinceMs: stillOpen.sinceMs });
      } else if (nowMs - stillOpen.lastAlertAt >= limits.reminderSeconds * 1000) {
        alerts.push({ host: state.host, condition, kind: "reminder", sinceMs: stillOpen.sinceMs });
      }
      continue;
    }
    const pending = next.pendingResolved[condition];
    if (pending !== undefined) {
      alerts.push({ host: state.host, condition, kind: "resolved", sinceMs: pending });
    }
  }
  return { next, alerts };
}

export function markDelivered(state: HostState, alert: AlertIntent, nowMs: number): HostState {
  if (alert.kind === "resolved") {
    return { ...state, pendingResolved: without(state.pendingResolved, alert.condition) };
  }
  const open = state.open[alert.condition];
  if (open === undefined) return state;
  return { ...state, open: { ...state.open, [alert.condition]: { ...open, lastAlertAt: nowMs } } };
}
