// The large-request gate (Run 4.7, Doc 06 §11 concurrency.largePerProcess):
// at most `max` large requests run in one process; one more is refused at
// once with busy, never queued.
import { createLargeGate } from "@mykey/api";
import { describe, expect, it } from "vitest";

describe("createLargeGate", () => {
  it("runs two at once, refuses the third with busy, and admits again once one ends", async () => {
    const gate = createLargeGate(2);
    const releases: (() => void)[] = [];
    const held = () =>
      gate.run(
        () =>
          new Promise<string>((resolve) => {
            releases.push(() => {
              resolve("done");
            });
          }),
      );
    const first = held();
    const second = held();
    const third = await gate.run(() => Promise.resolve("ran")).catch((error: unknown) => error);
    expect((third as { code?: string }).code).toBe("busy");
    releases[0]?.();
    expect(await first).toBe("done");
    expect(await gate.run(() => Promise.resolve("ran"))).toBe("ran");
    releases[1]?.();
    expect(await second).toBe("done");
  });

  it("a failing run frees its place", async () => {
    const gate = createLargeGate(1);
    await expect(gate.run(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await gate.run(() => Promise.resolve(1))).toBe(1);
  });
});
