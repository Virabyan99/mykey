// Run 7.2 (P-138, Doc 10 §4.1 rule 2): the one holder of everything secret
// the page ever shows. Its rules are a pure function: a value is forgotten
// when its time is over, when the tab is hidden (unless the holder says the
// owner must leave the tab to use it), on every change of address, on
// sign-out, and when asked.
import { describe, expect, it } from "vitest";
import { EMPTY_HOLD, EPHEMERAL_TTL_MS, hold, type Held } from "@mykey/web";

const rules = { ttlMs: 30_000, clearOnHide: true };
const T0 = 1_000_000;
const holding = (value: string): Held<string> =>
  hold(EMPTY_HOLD as Held<string>, { type: "set", value, now: T0 }, rules);

describe("the forgetting holder", () => {
  it("holds nothing at first, and the default time is 30 seconds", () => {
    expect(EMPTY_HOLD).toEqual({ value: null, expiresAt: null });
    expect(EPHEMERAL_TTL_MS).toBe(30_000);
  });

  it("holds a value until its time is over, and not a millisecond longer", () => {
    const state = holding("v");
    expect(state).toEqual({ value: "v", expiresAt: T0 + 30_000 });
    expect(hold(state, { type: "tick", now: T0 + 29_999 }, rules)).toBe(state);
    expect(hold(state, { type: "tick", now: T0 + 30_000 }, rules)).toEqual(EMPTY_HOLD);
  });

  it("a new value replaces the old one and starts its own time", () => {
    const next = hold(holding("old"), { type: "set", value: "new", now: T0 + 20_000 }, rules);
    expect(next).toEqual({ value: "new", expiresAt: T0 + 50_000 });
  });

  it.each(["hidden", "navigated", "signed_out", "clear"] as const)("forgets on %s", (type) => {
    expect(hold(holding("v"), { type }, rules)).toEqual(EMPTY_HOLD);
  });

  it("a holder the owner must leave the tab for keeps its value when hidden, and nothing else", () => {
    const patient = { ttlMs: 600_000, clearOnHide: false };
    const state = hold(EMPTY_HOLD as Held<string>, { type: "set", value: "v", now: T0 }, patient);
    expect(hold(state, { type: "hidden" }, patient)).toBe(state);
    for (const type of ["navigated", "signed_out", "clear"] as const) {
      expect(hold(state, { type }, patient)).toEqual(EMPTY_HOLD);
    }
    expect(hold(state, { type: "tick", now: T0 + 600_000 }, patient)).toEqual(EMPTY_HOLD);
  });

  it("an event on an empty holder changes nothing (no render for nothing)", () => {
    const empty = EMPTY_HOLD as Held<string>;
    for (const event of [
      { type: "tick", now: T0 } as const,
      { type: "hidden" } as const,
      { type: "navigated" } as const,
      { type: "signed_out" } as const,
      { type: "clear" } as const,
    ]) {
      expect(hold(empty, event, rules)).toBe(empty);
    }
  });
});
