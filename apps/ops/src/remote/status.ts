// The host status report (infra/hosts/checks/status.sh). Moved from
// tests/harness/staging.ts in Run 3.2 (M17).
import { REMOTE, type HostEntry } from "./hosts.ts";
import { expectSuccess, sshExec } from "./ssh.ts";

// -------------------------------------------------------------------- status

export interface HostStatus {
  host: string;
  bootId: string;
  time: string;
  clockOffsetMs: number;
  containers: Record<string, { state: string; pid: number; startedAt: string; imageId: string }>;
  sealed: boolean | null;
  sealType: string | null;
  kmsReachable: boolean | null;
  pendingRevert: string[];
  /**
   * chrony's own measurement of the system clock offset; null while
   * unsynchronised or not reported. This is the number to assert on:
   * `clockOffsetMs` compares against the workstation clock and includes about
   * half of the SSH connection set-up time (2 to 3 s observed in Run 2.5).
   */
  chronyOffsetMs: number | null;
  clockSynced: boolean | null;
  /** Whether table `inet mykey` is loaded and how many addresses each set holds; null when not reported. */
  firewall: { loaded: boolean; sets: Record<string, number> } | null;
  /** Local addresses with a listener on TCP 22; null when not reported. */
  sshListen: string[] | null;
  /** The service gate record as the host reads it (Run 3.1); null when not reported. */
  gate: "open" | "closed" | "absent" | "invalid" | null;
  /** Organizations, projects and environments in needs_review (Run 3.8); null when unread. */
  reviewOpen: number | null;
  /** Uncertain or stale secret operations over all organizations (Run 4.5); null when unread. */
  operationsUnresolved: number | null;
  /** The provisioner container's health (Run 3.8); null when not reported. */
  provisioner: "healthy" | "unhealthy" | "absent" | null;
  /** Run 6.4 (P-116): the checks the heartbeat sends (version 2); null when not reported. */
  checks: HostChecks | null;
}

/** The checks of heartbeat version 2 (workers/probe Checks): null is unknown; captureSince absent is unknown, null idle. */
export interface HostChecks {
  sealed: boolean | null;
  kmsReachable: boolean | null;
  reviewOpen: number | null;
  operationsUnresolved: number | null;
  firewallLoaded: boolean | null;
  diskLow: boolean | null;
  auditFailing: boolean | null;
  captureSince?: string | null;
  backup: { expected: boolean; newestEligibleCaptureAt: string | null } | null;
  certificates: { name: string; notBefore: string; notAfter: string }[] | null;
  credentialExpiring: number | null;
  unitsFailed: string[] | null;
}

const isoOrNull = (value: unknown): string | null =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;

function parseChecks(value: unknown): HostChecks | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  const backup =
    typeof c.backup === "object" && c.backup !== null
      ? (c.backup as Record<string, unknown>)
      : null;
  return {
    sealed: nullableBoolean(c.sealed),
    kmsReachable: nullableBoolean(c.kmsReachable),
    reviewOpen: countOf(c.reviewOpen),
    operationsUnresolved: countOf(c.operationsUnresolved),
    firewallLoaded: nullableBoolean(c.firewallLoaded),
    diskLow: nullableBoolean(c.diskLow),
    auditFailing: nullableBoolean(c.auditFailing),
    ...("captureSince" in c ? { captureSince: isoOrNull(c.captureSince) } : {}),
    backup:
      backup === null || typeof backup.expected !== "boolean"
        ? null
        : {
            expected: backup.expected,
            newestEligibleCaptureAt: isoOrNull(backup.newestEligibleCaptureAt),
          },
    certificates: Array.isArray(c.certificates)
      ? c.certificates.flatMap((entry: unknown) => {
          const cert = entry as Record<string, unknown>;
          const notBefore = isoOrNull(cert.notBefore);
          const notAfter = isoOrNull(cert.notAfter);
          return typeof cert.name === "string" && notBefore !== null && notAfter !== null
            ? [{ name: cert.name, notBefore, notAfter }]
            : [];
        })
      : null,
    credentialExpiring: countOf(c.credentialExpiring),
    unitsFailed: Array.isArray(c.unitsFailed) ? c.unitsFailed.map(String) : null,
  };
}

/** The remote check; prints one JSON object (everything but `clockOffsetMs`). */
export const STATUS_COMMAND = `${REMOTE.hostsDir}/checks/status.sh`;

const nullableBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const countOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/**
 * Parses the output of checks/status.sh. `clockOffsetMs` is the host clock
 * minus the workstation clock at the middle of the request. A missing
 * reading stays `null` (rule 11: unknown is said as unknown).
 */
export function parseHostStatus(text: string, sentAt: number, receivedAt: number): HostStatus {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const str = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string" || value === "")
      throw new Error(`status.sh: field ${key} is missing`);
    return value;
  };
  const time = str("time");
  const hostTime = Date.parse(time);
  if (Number.isNaN(hostTime)) throw new Error("status.sh: field time is malformed");
  const containers: HostStatus["containers"] = {};
  const rawContainers = (raw.containers ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, container] of Object.entries(rawContainers)) {
    containers[name] = {
      state: String(container.state),
      pid: Number(container.pid),
      startedAt: String(container.startedAt),
      imageId: String(container.imageId),
    };
  }
  const pending = Array.isArray(raw.pendingRevert) ? raw.pendingRevert.map(String) : [];
  let firewall: HostStatus["firewall"] = null;
  if (typeof raw.firewall === "object" && raw.firewall !== null) {
    const report = raw.firewall as { loaded?: unknown; sets?: unknown };
    const sets: Record<string, number> = {};
    for (const [name, count] of Object.entries((report.sets ?? {}) as Record<string, unknown>)) {
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        throw new Error(`status.sh: firewall set ${name} has no count`);
      }
      sets[name] = count;
    }
    firewall = { loaded: report.loaded === true, sets };
  }
  return {
    host: str("host"),
    bootId: str("bootId"),
    time,
    clockOffsetMs: Math.round(hostTime - (sentAt + receivedAt) / 2),
    containers,
    sealed: nullableBoolean(raw.sealed),
    sealType: typeof raw.sealType === "string" ? raw.sealType : null,
    kmsReachable: nullableBoolean(raw.kmsReachable),
    pendingRevert: pending,
    chronyOffsetMs: typeof raw.chronyOffsetMs === "number" ? raw.chronyOffsetMs : null,
    clockSynced: nullableBoolean(raw.clockSynced),
    firewall,
    sshListen: Array.isArray(raw.sshListen) ? raw.sshListen.map(String) : null,
    gate:
      raw.gate === "open" ||
      raw.gate === "closed" ||
      raw.gate === "absent" ||
      raw.gate === "invalid"
        ? raw.gate
        : null,
    reviewOpen: countOf(raw.reviewOpen),
    operationsUnresolved: countOf(raw.operationsUnresolved),
    provisioner:
      raw.provisioner === "healthy" ||
      raw.provisioner === "unhealthy" ||
      raw.provisioner === "absent"
        ? raw.provisioner
        : null,
    checks: parseChecks(raw.checks),
  };
}

export async function hostStatus(
  host: HostEntry,
  address: "vpn" | "public" = "vpn",
): Promise<HostStatus> {
  const sentAt = Date.now();
  const result = await sshExec(host, STATUS_COMMAND, { sudo: true, address, timeoutMs: 60_000 });
  const receivedAt = Date.now();
  expectSuccess(result, `status of ${host.name}`);
  return parseHostStatus(result.stdout, sentAt, receivedAt);
}
