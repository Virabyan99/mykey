// Run 6.9 Task C (P-129, Session 5 minor): the sweep drives each due archive
// on its own; one that throws is reported as failed and the tick goes on to
// the next.
import { driveEach } from "@mykey/operations";
import { describe, expect, it } from "vitest";

describe("driveEach (P-129)", () => {
  it("one archive that throws does not stop the tick from driving the next", async () => {
    const driven: string[] = [];
    const outcome = await driveEach(["a", "b", "c"], (id) => {
      driven.push(id);
      if (id === "b") return Promise.reject(new TypeError("boom"));
      return Promise.resolve(id === "a" ? "archived" : "waiting");
    });
    expect(driven).toEqual(["a", "b", "c"]);
    expect(outcome).toEqual({
      archived: ["a"],
      waiting: ["c"],
      failed: [{ id: "b", error: "TypeError" }],
    });
  });

  it("nothing due: nothing driven", async () => {
    expect(await driveEach([], () => Promise.resolve("archived"))).toEqual({
      archived: [],
      waiting: [],
      failed: [],
    });
  });
});
