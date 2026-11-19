// The outbox dispatcher of the API process (Run 3.1): one pass at start and one
// every second. A pass that fails (the database is restarting) is logged by
// error class and the next tick tries again; the process never stops for it.
import { captureMode } from "@mykey/db";
import { createSender, dispatchOutbox, type JobSender } from "@mykey/operations";
import type pg from "pg";
import { now, type LogEntry } from "./log.ts";

export const DISPATCH_INTERVAL_MS = 1_000;

export interface OutboxDispatcher {
  stop(): Promise<void>;
}

export function startOutboxDispatcher(
  pool: pg.Pool,
  log: (entry: LogEntry) => void,
  opts: { intervalMs?: number } = {},
): OutboxDispatcher {
  let sender: JobSender | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const pass = async (): Promise<void> => {
    try {
      // P-118: nothing is dispatched while a pair is captured.
      if ((await captureMode(pool)).mode !== "idle") return;
      sender ??= await createSender(pool);
      await dispatchOutbox(pool, sender);
    } catch (error) {
      log({
        event: "outbox",
        time: now(),
        outcome: "failed",
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  };

  const tick = (): void => {
    if (stopped || running !== null) return;
    running = pass().finally(() => {
      running = null;
    });
  };

  tick();
  const timer = setInterval(tick, opts.intervalMs ?? DISPATCH_INTERVAL_MS);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      // A pass stuck on a dead connection does not hold the shutdown.
      await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      await sender?.stop();
    },
  };
}
