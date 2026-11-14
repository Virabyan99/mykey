// Run 4.7 Task A (P-76): the classification of an import file's entries
// against the index. Pure: no store, no value kept.
import type { IndexRow } from "@mykey/db";
import { classifyEntries } from "@mykey/operations";
import { describe, expect, it } from "vitest";

const row = (name: string, state: IndexRow["state"], version = 3): IndexRow => ({
  name,
  currentVersion: version,
  stateTag: `tag-${name}`,
  state,
  liveValueBytes: 5,
  lastChangedAt: new Date(0),
  lastOperationId: null,
});

const entries = (...pairs: [string, string][]) =>
  pairs.map(([name, value], index) => ({ name, value, line: index * 2 + 1 }));

const index = new Map<string, IndexRow>([
  ["LIVE_SAME", row("LIVE_SAME", "live")],
  ["LIVE_OTHER", row("LIVE_OTHER", "live", 7)],
  ["GONE", row("GONE", "deleted")],
  ["REVIEW", row("REVIEW", "needs_review")],
]);
const same = (name: string, value: string): boolean => name === "LIVE_SAME" && value === "v";

describe("classifyEntries", () => {
  it("each of the six classifications, in file order with ordinals from 1", () => {
    const result = classifyEntries(
      entries(
        ["NEW", "v"],
        ["LIVE_SAME", "v"],
        ["LIVE_OTHER", "v"],
        ["GONE", "v"],
        ["bad-name", "v"],
        ["NEW", "again"],
      ),
      index,
      same,
    );
    expect(result.map((entry) => [entry.ordinal, entry.classification])).toEqual([
      [1, "create"],
      [2, "unchanged"],
      [3, "update"],
      [4, "conflict"],
      [5, "invalid"],
      [6, "duplicate"],
    ]);
    expect(result.map((entry) => entry.line)).toEqual([1, 3, 5, 7, 9, 11]);
  });

  it("an update carries the row's version and tag as its precondition; a create carries none", () => {
    const [create, update] = classifyEntries(
      entries(["NEW", "v"], ["LIVE_OTHER", "v"]),
      index,
      same,
    );
    expect(create).toMatchObject({ expectedVersion: null, expectedStateTag: null });
    expect(update).toMatchObject({ expectedVersion: 7, expectedStateTag: "tag-LIVE_OTHER" });
  });

  it("sameValue null (the caller may not read) never yields unchanged", () => {
    const [entry] = classifyEntries(entries(["LIVE_SAME", "v"]), index, null);
    expect(entry?.classification).toBe("update");
  });

  it("an invalid name comes back as null; so does a valid name with an invalid value", () => {
    const result = classifyEntries(
      entries(["lower", "v"], ["SECRETS_RESERVED", "v"], ["OK_NAME", "a\u0000b"]),
      index,
      same,
    );
    expect(result.map((entry) => [entry.name, entry.classification])).toEqual([
      [null, "invalid"],
      [null, "invalid"],
      [null, "invalid"],
    ]);
  });

  it("the second A is duplicate and the first is not", () => {
    const result = classifyEntries(entries(["A", "1"], ["A", "2"], ["A", "3"]), index, same);
    expect(result.map((entry) => entry.classification)).toEqual([
      "create",
      "duplicate",
      "duplicate",
    ]);
  });

  it("a key in review, deleted, or named by an occupied slot is a conflict", () => {
    const result = classifyEntries(
      entries(["REVIEW", "v"], ["GONE", "v"], ["LIVE_OTHER", "v"]),
      index,
      same,
      "LIVE_OTHER",
    );
    expect(result.map((entry) => entry.classification)).toEqual([
      "conflict",
      "conflict",
      "conflict",
    ]);
  });
});
