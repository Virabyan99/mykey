// The private operator status view (Run 6.4, P-117, FR-1.95, AC-1.49): one
// line per check of the host's status report and of the probe's state, each
// with its observation time. A check observed more than 180 s ago, or not
// observed at all, is `unknown` — never "ok". Printed by
// `node scripts/host.ts <host> status` over the VPN; the API has no
// diagnostic route. No line holds a secret path, a token or an address.
import type { HostChecks, HostStatus } from "./status.ts";

export interface StatusLine {
  check: string;
  value: string;
  observedAt: string | null;
  state: "ok" | "bad" | "unknown";
}

/** What `GET /v1/state/<host>` of the probe says, reduced to what the view shows. */
export interface ProbeState {
  /** When the Worker last evaluated this host (ms); null before the first evaluation. */
  evaluatedAt: number | null;
  /** When the Worker last received a heartbeat of this host (ms). */
  lastHeartbeatAt: number | null;
  /** The conditions open now. */
  open: string[];
}

/** A check older than this is unknown (P-117). */
export const STATUS_MAX_AGE_MS = 180_000;

const DAY_MS = 86_400_000;

/**
 * The probe's certificate threshold (workers/probe/src/evaluate.ts,
 * certificateThresholdMs; a unit test keeps the two equal): 30 days for a
 * certificate that lives longer than 60 days, a third of its life otherwise.
 */
export function certificateWarningMs(notBefore: string, notAfter: string): number {
  const lifetime = Date.parse(notAfter) - Date.parse(notBefore);
  return lifetime > 60 * DAY_MS ? 30 * DAY_MS : lifetime / 3;
}

type State = StatusLine["state"];
const flag = (value: boolean | null | undefined, goodWhen: boolean): State =>
  value === null || value === undefined ? "unknown" : value === goodWhen ? "ok" : "bad";
const zero = (value: number | null | undefined): State =>
  value === null || value === undefined ? "unknown" : value === 0 ? "ok" : "bad";
const shown = (value: string | number | boolean | null | undefined): string =>
  value === null || value === undefined ? "unknown" : String(value);

function hostLines(host: HostStatus, nowMs: number): StatusLine[] {
  const c: Partial<HostChecks> = host.checks ?? {};
  const containers = Object.values(host.containers);
  const running = containers.filter((container) => container.state === "running").length;
  const lines: [string, string, State][] = [
    ["host", host.host, "ok"],
    ["bootId", host.bootId, "ok"],
    ["time", host.time, "ok"],
    ["clockOffsetMs", String(host.clockOffsetMs), "ok"],
    [
      "clockSynced",
      host.chronyOffsetMs === null
        ? shown(host.clockSynced)
        : `${shown(host.clockSynced)}, ${String(host.chronyOffsetMs)} ms`,
      flag(host.clockSynced, true),
    ],
    ["chronyOffsetMs", shown(host.chronyOffsetMs), host.chronyOffsetMs === null ? "unknown" : "ok"],
    [
      "containers",
      `${String(running)} running, ${String(containers.length - running)} stopped (one-shot jobs stop)`,
      // A one-shot container (pki-init, an ops job) stops by design; one that restarts, died or is paused is bad.
      containers.length === 0
        ? "unknown"
        : containers.some((container) => ["restarting", "dead", "paused"].includes(container.state))
          ? "bad"
          : "ok",
    ],
    ["sealed", shown(host.sealed), flag(host.sealed, false)],
    ["sealType", shown(host.sealType), host.sealType === null ? "unknown" : "ok"],
    ["kmsReachable", shown(host.kmsReachable), flag(host.kmsReachable, true)],
    [
      "pendingRevert",
      host.pendingRevert.length === 0 ? "none" : host.pendingRevert.join(", "),
      host.pendingRevert.length === 0 ? "ok" : "bad",
    ],
    [
      "firewall",
      host.firewall === null
        ? "unknown"
        : `${host.firewall.loaded ? "loaded" : "not loaded"}, ${String(Object.keys(host.firewall.sets).length)} sets`,
      host.firewall === null ? "unknown" : host.firewall.loaded ? "ok" : "bad",
    ],
    [
      "sshListen",
      host.sshListen === null ? "unknown" : `${String(host.sshListen.length)} listeners`,
      host.sshListen === null ? "unknown" : "ok",
    ],
    [
      "gate",
      shown(host.gate),
      host.gate === null ? "unknown" : host.gate === "open" ? "ok" : "bad",
    ],
    ["reviewOpen", shown(host.reviewOpen), zero(host.reviewOpen)],
    ["operationsUnresolved", shown(host.operationsUnresolved), zero(host.operationsUnresolved)],
    [
      "provisioner",
      shown(host.provisioner),
      host.provisioner === null ? "unknown" : host.provisioner === "unhealthy" ? "bad" : "ok",
    ],
    ["checks.sealed", shown(c.sealed), flag(c.sealed, false)],
    ["checks.kmsReachable", shown(c.kmsReachable), flag(c.kmsReachable, true)],
    ["checks.reviewOpen", shown(c.reviewOpen), zero(c.reviewOpen)],
    ["checks.operationsUnresolved", shown(c.operationsUnresolved), zero(c.operationsUnresolved)],
    ["checks.firewallLoaded", shown(c.firewallLoaded), flag(c.firewallLoaded, true)],
    ["checks.diskLow", shown(c.diskLow), flag(c.diskLow, false)],
    ["checks.auditFailing", shown(c.auditFailing), flag(c.auditFailing, false)],
    [
      "checks.captureSince",
      c.captureSince === undefined
        ? "unknown"
        : c.captureSince === null
          ? "idle"
          : `capturing since ${c.captureSince}`,
      c.captureSince === undefined
        ? "unknown"
        : c.captureSince === null || nowMs - Date.parse(c.captureSince) <= 600_000
          ? "ok"
          : "bad",
    ],
    [
      "checks.backup",
      c.backup === null || c.backup === undefined
        ? "unknown"
        : `${c.backup.expected ? "expected" : "not expected"}, newest eligible ${c.backup.newestEligibleCaptureAt ?? "none"}`,
      c.backup === null || c.backup === undefined
        ? "unknown"
        : !c.backup.expected
          ? "ok"
          : c.backup.newestEligibleCaptureAt !== null &&
              nowMs - Date.parse(c.backup.newestEligibleCaptureAt) <= 93_600_000
            ? "ok"
            : "bad",
    ],
    [
      "checks.certificates",
      c.certificates === null || c.certificates === undefined
        ? "unknown"
        : c.certificates.map((cert) => `${cert.name} until ${cert.notAfter}`).join(", "),
      c.certificates === null || c.certificates === undefined
        ? "unknown"
        : c.certificates.some(
              (cert) =>
                Date.parse(cert.notAfter) - nowMs <
                certificateWarningMs(cert.notBefore, cert.notAfter),
            )
          ? "bad"
          : "ok",
    ],
    ["checks.credentialExpiring", shown(c.credentialExpiring), zero(c.credentialExpiring)],
    [
      "checks.unitsFailed",
      c.unitsFailed === null || c.unitsFailed === undefined
        ? "unknown"
        : c.unitsFailed.length === 0
          ? "none"
          : c.unitsFailed.join(", "),
      c.unitsFailed === null || c.unitsFailed === undefined
        ? "unknown"
        : c.unitsFailed.length === 0
          ? "ok"
          : "bad",
    ],
  ];
  const fresh = nowMs - Date.parse(host.time) <= STATUS_MAX_AGE_MS;
  return lines.map(([check, value, state]) => ({
    check,
    value,
    observedAt: host.time,
    state: fresh ? state : "unknown",
  }));
}

function probeLines(probe: ProbeState | null, nowMs: number): StatusLine[] {
  const at = (ms: number | null): string | null =>
    ms === null ? null : new Date(ms).toISOString();
  const fresh = (ms: number | null): boolean => ms !== null && nowMs - ms <= STATUS_MAX_AGE_MS;
  if (probe === null) {
    return ["probe.evaluatedAt", "probe.heartbeat", "probe.open"].map((check) => ({
      check,
      value: "unknown",
      observedAt: null,
      state: "unknown",
    }));
  }
  return [
    {
      check: "probe.evaluatedAt",
      value: at(probe.evaluatedAt) ?? "never",
      observedAt: at(probe.evaluatedAt),
      state: fresh(probe.evaluatedAt) ? "ok" : "unknown",
    },
    {
      check: "probe.heartbeat",
      value: at(probe.lastHeartbeatAt) ?? "never",
      observedAt: at(probe.lastHeartbeatAt),
      state: fresh(probe.lastHeartbeatAt) ? "ok" : "bad",
    },
    {
      check: "probe.open",
      value: probe.open.length === 0 ? "none" : probe.open.join(", "),
      observedAt: at(probe.evaluatedAt),
      state: !fresh(probe.evaluatedAt) ? "unknown" : probe.open.length === 0 ? "ok" : "bad",
    },
  ];
}

export function statusView(
  host: HostStatus,
  probe: ProbeState | null,
  nowMs: number,
): StatusLine[] {
  return [...hostLines(host, nowMs), ...probeLines(probe, nowMs)];
}

/** The view as text: one line per check, `state  check  value  (observed …)`. */
export function formatStatusView(lines: readonly StatusLine[]): string {
  const width = Math.max(...lines.map((line) => line.check.length));
  return lines
    .map(
      (line) =>
        `${line.state.padEnd(7)} ${line.check.padEnd(width)}  ${line.value}${line.observedAt === null ? "" : `  (observed ${line.observedAt})`}`,
    )
    .join("\n");
}
