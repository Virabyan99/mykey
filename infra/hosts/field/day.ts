// Run 9.6 Task A (P-166, FR-1.100, D-72): one field record per calendar day,
// from the host's own facts. Counts and timings only: no name, no id, no
// value, no address. A machine credential appears as a stable label
// (credential-A, B, …) whose mapping to the credential stays on the host
// (labels.json beside the records) and is never pulled.
//
// The sources (field/collect.ts reads them on the host):
//   - the API container's journal lines of the day (its request log, P-42).
//     The probe asks GET /health every minute and every request is logged, so
//     a minute of the day without a /health 200 is a down minute: the API was
//     down, refused, or logged nothing (P-166's "probe outage minutes", read
//     from the host's side);
//   - the audit rows of the day (action, actor kind and id, outcome);
//   - whether the gate was closed at any time of the day;
//   - the newest eligible pair's capture time, and the capacity record.
//
// Run by Node's type stripping (erasable syntax only).

export interface AuditFact {
  action: string;
  actorKind: string;
  actorId: string | null;
  outcome: string;
}

export interface DayInput {
  /** YYYY-MM-DD, UTC. */
  date: string;
  journal: readonly string[];
  audit: readonly AuditFact[];
  gateClosed: boolean;
  newestPairCapturedAt: string | null;
  capacity: { headroomPercent: number } | null;
  /** credential id → label; new credentials are added to it. */
  labels: Map<string, string>;
}

export type Classification = "use" | "blocked" | "outage" | "no activity";

export interface Timing {
  samples: number;
  p50: number | null;
  p95: number | null;
  note?: "too few";
}

export interface DayRecord {
  format: "mykey-field-day/1";
  date: string;
  gateClosed: boolean;
  machineReads: {
    successes: { label: string; count: number }[];
    refusedByStatus: Record<string, number>;
  };
  signIns: { completed: number; failed: number };
  ownerChanges: number;
  timings: Partial<Record<RouteClass, Timing>>;
  healthDownMinutes: number;
  backupPairAgeHours: number | null;
  capacityHeadroomPercent: number | null;
  classification: Classification;
}

export const RECORD_KEYS: readonly (keyof DayRecord)[] = [
  "format",
  "date",
  "gateClosed",
  "machineReads",
  "signIns",
  "ownerChanges",
  "timings",
  "healthDownMinutes",
  "backupPairAgeHours",
  "capacityHeadroomPercent",
  "classification",
];

export type RouteClass = "machine" | "auth" | "read" | "write";

/** Fewer samples than this: the class says "too few", not a percentile. */
export const MIN_SAMPLES = 20;
/** P-166: an outage is more than this many minutes down, or the gate closed. */
export const OUTAGE_MINUTES = 30;
const MINUTES_PER_DAY = 1440;

/** The probe's GET /health lines of a day, one per minute, but for the minutes left out (tests). */
export function healthLines(date: string, without: ReadonlySet<string> = new Set()): string[] {
  const lines: string[] = [];
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
    const hhmm = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    if (without.has(hhmm)) continue;
    lines.push(
      JSON.stringify({
        event: "request",
        time: `${date}T${hhmm}:20.000Z`,
        requestId: "health",
        method: "GET",
        path: "/health",
        status: 200,
        durationMs: 2,
        bodyBytesRead: 0,
        peer: null,
        forwardedFor: null,
        forwardedProto: null,
      }),
    );
  }
  return lines;
}

const READS = new Set(["secret.reveal", "secret.export", "secret.history", "secret.read"]);
const CHANGE_PREFIXES = ["secret.", "project.", "environment.", "credential.", "import."];

function routeClass(path: string, method: string): RouteClass | null {
  if (path.startsWith("/v1/machine/")) return "machine";
  if (path.startsWith("/v1/auth/")) return "auth";
  if (!path.startsWith("/v1/")) return null;
  return method === "GET" || method === "HEAD" ? "read" : "write";
}

/** Nearest-rank percentile of sorted values. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}

export function classifyDay(facts: {
  machineSuccesses: number;
  machineRefusals: number;
  ownerChanges: number;
  healthDownMinutes: number;
  gateClosed: boolean;
}): Classification {
  if (facts.gateClosed || facts.healthDownMinutes > OUTAGE_MINUTES) return "outage";
  if (facts.machineSuccesses > 0 || facts.ownerChanges > 0) return "use";
  if (facts.machineRefusals > 0) return "blocked";
  return "no activity";
}

function labelOf(labels: Map<string, string>, credentialId: string): string {
  const known = labels.get(credentialId);
  if (known !== undefined) return known;
  const index = labels.size;
  const letters =
    index < 26
      ? String.fromCharCode(65 + index)
      : `${String.fromCharCode(65 + Math.floor(index / 26) - 1)}${String.fromCharCode(65 + (index % 26))}`;
  const label = `credential-${letters}`;
  labels.set(credentialId, label);
  return label;
}

export function dayRecord(input: DayInput): DayRecord {
  const durations = new Map<RouteClass, number[]>();
  const refusedByStatus: Record<string, number> = {};
  const upMinutes = new Set<string>();
  for (const line of input.journal) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry.time !== "string" || !entry.time.startsWith(input.date)) continue;
    if (entry.event !== "request") continue;
    const { path, method, status, durationMs } = entry;
    if (typeof path !== "string" || typeof method !== "string") continue;
    if (typeof status !== "number" || typeof durationMs !== "number") continue;
    if (path === "/health" && method === "GET") {
      if (status === 200) upMinutes.add(entry.time.slice(0, 16));
      continue;
    }
    const kind = routeClass(path, method);
    if (kind === null) continue;
    const list = durations.get(kind) ?? [];
    list.push(durationMs);
    durations.set(kind, list);
    if (kind === "machine" && status >= 400) {
      refusedByStatus[String(status)] = (refusedByStatus[String(status)] ?? 0) + 1;
    }
  }

  const successes = new Map<string, number>();
  let completed = 0;
  let failed = 0;
  let ownerChanges = 0;
  for (const row of input.audit) {
    if (
      row.actorKind === "machine" &&
      row.action.startsWith("machine.") &&
      row.outcome === "success" &&
      row.actorId !== null
    ) {
      const label = labelOf(input.labels, row.actorId);
      successes.set(label, (successes.get(label) ?? 0) + 1);
    } else if (row.action === "auth.mfa_complete" && row.outcome === "success") {
      completed += 1;
    } else if (
      (row.action === "auth.sign_in" || row.action === "auth.mfa_complete") &&
      row.outcome !== "success"
    ) {
      failed += 1;
    } else if (
      row.actorKind === "user" &&
      row.outcome === "success" &&
      !READS.has(row.action) &&
      CHANGE_PREFIXES.some((prefix) => row.action.startsWith(prefix))
    ) {
      ownerChanges += 1;
    }
  }

  const timings: Partial<Record<RouteClass, Timing>> = {};
  for (const [kind, values] of durations) {
    const sorted = [...values].sort((a, b) => a - b);
    timings[kind] =
      sorted.length < MIN_SAMPLES
        ? { samples: sorted.length, p50: null, p95: null, note: "too few" }
        : { samples: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
  }

  const dayEnd = Date.parse(`${input.date}T00:00:00Z`) + 86_400_000;
  const captured =
    input.newestPairCapturedAt === null ? NaN : Date.parse(input.newestPairCapturedAt);
  const machineSuccesses = [...successes.values()].reduce((sum, count) => sum + count, 0);
  const machineRefusals = Object.values(refusedByStatus).reduce((sum, count) => sum + count, 0);
  const healthDownMinutes = MINUTES_PER_DAY - upMinutes.size;
  return {
    format: "mykey-field-day/1",
    date: input.date,
    gateClosed: input.gateClosed,
    machineReads: {
      successes: [...successes].map(([label, count]) => ({ label, count })),
      refusedByStatus,
    },
    signIns: { completed, failed },
    ownerChanges,
    timings,
    healthDownMinutes,
    backupPairAgeHours: Number.isNaN(captured)
      ? null
      : Math.round((dayEnd - captured) / 360_000) / 10,
    capacityHeadroomPercent: input.capacity?.headroomPercent ?? null,
    classification: classifyDay({
      machineSuccesses,
      machineRefusals,
      ownerChanges,
      healthDownMinutes,
      gateClosed: input.gateClosed,
    }),
  };
}
