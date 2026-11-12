// Clean-up of the rate counters (Run 3.3, P-48): every ten minutes the API
// deletes counter rows whose window began more than an hour ago, at most 1,000
// a pass. Nothing it deletes is still counted: the longest window is 15 minutes
// and a lock lasts 15 minutes.
import { cleanUpSessions } from "@mykey/auth";
import { sweepCounters } from "@mykey/db";
import type pg from "pg";
import { now, type LogEntry } from "./log.ts";

export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
export const SWEEP_OLDER_THAN_SECONDS = 3600;
export const SWEEP_BATCH = 1000;

/** Expired sessions are removed at start and every hour (Run 3.5; Doc 04 §2.1 asks for daily). */
export const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export function startSessionCleanup(
  pool: pg.Pool,
  log: (entry: LogEntry) => void,
): { stop(): void } {
  const pass = (): void => {
    cleanUpSessions(pool).catch((error: unknown) => {
      log({
        event: "session_cleanup",
        time: now(),
        outcome: "failed",
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
      });
    });
  };
  pass();
  const timer = setInterval(pass, SESSION_CLEANUP_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

export function startThrottleSweep(
  pool: pg.Pool,
  log: (entry: LogEntry) => void,
): { stop(): void } {
  const pass = (): void => {
    sweepCounters(pool, SWEEP_OLDER_THAN_SECONDS, SWEEP_BATCH).catch((error: unknown) => {
      log({
        event: "throttle_sweep",
        time: now(),
        outcome: "failed",
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
      });
    });
  };
  const timer = setInterval(pass, SWEEP_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
