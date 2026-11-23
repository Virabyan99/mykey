// Run 10.2 Task B (D-77, RR-2): the re-drill's target and its clock. A restore
// has two hours from its step 4 to `restore-verify --open`; the drill file
// prints the minutes left before each later step and refuses to begin the
// opening with less than 15.
import { afterEach, describe, expect, it } from "vitest";
import { drillStateFile, restoreClock, type DrillState } from "../../harness/drill.ts";

const state = (data: Record<string, unknown>): DrillState => ({ done: [], steps: [], data });

afterEach(() => {
  delete process.env.MYKEY_DRILL_TARGET;
});

describe("the re-drill's clock", () => {
  it("restoreClock gives the minutes left of 120 from step 4, and null before step 4", () => {
    expect(restoreClock(state({}))).toEqual({ step4At: null, minutesLeft: null });
    const step4At = "2026-11-25T09:00:00.000Z";
    expect(restoreClock(state({ step4At }), new Date("2026-11-25T09:45:30.000Z"))).toEqual({
      step4At,
      minutesLeft: 74,
    });
    expect(restoreClock(state({ step4At }), new Date("2026-11-25T11:10:00.000Z")).minutesLeft).toBe(
      -10,
    );
  });

  it("a re-drill onto staging keeps its own state file, apart from Run 6.8's", () => {
    expect(drillStateFile()).toMatch(/[\\/]state\.json$/);
    process.env.MYKEY_DRILL_TARGET = "staging";
    expect(drillStateFile()).toMatch(/[\\/]redrill-state\.json$/);
  });
});
