// Run 9.7 Task A (Session 8's review R4-4): step 1 of a restore. A target that
// serves (its gate open) or holds data is refused; the refusal of data is
// skipped only when the state line names the same pair at a step before the
// gate's opening. A state line left by a finished restore (step "opened") is
// refused with its path named.
import { startRefusal } from "@mykey/ops";
import { describe, expect, it } from "vitest";

const PATH = "/var/lib/mykey/restore-state.json";
const holds = { why: "the host holds organizations", serving: false };
const open = { why: "the gate is open", serving: true };

describe("step 1 of a restore (R4-4)", () => {
  it("the step-1 refusal of a serving host is skipped only when restore-state.json names the same pair AND a step before the gate opening; a finished state file is removed by --open, and a leftover one is refused with its path named", () => {
    // A clean target, no state: go.
    expect(
      startRefusal({ previous: null, pairId: "p", holding: null, statePath: PATH }),
    ).toBeNull();
    // Data and no state line: refused.
    expect(startRefusal({ previous: null, pairId: "p", holding: holds, statePath: PATH })).toBe(
      holds.why,
    );
    // This pair's restore stopped at a step before the opening: it starts over.
    for (const step of [
      "fetch",
      "postgres",
      "snapshot",
      "openbao",
      "invalidate",
      "start",
    ] as const) {
      expect(
        startRefusal({
          previous: { pairId: "p", step },
          pairId: "p",
          holding: holds,
          statePath: PATH,
        }),
        step,
      ).toBeNull();
    }
    // Another pair's state line: the data is refused.
    expect(
      startRefusal({
        previous: { pairId: "q", step: "start" },
        pairId: "p",
        holding: holds,
        statePath: PATH,
      }),
    ).toBe(holds.why);
    // A finished restore's line, left behind: refused, whatever pair, with the path named.
    for (const pairId of ["p", "q"]) {
      const refusal = startRefusal({
        previous: { pairId: "p", step: "opened" },
        pairId,
        holding: holds,
        statePath: PATH,
      });
      expect(refusal).toContain(PATH);
      expect(refusal).toMatch(/finished/);
    }
    // A host whose gate is open serves: refused even for this pair's own unfinished line.
    expect(
      startRefusal({
        previous: { pairId: "p", step: "start" },
        pairId: "p",
        holding: open,
        statePath: PATH,
      }),
    ).toBe(open.why);
  });
});
