// Run 2.6: the probe's decision function (pure; time is passed in).
import { LIMITS } from "@mykey/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluate as evaluateAll,
  initialState,
  markDelivered,
  recordHeartbeat,
  type HostState,
  type ProbeLimits,
} from "@mykey/probe/evaluate";

const S = 1000;
const LIMITS_HERE: ProbeLimits = {
  heartbeatGraceSeconds: 180,
  healthGraceSeconds: 180,
  reportedGraceSeconds: 180,
  reminderSeconds: 3600,
  captureFreezeSeconds: 600,
  backupMaxAgeSeconds: 93_600,
};
const T = 1_800_000_000_000;
const beat = { bootId: "b", sealed: null, kmsReachable: null };

/**
 * These Run 2.6 tests use the old heartbeat shape. Since R6-6 (Run 8.6) that
 * shape also opens checks_unknown, which it cannot measure; that condition is
 * proven in evaluate-v2.test.ts. Here only the others are looked at.
 */
function evaluate(...args: Parameters<typeof evaluateAll>): ReturnType<typeof evaluateAll> {
  const result = evaluateAll(...args);
  const open = Object.fromEntries(
    Object.entries(result.next.open).filter(([condition]) => condition !== "checks_unknown"),
  );
  return {
    next: { ...result.next, open },
    alerts: result.alerts.filter((alert) => alert.condition !== "checks_unknown"),
  };
}

/** Runs evaluate and delivers every alert at once, as a working sink would. */
function step(state: HostState, now: number, probeOk: boolean) {
  const { next, alerts } = evaluate(now, state, probeOk, LIMITS_HERE);
  let delivered = next;
  for (const alert of alerts) delivered = markDelivered(delivered, alert, now);
  return { state: delivered, alerts };
}

describe("evaluate", () => {
  it("uses the limits of @mykey/contracts", () => {
    expect(LIMITS_HERE.heartbeatGraceSeconds).toBe(LIMITS.monitoring.heartbeatGraceSeconds);
    expect(LIMITS_HERE.reminderSeconds).toBe(LIMITS.monitoring.alertReminderSeconds);
    expect(LIMITS_HERE.captureFreezeSeconds).toBe(LIMITS.backup.freezeAlertSeconds);
    expect(LIMITS_HERE.backupMaxAgeSeconds).toBe(LIMITS.backup.maxAgeAlertSeconds);
  });

  it("nothing opens inside the grace period", () => {
    const state = recordHeartbeat(initialState("staging", T), T, beat);
    expect(evaluate(T + 180 * S, state, true, LIMITS_HERE).alerts).toEqual([]);
    expect(evaluate(T + 181 * S, state, true, LIMITS_HERE).alerts).toEqual([
      { host: "staging", condition: "heartbeat_missing", kind: "opened", sinceMs: T },
    ]);
  });

  it("a host that never sent a heartbeat opens once it has been known for longer than the grace", () => {
    const state = initialState("prod", T);
    expect(evaluate(T + 180 * S, state, true, LIMITS_HERE).alerts).toEqual([]);
    expect(evaluate(T + 181 * S, state, true, LIMITS_HERE).alerts.map((a) => a.condition)).toEqual([
      "heartbeat_missing",
    ]);
  });

  it("an undelivered alert is asked for again, and a delivered one waits for the reminder", () => {
    const state = recordHeartbeat(initialState("staging", T), T, beat);
    const first = evaluate(T + 181 * S, state, true, LIMITS_HERE);
    const again = evaluate(T + 241 * S, first.next, true, LIMITS_HERE);
    expect(again.alerts).toEqual(first.alerts);
    const delivered = markDelivered(again.next, again.alerts[0]!, T + 241 * S);
    expect(evaluate(T + 301 * S, delivered, true, LIMITS_HERE).alerts).toEqual([]);
    expect(evaluate(T + 241 * S + 3599 * S, delivered, true, LIMITS_HERE).alerts).toEqual([]);
    expect(evaluate(T + 241 * S + 3600 * S, delivered, true, LIMITS_HERE).alerts).toEqual([
      { host: "staging", condition: "heartbeat_missing", kind: "reminder", sinceMs: T },
    ]);
  });

  it("one failed probe is not an outage", () => {
    let state = recordHeartbeat(initialState("staging", T), T, beat);
    const seen: string[] = [];
    for (const [offset, ok] of [
      [60, false],
      [120, true],
      [180, false],
    ] as const) {
      state = recordHeartbeat(state, T + offset * S, beat);
      const result = step(state, T + offset * S, ok);
      state = result.state;
      seen.push(...result.alerts.map((a) => a.condition));
    }
    expect(seen).toEqual([]);
    // Three minutes of continuous failure.
    for (const offset of [240, 300, 360]) {
      state = recordHeartbeat(state, T + offset * S, beat);
      const result = step(state, T + offset * S, false);
      state = result.state;
      seen.push(...result.alerts.map((a) => `${a.kind} ${a.condition}`));
    }
    expect(seen).toEqual(["opened health_failing"]);
  });

  it("recovery is announced once; a condition never announced resolves silently", () => {
    let state = recordHeartbeat(initialState("staging", T), T, beat);
    state = step(state, T + 181 * S, true).state;
    state = recordHeartbeat(state, T + 200 * S, beat);
    const recovered = step(state, T + 200 * S, true);
    expect(recovered.alerts).toEqual([
      { host: "staging", condition: "heartbeat_missing", kind: "resolved", sinceMs: T },
    ]);
    expect(recovered.state.open).toEqual({});
    expect(step(recovered.state, T + 260 * S, true).alerts).toEqual([]);

    // Opened but never delivered: no "resolved" for something nobody was told about.
    let silent = recordHeartbeat(initialState("prod", T), T, beat);
    silent = evaluate(T + 181 * S, silent, true, LIMITS_HERE).next;
    silent = recordHeartbeat(silent, T + 190 * S, beat);
    const quiet = evaluate(T + 190 * S, silent, true, LIMITS_HERE);
    expect(quiet.alerts).toEqual([]);
    expect(quiet.next.open).toEqual({});
  });

  it("host-reported conditions open after the grace; null opens nothing", () => {
    let state = initialState("staging", T);
    const seen: string[] = [];
    for (let offset = 0; offset <= 181; offset += 60) {
      state = recordHeartbeat(state, T + offset * S, {
        bootId: "b",
        sealed: null,
        kmsReachable: false,
      });
      const result = step(state, T + offset * S, true);
      state = result.state;
      seen.push(...result.alerts.map((a) => `${a.kind} ${a.condition}`));
    }
    state = recordHeartbeat(state, T + 181 * S, { bootId: "b", sealed: null, kmsReachable: false });
    const result = step(state, T + 181 * S, true);
    seen.push(...result.alerts.map((a) => `${a.kind} ${a.condition}`));
    expect(seen).toEqual(["opened kms_unreachable"]);

    let unknown = initialState("prod", T);
    for (let offset = 0; offset <= 600; offset += 60) {
      unknown = recordHeartbeat(unknown, T + offset * S, beat);
      expect(step(unknown, T + offset * S, true).alerts).toEqual([]);
    }
  });

  it("conditions are independent", () => {
    let state = recordHeartbeat(initialState("staging", T), T, beat);
    state = step(state, T + 60 * S, false).state;
    const result = evaluate(T + 241 * S, state, false, LIMITS_HERE);
    expect(result.alerts.map((a) => a.condition).sort()).toEqual([
      "health_failing",
      "heartbeat_missing",
    ]);
  });
});

describe("review_open (Run 3.8, P-57)", () => {
  const withReview = (reviewOpen: number | null) => ({ ...beat, reviewOpen });

  it("enters on reviewOpen: 1, stays without a second alert, leaves on 0", () => {
    let state = recordHeartbeat(initialState("staging", T), T, withReview(1));
    const entered = step(state, T + S, true);
    expect(entered.alerts).toEqual([
      { host: "staging", condition: "review_open", kind: "opened", sinceMs: T },
    ]);
    state = recordHeartbeat(entered.state, T + 60 * S, withReview(1));
    expect(step(state, T + 61 * S, true).alerts).toEqual([]);
    state = recordHeartbeat(entered.state, T + 120 * S, withReview(0));
    expect(step(state, T + 121 * S, true).alerts).toEqual([
      { host: "staging", condition: "review_open", kind: "resolved", sinceMs: T },
    ]);
  });

  it("reviewOpen: null is not an alert of this condition", () => {
    const state = recordHeartbeat(initialState("staging", T), T, withReview(null));
    expect(step(state, T + 10 * S, true).alerts).toEqual([]);
  });
});

describe("operations_unresolved (Run 4.5)", () => {
  const withUnresolved = (operationsUnresolved: number | null) => ({
    ...beat,
    reviewOpen: 0,
    operationsUnresolved,
  });

  it("operationsUnresolved: 1 raises it at once; 0 clears it", () => {
    let state = recordHeartbeat(initialState("staging", T), T, withUnresolved(1));
    const entered = step(state, T + S, true);
    expect(entered.alerts).toEqual([
      { host: "staging", condition: "operations_unresolved", kind: "opened", sinceMs: T },
    ]);
    state = recordHeartbeat(entered.state, T + 60 * S, withUnresolved(1));
    expect(step(state, T + 61 * S, true).alerts).toEqual([]);
    state = recordHeartbeat(entered.state, T + 120 * S, withUnresolved(0));
    expect(step(state, T + 121 * S, true).alerts).toEqual([
      { host: "staging", condition: "operations_unresolved", kind: "resolved", sinceMs: T },
    ]);
  });

  it("a heartbeat without the field, or with null, raises nothing", () => {
    for (const beatHere of [{ ...beat, reviewOpen: 0 }, withUnresolved(null)]) {
      const state = recordHeartbeat(initialState("staging", T), T, beatHere);
      expect(step(state, T + 10 * S, true).alerts).toEqual([]);
    }
  });

  // After Session 5: production is deliberately not serving (no gate, no OpenBao);
  // its health_failing sent an hourly reminder for days. A host marked
  // `inService: false` gets no health_failing; every other condition is unchanged.
  describe("a host not in service", () => {
    const quiet = { inService: false };

    it("a failing /health opens nothing and reminds nothing; heartbeat_missing still opens", () => {
      let state = recordHeartbeat(initialState("prod", T), T, beat);
      for (let minute = 1; minute <= 300; minute += 1) {
        const now = T + minute * 60 * S;
        if (minute < 200) state = recordHeartbeat(state, now, beat);
        const { next, alerts } = evaluate(now, state, false, LIMITS_HERE, quiet);
        expect(alerts.map((a) => a.condition)).not.toContain("health_failing");
        expect(next.open.health_failing).toBeUndefined();
        state = next;
        for (const alert of alerts) state = markDelivered(state, alert, now);
      }
      expect(Object.keys(state.open)).toEqual(["heartbeat_missing"]);
    });

    it("an open health_failing is closed without a message (it is not resolved), and opens again once in service", () => {
      let state = recordHeartbeat(initialState("prod", T), T, beat);
      // /health fails from 60 s; after the 180 s grace health_failing opens and is delivered.
      state = step(recordHeartbeat(state, T + 60 * S, beat), T + 60 * S, false).state;
      const opened = step(recordHeartbeat(state, T + 240 * S, beat), T + 241 * S, false);
      expect(opened.alerts).toEqual([
        { host: "prod", condition: "health_failing", kind: "opened", sinceMs: T + 60 * S },
      ]);
      state = opened.state;
      expect(state.open.health_failing?.lastAlertAt).toBe(T + 241 * S);
      const marked = evaluate(
        T + 301 * S,
        recordHeartbeat(state, T + 300 * S, beat),
        false,
        LIMITS_HERE,
        quiet,
      );
      expect(marked.alerts).toEqual([]);
      expect(marked.next.open.health_failing).toBeUndefined();
      const back = evaluate(
        T + 361 * S,
        recordHeartbeat(marked.next, T + 360 * S, beat),
        false,
        LIMITS_HERE,
      );
      expect(back.alerts).toEqual([
        { host: "prod", condition: "health_failing", kind: "opened", sinceMs: T + 60 * S },
      ]);
    });
  });
});
