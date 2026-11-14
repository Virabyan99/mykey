// The large-request gate (Run 4.7, Doc 06 §11 `concurrency.largePerProcess`):
// import preview, apply and resume, and export, read or write up to a whole
// environment. At most `max` of them run in one process; one more is refused
// at once with `503 busy` and never queued, so a burst cannot hold the
// process's memory or its lock connections.
import { ApiError } from "./pipeline/context.ts";

export interface LargeGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createLargeGate(max: number): LargeGate {
  if (!Number.isSafeInteger(max) || max < 1) throw new Error("invalid large-request limit");
  let running = 0;
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (running >= max) throw new ApiError("busy");
      running += 1;
      try {
        return await fn();
      } finally {
        running -= 1;
      }
    },
  };
}
