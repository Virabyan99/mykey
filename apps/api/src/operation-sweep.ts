// The stale-work sweep's timer (Run 4.5, P-69): every 30 s plus up to 5 s of
// jitter, so that several API processes do not pass in step. A pass that
// fails is logged by its error class; the next one still runs. What a pass
// settled is logged by operation id only. From Run 5.2 a pass also runs the
// credential rules (sweepCredentials) after the secret ones.
import { sweepCredentials, sweepStaleOperations, type SweepResult } from "@mykey/operations";
import type pg from "pg";
import { now, type LogEntry } from "./log.ts";

export const OPERATION_SWEEP_INTERVAL_MS = 30_000;
export const OPERATION_SWEEP_JITTER_MS = 5_000;

export function startOperationSweep(
  pool: pg.Pool,
  log: (entry: LogEntry) => void,
  opts: {
    /** Test only. */
    sweep?: (pool: pg.Pool) => Promise<SweepResult>;
    random?: () => number;
  } = {},
): { stop(): void } {
  const sweep =
    opts.sweep ??
    (async (target: pg.Pool): Promise<SweepResult> => {
      const secrets = await sweepStaleOperations(target);
      const credentials = await sweepCredentials(target);
      return { ...secrets, uncertain: [...secrets.uncertain, ...credentials.uncertain] };
    });
  const random = opts.random ?? Math.random;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(pass, OPERATION_SWEEP_INTERVAL_MS + random() * OPERATION_SWEEP_JITTER_MS);
    timer.unref();
  };
  const pass = (): void => {
    sweep(pool).then(
      (result) => {
        if (result.uncertain.length > 0 || result.rejected.length > 0) {
          log({
            event: "operation_sweep",
            time: now(),
            uncertain: result.uncertain,
            rejected: result.rejected,
          });
        }
        schedule();
      },
      (error: unknown) => {
        log({
          event: "operation_sweep",
          time: now(),
          outcome: "failed",
          errorClass: error instanceof Error ? error.constructor.name : typeof error,
        });
        schedule();
      },
    );
  };
  schedule();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
