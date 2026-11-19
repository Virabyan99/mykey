// Run 6.3 (P-113): the limiter of a test API. Every request passes through a
// real limiter on the fixture's database; suites that are not about limits
// run with limits so wide that they never refuse, and the suites about limits
// ask for the product's ("product").
import { RATE_SCOPES, createRateLimiter, type RateLimiter, type RateScope } from "@mykey/api";
import type { KeyRing } from "@mykey/auth";
import type pg from "pg";

export type RateLimitsMode = "product" | "wide";

export const WIDE_RATE_LIMITS: Readonly<Record<RateScope, number>> = Object.fromEntries(
  RATE_SCOPES.map((scope) => [scope, 1_000_000]),
) as Record<RateScope, number>;

export function testLimiter(
  pool: pg.Pool,
  ring: KeyRing,
  mode: RateLimitsMode = "wide",
): RateLimiter {
  return createRateLimiter({
    pool,
    ring,
    ...(mode === "product" ? {} : { limits: WIDE_RATE_LIMITS }),
  });
}
