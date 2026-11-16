// Run 6.3 Task B (P-114): the in-flight gate of one process. A request that
// finds it full is refused at once and never queued.
import { createInflightGate } from "@mykey/api";
import { describe, expect, it } from "vitest";

describe("the in-flight gate (P-114)", () => {
  it("admits `max`, refuses the next, admits again after one leaves", () => {
    const gate = createInflightGate(64);
    for (let i = 0; i < 64; i += 1) expect(gate.enter(), `request ${String(i + 1)}`).toBe(true);
    expect(gate.current()).toBe(64);
    expect(gate.enter()).toBe(false);
    expect(gate.current()).toBe(64);
    gate.leave();
    expect(gate.enter()).toBe(true);
    expect(gate.current()).toBe(64);
  });

  it("a leave without an enter never goes below zero", () => {
    const gate = createInflightGate(1);
    gate.leave();
    expect(gate.current()).toBe(0);
    expect(gate.enter()).toBe(true);
    expect(gate.enter()).toBe(false);
  });

  it("refuses an unusable maximum", () => {
    expect(() => createInflightGate(0)).toThrow();
    expect(() => createInflightGate(1.5)).toThrow();
  });
});
