// Run 7.1 Task B (P-140): how the page follows an accepted operation. 1 s,
// 2 s, 4 s, then every 5 s, for at most two minutes; a state the server will
// not change by itself ends it at once.
import { OPERATION_STATES } from "@mykey/contracts";
import { describe, expect, it } from "vitest";
import { POLL_DELAYS_MS, isTerminal, nextPollDelay } from "@mykey/web";

describe("the poll schedule of an operation (P-140)", () => {
  it("is 1 s, 2 s, 4 s, then every 5 s, and ends within 120 s", () => {
    expect(POLL_DELAYS_MS.slice(0, 5)).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(POLL_DELAYS_MS.slice(3).every((delay) => delay === 5000)).toBe(true);
    const total = POLL_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeLessThanOrEqual(120_000);
    expect(total + 5000).toBeGreaterThan(120_000);
  });

  it("nextPollDelay stops after the last delay and for a terminal state", () => {
    expect(nextPollDelay(0, "accepted")).toBe(1000);
    expect(nextPollDelay(2, "executing")).toBe(4000);
    expect(nextPollDelay(POLL_DELAYS_MS.length, "executing")).toBeNull();
    for (const state of ["succeeded", "partial", "rejected", "uncertain", "awaiting_input"]) {
      expect(nextPollDelay(0, state), state).toBeNull();
    }
  });

  it("only accepted and executing are not terminal for the page", () => {
    expect(OPERATION_STATES.filter((state) => !isTerminal(state))).toEqual([
      "accepted",
      "executing",
    ]);
  });
});
