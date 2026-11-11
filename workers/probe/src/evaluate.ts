// The probe's decision function (Run 2.6, D-22). Pure: no I/O, time passed in.
//
// - heartbeat_missing: no heartbeat for longer than the grace (or none ever and
//   the host known for longer than the grace);
// - health_failing: the public probe has failed continuously for the grace;
// - openbao_sealed / kms_unreachable: the heartbeats have reported it
//   continuously for the grace; `null` never opens them.
// A condition resolves at the first good observation. An `opened` or
// `reminder` intent is produced on every evaluation until markDelivered has
// recorded it: nothing counts as sent that was not sent.

export type Condition =
  "heartbeat_missing" | "health_failing" | "openbao_sealed" | "kms_unreachable";
type Reported = "openbao_sealed" | "kms_unreachable";

export interface Heartbeat {
  bootId: string;
  sealed: boolean | null;
  kmsReachable: boolean | null;
}

export interface HostState {
  host: string;
  /** When the Worker first had this host on its list; used while no heartbeat ever came. */
  knownSince: number;
  lastHeartbeatAt: number | null;
  lastHeartbeat: Heartbeat | null;
  failingSince: number | null;
  reportedSince: Partial<Record<Reported, number>>;
  open: Partial<
    Record<Condition, { openedAt: number; sinceMs: number; lastAlertAt: number | null }>
  >;
}

export interface ProbeLimits {
  heartbeatGraceSeconds: number;
  healthGraceSeconds: number;
  reportedGraceSeconds: number;
  reminderSeconds: number;
}

export interface AlertIntent {
  host: string;
  condition: Condition;
  kind: "opened" | "reminder" | "resolved";
  /** Start of the bad period. */
  sinceMs: number;
}

const CONDITIONS: readonly Condition[] = [
  "heartbeat_missing",
  "health_failing",
  "openbao_sealed",
  "kms_unreachable",
];

export function initialState(host: string, nowMs: number): HostState {
  return {
    host,
    knownSince: nowMs,
    lastHeartbeatAt: null,
    lastHeartbeat: null,
    failingSince: null,
    reportedSince: {},
    open: {},
  };
}

/** A heartbeat as the Worker received it, stamped with the Worker's clock. */
export function recordHeartbeat(state: HostState, nowMs: number, beat: Heartbeat): HostState {
  const reportedSince: Partial<Record<Reported, number>> = {};
  if (beat.sealed === true)
    reportedSince.openbao_sealed = state.reportedSince.openbao_sealed ?? nowMs;
  if (beat.kmsReachable === false) {
    reportedSince.kms_unreachable = state.reportedSince.kms_unreachable ?? nowMs;
  }
  return { ...state, lastHeartbeatAt: nowMs, lastHeartbeat: beat, reportedSince };
}

/** Whether the condition holds now, and since when. */
function bad(
  condition: Condition,
  nowMs: number,
  state: HostState,
  limits: ProbeLimits,
): number | null {
  switch (condition) {
    case "heartbeat_missing": {
      const since = state.lastHeartbeatAt ?? state.knownSince;
      return nowMs - since > limits.heartbeatGraceSeconds * 1000 ? since : null;
    }
    case "health_failing":
      return state.failingSince !== null &&
        nowMs - state.failingSince >= limits.healthGraceSeconds * 1000
        ? state.failingSince
        : null;
    case "openbao_sealed":
    case "kms_unreachable": {
      const since = state.reportedSince[condition];
      return since !== undefined && nowMs - since >= limits.reportedGraceSeconds * 1000
        ? since
        : null;
    }
  }
}

export function evaluate(
  nowMs: number,
  state: HostState,
  probeOk: boolean,
  limits: ProbeLimits,
): { next: HostState; alerts: AlertIntent[] } {
  const next: HostState = {
    ...state,
    failingSince: probeOk ? null : (state.failingSince ?? nowMs),
    open: { ...state.open },
  };
  const alerts: AlertIntent[] = [];
  for (const condition of CONDITIONS) {
    const since = bad(condition, nowMs, next, limits);
    const open = next.open[condition];
    if (since !== null) {
      if (open === undefined) {
        next.open[condition] = { openedAt: nowMs, sinceMs: since, lastAlertAt: null };
        alerts.push({ host: state.host, condition, kind: "opened", sinceMs: since });
      } else if (open.lastAlertAt === null) {
        alerts.push({ host: state.host, condition, kind: "opened", sinceMs: open.sinceMs });
      } else if (nowMs - open.lastAlertAt >= limits.reminderSeconds * 1000) {
        alerts.push({ host: state.host, condition, kind: "reminder", sinceMs: open.sinceMs });
      }
    } else if (open !== undefined) {
      next.open = Object.fromEntries(
        Object.entries(next.open).filter(([name]) => name !== condition),
      );
      if (open.lastAlertAt !== null) {
        alerts.push({ host: state.host, condition, kind: "resolved", sinceMs: open.sinceMs });
      }
    }
  }
  return { next, alerts };
}

export function markDelivered(state: HostState, alert: AlertIntent, nowMs: number): HostState {
  if (alert.kind === "resolved") return state;
  const open = state.open[alert.condition];
  if (open === undefined) return state;
  return { ...state, open: { ...state.open, [alert.condition]: { ...open, lastAlertAt: nowMs } } };
}
