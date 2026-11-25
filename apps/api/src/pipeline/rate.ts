// Rate limits (Run 6.3, P-113, FR-1.60, D-49). Pipeline steps on the counters
// of D-28 (`app.rate_limit`, 60-second windows cut on database time, so every
// API process counts into the same rows). A row holds a keyed digest of
// (scope, subject), never an address, a session id or a token.
//
// Order in a request: gate → source (before the body is read) → … →
// authentication → session or credential → validation → authorization → the
// route's own class → the rest. A refusal is 429 `rate_limited` with
// `retry-after` (the seconds left of the window). A counter that cannot be
// bumped or read is 503 `dependency_unavailable`: no path skips a step.
import { throttleDigest, ringKey, type KeyRing } from "@mykey/auth";
import { LIMITS } from "@mykey/contracts";
import { bumpCounter, sumCounters } from "@mykey/db";
import type pg from "pg";
import { ApiError } from "./context.ts";

export const RATE_SCOPES = [
  "rl:source",
  "rl:session",
  "rl:credential",
  "rl:reveal",
  "rl:import",
  "rl:export",
  "rl:issue",
  "rl:machine-miss",
  // Session 11 (P-196, D-83): exchanges of one runtime credential, and
  // requests of one automation credential (enforced from Run 11.5).
  "rl:exchange",
  "rl:automation",
] as const;
export type RateScope = (typeof RATE_SCOPES)[number];

const WINDOW_SECONDS = 60;

const PRODUCT_LIMITS: Readonly<Record<RateScope, number>> = {
  "rl:source": LIMITS.rate.perSourcePerMinute,
  "rl:session": LIMITS.rate.perSessionPerMinute,
  "rl:credential": LIMITS.rate.perMachineCredentialPerMinute,
  "rl:reveal": LIMITS.rate.revealPerMinute,
  "rl:import": LIMITS.rate.importExportPerMinute,
  "rl:export": LIMITS.rate.importExportPerMinute,
  "rl:issue": LIMITS.rate.credentialIssuePerMinute,
  "rl:machine-miss": LIMITS.rate.machineMissesPerSourcePerMinute,
  "rl:exchange": LIMITS.rate.exchangePerCredentialPerMinute,
  "rl:automation": LIMITS.rate.perAutomationCredentialPerMinute,
};

/** The product's limit of a scope per minute. */
export function scopeLimit(scope: RateScope): number {
  return PRODUCT_LIMITS[scope];
}

/** The routes with a limit of their own, counted per person after authorization. */
export const ROUTE_CLASS_LIMIT: Readonly<Record<string, { scope: RateScope; perMinute: number }>> =
  {
    "secrets.reveal": { scope: "rl:reveal", perMinute: PRODUCT_LIMITS["rl:reveal"] },
    "import.preview": { scope: "rl:import", perMinute: PRODUCT_LIMITS["rl:import"] },
    "import.apply": { scope: "rl:import", perMinute: PRODUCT_LIMITS["rl:import"] },
    "import.resume": { scope: "rl:import", perMinute: PRODUCT_LIMITS["rl:import"] },
    "export.create": { scope: "rl:export", perMinute: PRODUCT_LIMITS["rl:export"] },
    "credentials.issue": { scope: "rl:issue", perMinute: PRODUCT_LIMITS["rl:issue"] },
    // Session 11: every issuance a person can make shares the one limit.
    "runtime_credentials.issue": { scope: "rl:issue", perMinute: PRODUCT_LIMITS["rl:issue"] },
    "automation_credentials.issue": { scope: "rl:issue", perMinute: PRODUCT_LIMITS["rl:issue"] },
  };

/**
 * Routes that reduce exposure are not held by the session limit (they are by
 * the source limit): revoking a credential and archiving. Sign-out and session
 * revocation are routes of the auth module, which has no session step.
 */
export const SESSION_EXEMPT: ReadonlySet<string> = new Set([
  "credentials.revoke",
  // Session 11 (review L2): an automation credential is revoked on a route of its own.
  "automation_credentials.revoke",
  "projects.archive",
  "environments.archive",
]);

export interface RateLimiter {
  /** Counts one request; throws 429 over the limit, 503 when the counter cannot be written. */
  hit(scope: RateScope, subject: string): Promise<void>;
  /** The current window's count without counting (the machine-miss check). */
  count(scope: RateScope, subject: string): Promise<number>;
  /** The limit this limiter applies to a scope. */
  limit(scope: RateScope): number;
}

export function createRateLimiter(deps: {
  pool: pg.Pool;
  ring: KeyRing;
  /** Tests only: wider limits for suites that are not about limits. */
  limits?: Partial<Record<RateScope, number>>;
}): RateLimiter {
  const digest = (scope: RateScope, subject: string): Buffer =>
    throttleDigest(ringKey(deps.ring), scope, subject);
  const limit = (scope: RateScope): number => deps.limits?.[scope] ?? PRODUCT_LIMITS[scope];
  return {
    limit,
    async hit(scope, subject) {
      let bumped: { count: number; secondsLeft: number };
      try {
        bumped = await bumpCounter(deps.pool, scope, digest(scope, subject), WINDOW_SECONDS);
      } catch {
        throw new ApiError("dependency_unavailable", "rate_counter");
      }
      if (bumped.count > limit(scope)) {
        throw new ApiError("rate_limited", scope, {
          "retry-after": String(Math.min(WINDOW_SECONDS, Math.max(1, bumped.secondsLeft))),
        });
      }
    },
    async count(scope, subject) {
      try {
        return await sumCounters(deps.pool, scope, digest(scope, subject), WINDOW_SECONDS, 1);
      } catch {
        throw new ApiError("dependency_unavailable", "rate_counter");
      }
    },
  };
}

/** Seconds left of the current 60-second window (windows are cut from the epoch, D-28). */
export function windowSecondsLeft(nowMs: number): number {
  return WINDOW_SECONDS - (Math.floor(nowMs / 1000) % WINDOW_SECONDS);
}
