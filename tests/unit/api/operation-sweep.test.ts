// Run 4.5 (P-69): the API runs the stale-work sweep every 30 s plus up to 5 s
// of jitter; stop() ends it; a failing pass is logged by class and the timer
// keeps going.
import type { OperationId } from "@mykey/contracts";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startOperationSweep, type LogEntry } from "@mykey/api";

afterEach(() => {
  vi.useRealTimers();
});

describe("startOperationSweep", () => {
  it("passes every 30–35 s until stopped; a failure is logged and the next pass still runs", async () => {
    vi.useFakeTimers();
    const logs: LogEntry[] = [];
    let passes = 0;
    const sweep = vi.fn(() => {
      passes += 1;
      if (passes === 2) return Promise.reject(new TypeError("synthetic"));
      return Promise.resolve({
        uncertain: [],
        rejected: [],
        awaitingInput: [],
        previewsRemoved: 0,
      });
    });
    const timer = startOperationSweep({} as pg.Pool, (entry) => logs.push(entry), {
      idle: () => Promise.resolve(true),
      sweep,
      random: () => 0.5,
    });
    await vi.advanceTimersByTimeAsync(32_400);
    expect(passes).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(passes).toBe(1);
    await vi.advanceTimersByTimeAsync(32_500);
    expect(passes).toBe(2);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "operation_sweep",
        outcome: "failed",
        errorClass: "TypeError",
      }),
    );
    await vi.advanceTimersByTimeAsync(32_500);
    expect(passes).toBe(3);
    timer.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(passes).toBe(3);
  });

  it("logs the ids it settled, never anything else", async () => {
    vi.useFakeTimers();
    const logs: LogEntry[] = [];
    const id = "6f1c2f0e-0000-4000-8000-000000000001" as OperationId;
    const timer = startOperationSweep({} as pg.Pool, (entry) => logs.push(entry), {
      idle: () => Promise.resolve(true),
      sweep: () =>
        Promise.resolve({ uncertain: [id], rejected: [], awaitingInput: [], previewsRemoved: 0 }),
      random: () => 0,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    timer.stop();
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "operation_sweep", uncertain: [id], rejected: [] }),
    );
  });

  // Run 5.3 (P-91): each pass then drives the archives left executing.
  it("drives the archives after each pass and logs those it finished; a failing drive is logged and the timer goes on", async () => {
    vi.useFakeTimers();
    const logs: LogEntry[] = [];
    const id = "6f1c2f0e-0000-4000-8000-000000000002";
    let drives = 0;
    const timer = startOperationSweep({} as pg.Pool, (entry) => logs.push(entry), {
      idle: () => Promise.resolve(true),
      sweep: () =>
        Promise.resolve({ uncertain: [], rejected: [], awaitingInput: [], previewsRemoved: 0 }),
      archives: () => {
        drives += 1;
        if (drives === 2) return Promise.reject(new RangeError("synthetic"));
        return Promise.resolve({ archived: [id], waiting: [] });
      },
      random: () => 0,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(drives).toBe(1);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "archive_continue", archived: [id] }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(drives).toBe(2);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "operation_sweep",
        outcome: "failed",
        errorClass: "RangeError",
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(drives).toBe(3);
    timer.stop();
  });

  it("does nothing while a pair is captured (P-118): no sweep, no archive drive, no log", async () => {
    vi.useFakeTimers();
    const logs: LogEntry[] = [];
    let swept = 0;
    let driven = 0;
    const timer = startOperationSweep({} as pg.Pool, (entry) => logs.push(entry), {
      idle: () => Promise.resolve(false),
      sweep: () => {
        swept += 1;
        return Promise.resolve({
          uncertain: [],
          rejected: [],
          awaitingInput: [],
          previewsRemoved: 0,
        });
      },
      archives: () => {
        driven += 1;
        return Promise.resolve({ archived: [], waiting: [] });
      },
      random: () => 0,
    });
    await vi.advanceTimersByTimeAsync(95_000);
    timer.stop();
    expect([swept, driven, logs]).toEqual([0, 0, []]);
  });
});
