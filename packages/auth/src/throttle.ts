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
import { createHmac } from "node:crypto";
import { LIMITS } from "@mykey/contracts";
import {
  bumpCounter,
  deleteCounters,
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
  /** Counts the attempt; throws when the counter cannot be written. */
  admit(
    phase: ThrottlePhase,
    subject: { source: string; account: string | null },
  ): Promise<Admission>;
  recordFailure(phase: ThrottlePhase, account: string): Promise<void>;
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
      return { allowed: true };
    },

    async recordFailure(phase, account) {
      const fail = `fail:${phase}`;
      const lock = `lock:${phase}`;
      const failDigest = digest(fail, account);
      await withTransaction(deps.pool, async (tx) => {
        await bumpCounter(tx, fail, failDigest, rate.authFailureWindowSeconds);
        const recent = await sumCounters(tx, fail, failDigest, rate.authFailureWindowSeconds, 2);
        if (recent >= rate.authFailuresPerAccount) {
          await insertLock(tx, lock, digest(lock, account));
          await deleteCounters(tx, [fail], failDigest);
        }
      });
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
