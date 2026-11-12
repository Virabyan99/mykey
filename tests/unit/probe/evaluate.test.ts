// Run 2.6: the probe's decision function (pure; time is passed in).
import { LIMITS } from "@mykey/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluate,
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
};
const T = 1_800_000_000_000;
const beat = { bootId: "b", sealed: null, kmsReachable: null };

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
