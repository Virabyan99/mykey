// Run 6.4 Task A (P-116, M-4): the nine conditions of heartbeat version 2.
// Unknown is not healthy: a null (or, for captureSince, absent) field leaves an
// open condition open and sends no "resolved"; a field unknown for longer than
// the reported grace opens checks_unknown.
import { LIMITS } from "@mykey/contracts";
import { describe, expect, it } from "vitest";
import {
  certificateThresholdMs,
  evaluate,
  initialState,
  markDelivered,
  reading,
  recordHeartbeat,
  type Checks,
  type Condition,
  type HeartbeatV2,
  type HostState,
  type ProbeLimits,
} from "@mykey/probe/evaluate";

const S = 1000;
const DAY = 86_400 * S;
const T = 1_800_000_000_000;
const L: ProbeLimits = {
  heartbeatGraceSeconds: 180,
  healthGraceSeconds: 180,
  reportedGraceSeconds: 180,
  reminderSeconds: 3600,
  captureFreezeSeconds: LIMITS.backup.freezeAlertSeconds,
  backupMaxAgeSeconds: LIMITS.backup.maxAgeAlertSeconds,
};
const iso = (ms: number): string => new Date(ms).toISOString();

function checks(over: Partial<Checks> = {}): Checks {
  return {
    sealed: false,
    kmsReachable: true,
    reviewOpen: 0,
    operationsUnresolved: 0,
    firewallLoaded: true,
    diskLow: false,
    auditFailing: false,
    captureSince: null,
    backup: { expected: true, newestEligibleCaptureAt: iso(T - 3600 * S) },
    certificates: [{ name: "public", notBefore: iso(T - 10 * DAY), notAfter: iso(T + 80 * DAY) }],
    credentialExpiring: 0,
    unitsFailed: [],
    ...over,
  };
}
const beat = (now: number, over: Partial<Checks> = {}): HeartbeatV2 => ({
  v: 2,
  bootId: "b",
  observedAt: iso(now),
  checks: checks(over),
});
/** A heartbeat whose captureSince is absent: the host could not tell. */
function absentCapture(now: number): HeartbeatV2 {
  const value = beat(now);
  const checks: Partial<Checks> = { ...value.checks };
  delete checks.captureSince;
  return { ...value, checks: checks as Checks };
}

/** Records the beat, evaluates, delivers every alert (a working sink). */
function step(state: HostState, now: number, next: HeartbeatV2, inService = true) {
  const recorded = recordHeartbeat(state, now, next);
  const result = evaluate(now, recorded, true, L, { inService });
  let delivered = result.next;
  for (const alert of result.alerts) delivered = markDelivered(delivered, alert, now);
  return { state: delivered, alerts: result.alerts.map((a) => `${a.kind} ${a.condition}`) };
}

interface Case {
  condition: Condition;
  bad: (now: number) => HeartbeatV2;
  good: (now: number) => HeartbeatV2;
  unknown: (now: number) => HeartbeatV2;
  graceSeconds: number;
}

const CASES: Case[] = [
  {
    condition: "disk_low",
    bad: (n) => beat(n, { diskLow: true }),
    good: (n) => beat(n),
    unknown: (n) => beat(n, { diskLow: null }),
    graceSeconds: 180,
  },
  {
    condition: "audit_failing",
    bad: (n) => beat(n, { auditFailing: true }),
    good: (n) => beat(n),
    unknown: (n) => beat(n, { auditFailing: null }),
    graceSeconds: 180,
  },
  {
    condition: "firewall_unloaded",
    bad: (n) => beat(n, { firewallLoaded: false }),
    good: (n) => beat(n),
    unknown: (n) => beat(n, { firewallLoaded: null }),
    graceSeconds: 180,
  },
  {
    condition: "unit_failed",
    bad: (n) => beat(n, { unitsFailed: ["mykey-backup.service"] }),
    good: (n) => beat(n),
    unknown: (n) => beat(n, { unitsFailed: null }),
    graceSeconds: 180,
  },
  {
    condition: "credential_expiring",
    bad: (n) => beat(n, { credentialExpiring: 2 }),
    good: (n) => beat(n),
    unknown: (n) => beat(n, { credentialExpiring: null }),
    graceSeconds: 0,
  },
  {
    condition: "certificate_expiring",
    bad: (n) =>
      beat(n, {
        certificates: [
          { name: "public", notBefore: iso(T - 10 * DAY), notAfter: iso(T + 80 * DAY) },
          { name: "kms-client", notBefore: iso(T - 85 * DAY), notAfter: iso(T + 5 * DAY) },
        ],
      }),
    good: (n) => beat(n),
    unknown: (n) => beat(n, { certificates: null }),
    graceSeconds: 0,
  },
  {
    condition: "capture_frozen",
    bad: (n) => beat(n, { captureSince: iso(T - 700 * S) }),
    good: (n) => beat(n),
    unknown: absentCapture,
    graceSeconds: 0,
  },
  {
    condition: "backup_stale",
    bad: (n) => beat(n, { backup: { expected: true, newestEligibleCaptureAt: null } }),
    good: (n) => beat(n),
    unknown: (n) => beat(n, { backup: null }),
    graceSeconds: 0,
  },
];

describe.each(CASES)("$condition (P-116)", ({ condition, bad, good, unknown, graceSeconds }) => {
  const only = (alerts: string[]) => alerts.filter((a) => a.endsWith(` ${condition}`));

  it("opens on bad after its grace", () => {
    let state = initialState("staging", T);
    if (graceSeconds > 0) {
      for (const offset of [0, 60, 120, graceSeconds - 1]) {
        const result = step(state, T + offset * S, bad(T + offset * S));
        expect(only(result.alerts), `at ${String(offset)} s`).toEqual([]);
        state = result.state;
      }
    }
    const opened = step(state, T + graceSeconds * S, bad(T + graceSeconds * S));
    expect(only(opened.alerts)).toEqual([`opened ${condition}`]);
  });

  it("resolves on good", () => {
    let state = step(initialState("staging", T), T, bad(T)).state;
    state = step(state, T + 200 * S, bad(T + 200 * S)).state;
    expect(state.open[condition]).toBeDefined();
    const resolved = step(state, T + 260 * S, good(T + 260 * S));
    expect(only(resolved.alerts)).toEqual([`resolved ${condition}`]);
    expect(resolved.state.open[condition]).toBeUndefined();
  });

  it("a null field keeps it open and sends no resolved (M-4)", () => {
    let state = step(initialState("staging", T), T, bad(T)).state;
    state = step(state, T + 200 * S, bad(T + 200 * S)).state;
    expect(state.open[condition]).toBeDefined();
    for (let offset = 260; offset <= 260 + 600; offset += 60) {
      const result = step(state, T + offset * S, unknown(T + offset * S));
      expect(only(result.alerts)).toEqual([]);
      state = result.state;
    }
    expect(state.open[condition]).toBeDefined();
    expect(step(state, T + 900 * S, good(T + 900 * S)).alerts).toContain(`resolved ${condition}`);
  });

  it("an unknown field never opens it", () => {
    let state = initialState("staging", T);
    for (let offset = 0; offset <= 600; offset += 60) {
      const result = step(state, T + offset * S, unknown(T + offset * S));
      expect(only(result.alerts)).toEqual([]);
      state = result.state;
    }
  });
});

describe("checks_unknown (P-116)", () => {
  it("opens when a field stays unknown longer than the reported grace, and resolves when every field is known", () => {
    let state = initialState("staging", T);
    const seen: string[] = [];
    for (const offset of [0, 60, 120, 179]) {
      const result = step(state, T + offset * S, beat(T + offset * S, { diskLow: null }));
      seen.push(...result.alerts);
      state = result.state;
    }
    expect(seen).toEqual([]);
    const opened = step(state, T + 181 * S, beat(T + 181 * S, { diskLow: null }));
    expect(opened.alerts).toEqual(["opened checks_unknown"]);
    // Another field unknown while the first comes back: still open.
    const swapped = step(opened.state, T + 240 * S, beat(T + 240 * S, { unitsFailed: null }));
    expect(swapped.alerts).toEqual([]);
    const known = step(swapped.state, T + 300 * S, beat(T + 300 * S));
    expect(known.alerts).toEqual(["resolved checks_unknown"]);
  });

  it("an absent captureSince counts as unknown; a null one is idle", () => {
    let state = initialState("staging", T);
    let last: string[] = [];
    for (let offset = 0; offset <= 240; offset += 60) {
      const result = step(state, T + offset * S, absentCapture(T + offset * S));
      last = [...last, ...result.alerts];
      state = result.state;
    }
    expect(last).toEqual(["opened checks_unknown"]);
    let idle = initialState("staging", T);
    for (let offset = 0; offset <= 600; offset += 60) {
      const result = step(idle, T + offset * S, beat(T + offset * S, { captureSince: null }));
      expect(result.alerts).toEqual([]);
      idle = result.state;
    }
  });

  it("the old heartbeat shapes never open it", () => {
    let state = initialState("staging", T);
    for (let offset = 0; offset <= 900; offset += 60) {
      state = recordHeartbeat(state, T + offset * S, {
        bootId: "b",
        sealed: null,
        kmsReachable: null,
      });
      const result = evaluate(T + offset * S, state, true, L);
      expect(result.alerts).toEqual([]);
      state = result.next;
    }
  });
});

describe("the old conditions under version 2 (M-4)", () => {
  it("sealed: null keeps openbao_sealed open and sends no resolved", () => {
    let state = initialState("staging", T);
    for (let offset = 0; offset <= 180; offset += 60) {
      state = step(state, T + offset * S, beat(T + offset * S, { sealed: true })).state;
    }
    expect(state.open.openbao_sealed).toBeDefined();
    const unknown = step(state, T + 240 * S, beat(T + 240 * S, { sealed: null }));
    expect(unknown.alerts).toEqual([]);
    expect(step(unknown.state, T + 300 * S, beat(T + 300 * S)).alerts).toEqual([
      "resolved openbao_sealed",
    ]);
  });

  it("a stale heartbeat resolves nothing: heartbeat_missing opens, disk_low stays open", () => {
    let state = step(initialState("staging", T), T, beat(T, { diskLow: true })).state;
    state = step(state, T + 180 * S, beat(T + 180 * S, { diskLow: true })).state;
    expect(state.open.disk_low).toBeDefined();
    const later = evaluate(T + 600 * S, state, true, L);
    expect(later.alerts.map((a) => `${a.kind} ${a.condition}`)).toEqual([
      "opened heartbeat_missing",
    ]);
    expect(later.next.open.disk_low).toBeDefined();
  });
});

describe("capture_frozen and backup_stale thresholds (P-116)", () => {
  it("capture_frozen: 599 s → nothing, 601 s → opened", () => {
    const since = { captureSince: iso(T) };
    expect(step(initialState("staging", T), T + 599 * S, beat(T + 599 * S, since)).alerts).toEqual(
      [],
    );
    expect(step(initialState("staging", T), T + 601 * S, beat(T + 601 * S, since)).alerts).toEqual([
      "opened capture_frozen",
    ]);
  });

  it("backup_stale: expected false never opens; 93,601 s old opens; no eligible capture with expected opens", () => {
    let state = initialState("staging", T);
    for (let hour = 0; hour <= 48; hour += 1) {
      const now = T + hour * 3600 * S;
      const result = step(
        state,
        now,
        beat(now, { backup: { expected: false, newestEligibleCaptureAt: null } }),
      );
      expect(result.alerts).toEqual([]);
      state = result.state;
    }
    const at = (age: number) => ({
      backup: { expected: true, newestEligibleCaptureAt: iso(T - age * S) },
    });
    expect(step(initialState("staging", T), T, beat(T, at(93_599))).alerts).toEqual([]);
    expect(step(initialState("staging", T), T, beat(T, at(93_601))).alerts).toEqual([
      "opened backup_stale",
    ]);
    expect(
      step(
        initialState("staging", T),
        T,
        beat(T, { backup: { expected: true, newestEligibleCaptureAt: null } }),
      ).alerts,
    ).toEqual(["opened backup_stale"]);
  });

  it("reading() answers bad, good or unknown", () => {
    expect(reading("backup_stale", beat(T, { backup: null }), T, L)).toBe("unknown");
    expect(reading("disk_low", beat(T, { diskLow: true }), T, L)).toBe("bad");
    expect(reading("unit_failed", beat(T), T, L)).toBe("good");
  });
});

describe("certificateThresholdMs (P-116)", () => {
  const lifetime = (days: number) => [iso(T), iso(T + days * DAY)] as const;

  it("30 days for a certificate that lives longer than 60 days; a third of its life otherwise", () => {
    expect(certificateThresholdMs(...lifetime(90))).toBe(30 * DAY);
    expect(certificateThresholdMs(...lifetime(61))).toBe(30 * DAY);
    expect(certificateThresholdMs(...lifetime(60))).toBe(20 * DAY);
    expect(certificateThresholdMs(...lifetime(30))).toBe(10 * DAY);
  });

  it("a fresh 30-day certificate is not expiring; one with 9 days left is", () => {
    const fresh = { name: "kms-client", notBefore: iso(T - 3600 * S), notAfter: iso(T + 30 * DAY) };
    expect(reading("certificate_expiring", beat(T, { certificates: [fresh] }), T, L)).toBe("good");
    const old = { name: "kms-client", notBefore: iso(T - 21 * DAY), notAfter: iso(T + 9 * DAY) };
    expect(reading("certificate_expiring", beat(T, { certificates: [old] }), T, L)).toBe("bad");
  });
});

describe("a host not in service (P-116)", () => {
  it("silences health_failing and backup_stale only", () => {
    let state = initialState("prod", T);
    const opened = new Set<string>();
    for (let offset = 0; offset <= 900; offset += 60) {
      const now = T + offset * S;
      state = recordHeartbeat(
        state,
        now,
        beat(now, { diskLow: true, backup: { expected: true, newestEligibleCaptureAt: null } }),
      );
      const result = evaluate(now, state, false, L, { inService: false });
      for (const alert of result.alerts) opened.add(alert.condition);
      state = result.next;
      for (const alert of result.alerts) state = markDelivered(state, alert, now);
    }
    expect([...opened]).toEqual(["disk_low"]);
  });
});

describe("a resolved alert is delivered or asked for again (D-22's open point)", () => {
  it("a failed resolved is in the next evaluation's alerts; a delivered one is not", () => {
    let state = step(initialState("staging", T), T, beat(T, { credentialExpiring: 1 })).state;
    state = recordHeartbeat(state, T + 60 * S, beat(T + 60 * S));
    const first = evaluate(T + 60 * S, state, true, L);
    expect(first.alerts.map((a) => `${a.kind} ${a.condition}`)).toEqual([
      "resolved credential_expiring",
    ]);
    // Not delivered: asked for again.
    const second = evaluate(T + 120 * S, first.next, true, L);
    expect(second.alerts).toEqual(first.alerts);
    const delivered = markDelivered(second.next, second.alerts[0]!, T + 120 * S);
    expect(evaluate(T + 180 * S, delivered, true, L).alerts).toEqual([]);
  });

  it("a condition that opens again before its resolved was delivered drops the resolved", () => {
    let state = step(initialState("staging", T), T, beat(T, { credentialExpiring: 1 })).state;
    state = recordHeartbeat(state, T + 60 * S, beat(T + 60 * S));
    const first = evaluate(T + 60 * S, state, true, L);
    state = recordHeartbeat(first.next, T + 120 * S, beat(T + 120 * S, { credentialExpiring: 1 }));
    const again = evaluate(T + 120 * S, state, true, L);
    expect(again.alerts.map((a) => `${a.kind} ${a.condition}`)).toEqual([
      "opened credential_expiring",
    ]);
  });
});
