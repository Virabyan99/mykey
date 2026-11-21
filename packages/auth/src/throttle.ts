// Throttling of password and factor attempts (P-48, D-28).
//
// Counters live in `app.rate_limit` under keyed digests:
//   key_digest = HMAC-SHA-256(rate key, scope ‖ 0x00 ‖ subject)
// so no row holds an address, an e-mail or a user id. Windows are cut on
// database time, so every API process shares them.
//
// Per source and phase: `authAttemptsPerMinute` attempts a minute, successes
// included (`src:<phase>`, 60 s windows). Per account and phase: failures in
// the current and the previous 15-minute window (`fail:<phase>`) reaching
// `authFailuresPerAccount` lock the account for `authDelaySeconds`
// (`lock:<phase>`). A locked or over-budget attempt is refused before any
// credential is checked, the same for known and unknown accounts.
//
// R1-1 (Run 8.6): an attempt is counted against the account when it is
// admitted, before its credential is checked, so attempts in flight cannot
// pass the lock. `recordFailure` then only decides the lock; `settle` takes
// back an admitted attempt that did not fail. An attempt that ends in neither
// (an error) stays counted: the safe side.
import { createHmac } from "node:crypto";
import { LIMITS } from "@mykey/contracts";
import {
  bumpCounter,
  deleteCounters,
  dropCounter,
  insertLock,
  lockSecondsLeft,
  sumCounters,
  withTransaction,
} from "@mykey/db";
import type pg from "pg";
import { ringKey, type KeyRing } from "./keys.ts";

export const THROTTLE_PHASES = ["password", "factor", "reset"] as const;
export type ThrottlePhase = (typeof THROTTLE_PHASES)[number];

export type Admission = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface Throttle {
  /** Counts the attempt, against the account too; throws when a counter cannot be written. */
  admit(
    phase: ThrottlePhase,
    subject: { source: string; account: string | null },
  ): Promise<Admission>;
  /** The admitted attempt failed: locks the account when its failures reach the limit. */
  recordFailure(phase: ThrottlePhase, account: string): Promise<void>;
  /** The admitted attempt did not fail: it no longer counts against the account. */
  settle(phase: ThrottlePhase, account: string): Promise<void>;
  /** Operator reset only (Run 3.6): every phase's failures and locks of these accounts. */
  clearAccount(accounts: readonly string[]): Promise<void>;
}

const SOURCE_WINDOW_SECONDS = 60;

/** HMAC-SHA-256(key, scope ‖ 0x00 ‖ subject). */
export function throttleDigest(key: Uint8Array, scope: string, subject: string): Buffer {
  return createHmac("sha256", key)
    .update(Buffer.from(scope, "utf8"))
    .update(Buffer.from([0]))
    .update(Buffer.from(subject, "utf8"))
    .digest();
}

export function createThrottle(deps: { pool: pg.Pool; ring: KeyRing }): Throttle {
  const digest = (scope: string, subject: string): Buffer =>
    throttleDigest(ringKey(deps.ring), scope, subject);
  const rate = LIMITS.rate;

  return {
    async admit(phase, subject) {
      if (subject.account !== null) {
        const scope = `lock:${phase}`;
        const left = await lockSecondsLeft(
          deps.pool,
          scope,
          digest(scope, subject.account),
          rate.authDelaySeconds,
        );
        // A locked attempt is not counted against the source.
        if (left !== null) return { allowed: false, retryAfterSeconds: left };
      }
      const scope = `src:${phase}`;
      const bumped = await bumpCounter(
        deps.pool,
        scope,
        digest(scope, subject.source),
        SOURCE_WINDOW_SECONDS,
      );
      if (bumped.count > rate.authAttemptsPerMinute) {
        return { allowed: false, retryAfterSeconds: bumped.secondsLeft };
      }
      const account = subject.account;
      if (account === null) return { allowed: true };
      // The attempt is counted as a failure until it settles. The bump locks
      // the current window's row, so concurrent admissions count one by one.
      const fail = `fail:${phase}`;
      const failDigest = digest(fail, account);
      const lock = `lock:${phase}`;
      const refused = await withTransaction(deps.pool, async (tx): Promise<number | null> => {
        await bumpCounter(tx, fail, failDigest, rate.authFailureWindowSeconds);
        // Again after the bump: a lock that landed since the first look has
        // deleted the counters, so this count alone would start from zero.
        const left = await lockSecondsLeft(tx, lock, digest(lock, account), rate.authDelaySeconds);
        const recent = await sumCounters(tx, fail, failDigest, rate.authFailureWindowSeconds, 2);
        if (left === null && recent <= rate.authFailuresPerAccount) return null;
        await dropCounter(tx, fail, failDigest, rate.authFailureWindowSeconds, 2);
        // The allowance is taken by attempts still in flight: they end within
        // seconds, as a lock or as allowance given back.
        return left ?? 1;
      });
      return refused === null ? { allowed: true } : { allowed: false, retryAfterSeconds: refused };
    },

    async recordFailure(phase, account) {
      const fail = `fail:${phase}`;
      const lock = `lock:${phase}`;
      const failDigest = digest(fail, account);
      await withTransaction(deps.pool, async (tx) => {
        const recent = await sumCounters(tx, fail, failDigest, rate.authFailureWindowSeconds, 2);
        if (recent >= rate.authFailuresPerAccount) {
          await insertLock(tx, lock, digest(lock, account));
          await deleteCounters(tx, [fail], failDigest);
        }
      });
    },

    async settle(phase, account) {
      const fail = `fail:${phase}`;
      await dropCounter(deps.pool, fail, digest(fail, account), rate.authFailureWindowSeconds, 2);
    },

    async clearAccount(accounts) {
      await withTransaction(deps.pool, async (tx) => {
        for (const account of accounts) {
          for (const phase of THROTTLE_PHASES) {
            for (const scope of [`fail:${phase}`, `lock:${phase}`]) {
              await deleteCounters(tx, [scope], digest(scope, account));
            }
          }
        }
      });
    },
  };
}
