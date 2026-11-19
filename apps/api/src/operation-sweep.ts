// The stale-work sweep's timer (Run 4.5, P-69): every 30 s plus up to 5 s of
// jitter, so that several API processes do not pass in step. A pass that
// fails is logged by its error class; the next one still runs. What a pass
// settled is logged by operation id only. From Run 5.2 a pass also runs the
// credential rules (sweepCredentials) after the secret ones.
import { captureMode } from "@mykey/db";
import { sweepCredentials, sweepStaleOperations, type SweepResult } from "@mykey/operations";
import type pg from "pg";
import { now, type LogEntry } from "./log.ts";

export const OPERATION_SWEEP_INTERVAL_MS = 30_000;
export const OPERATION_SWEEP_JITTER_MS = 5_000;

export type SweepPass =
  | { skipped: "capture" }
  | { result: SweepResult; archived: string[]; failed: { id: string; error: string }[] };

/**
 * One pass: the secret and credential rules, then the archives. P-118: while
 * a pair is captured (the mode is not idle) a pass does nothing.
 */
export async function operationSweepPass(
  pool: pg.Pool,
  opts: {
    sweep?: (pool: pg.Pool) => Promise<SweepResult>;
    archives?: () => Promise<{
      archived: string[];
      waiting: string[];
      failed?: { id: string; error: string }[];
    }>;
    /** Test only: whether the mode is idle. */
    idle?: (pool: pg.Pool) => Promise<boolean>;
  } = {},
): Promise<SweepPass> {
  const idle =
    opts.idle ?? (async (target: pg.Pool) => (await captureMode(target)).mode === "idle");
  if (!(await idle(pool))) return { skipped: "capture" };
  const result = await (opts.sweep ?? defaultSweep)(pool);
  const driven = opts.archives === undefined ? { archived: [], failed: [] } : await opts.archives();
  return { result, archived: driven.archived, failed: driven.failed ?? [] };
}

async function defaultSweep(target: pg.Pool): Promise<SweepResult> {
  const secrets = await sweepStaleOperations(target);
  const credentials = await sweepCredentials(target);
  return { ...secrets, uncertain: [...secrets.uncertain, ...credentials.uncertain] };
}

export function startOperationSweep(
  pool: pg.Pool,
  log: (entry: LogEntry) => void,
  opts: {
    /** Test only. */
    sweep?: (pool: pg.Pool) => Promise<SweepResult>;
    /** Run 5.3 (P-91): drives the archives left executing; its failure is logged like the sweep's. */
    archives?: () => Promise<{
      archived: string[];
      waiting: string[];
      failed?: { id: string; error: string }[];
    }>;
    random?: () => number;
    /** Test only: whether the mode is idle. */
    idle?: (pool: pg.Pool) => Promise<boolean>;
  } = {},
): { stop(): void } {
  const random = opts.random ?? Math.random;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(pass, OPERATION_SWEEP_INTERVAL_MS + random() * OPERATION_SWEEP_JITTER_MS);
    timer.unref();
  };
  const pass = (): void => {
    operationSweepPass(pool, {
      ...(opts.sweep === undefined ? {} : { sweep: opts.sweep }),
      ...(opts.archives === undefined ? {} : { archives: opts.archives }),
      ...(opts.idle === undefined ? {} : { idle: opts.idle }),
    }).then(
      (pass) => {
        if ("skipped" in pass) {
          schedule();
          return;
        }
        const { result, archived, failed } = pass;
        if (archived.length > 0) log({ event: "archive_continue", time: now(), archived });
        if (failed.length > 0) {
          log({
            event: "archive_failed",
            time: now(),
            failed: failed.map((f) => ({ operationId: f.id, errorClass: f.error })),
          });
        }
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
