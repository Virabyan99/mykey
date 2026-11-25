// Run 6.3 Task A (P-113, FR-1.60): the rate limiter's table and its answers.
// The counters themselves are PostgreSQL's (tests/integration/limits); here
// only what the limiter makes of a count, and of a counter it cannot write.
import { LIMITS, ROUTES } from "@mykey/contracts";
import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  ApiError,
  RATE_SCOPES,
  ROUTE_CLASS_LIMIT,
  SESSION_EXEMPT,
  createRateLimiter,
  scopeLimit,
} from "@mykey/api";

const ring = { current: "k1", keys: { k1: new Uint8Array(32).fill(7) } };

/** A pool whose one statement answers `count` with `secondsLeft`, or fails. */
function poolAnswering(answer: { count: number; secondsLeft: number } | Error): pg.Pool {
  return {
    query: () =>
      answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve({
            rows: [{ count: answer.count, seconds_left: answer.secondsLeft, total: answer.count }],
          }),
  } as unknown as pg.Pool;
}

async function codeOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("no refusal");
}

describe("the table (P-113)", () => {
  it("each scope's limit is a number of LIMITS.rate", () => {
    expect(Object.fromEntries(RATE_SCOPES.map((scope) => [scope, scopeLimit(scope)]))).toEqual({
      "rl:source": LIMITS.rate.perSourcePerMinute,
      "rl:session": LIMITS.rate.perSessionPerMinute,
      "rl:credential": LIMITS.rate.perMachineCredentialPerMinute,
      "rl:reveal": LIMITS.rate.revealPerMinute,
      "rl:import": LIMITS.rate.importExportPerMinute,
      "rl:export": LIMITS.rate.importExportPerMinute,
      "rl:issue": LIMITS.rate.credentialIssuePerMinute,
      "rl:machine-miss": LIMITS.rate.machineMissesPerSourcePerMinute,
    });
  });

  it("route classes: reveal 30, the three import routes share one 5, export 5, both issuances of a person share one 5", () => {
    expect(ROUTE_CLASS_LIMIT).toEqual({
      "secrets.reveal": { scope: "rl:reveal", perMinute: 30 },
      "import.preview": { scope: "rl:import", perMinute: 5 },
      "import.apply": { scope: "rl:import", perMinute: 5 },
      "import.resume": { scope: "rl:import", perMinute: 5 },
      "export.create": { scope: "rl:export", perMinute: 5 },
      "credentials.issue": { scope: "rl:issue", perMinute: 5 },
      "runtime_credentials.issue": { scope: "rl:issue", perMinute: 5 },
    });
    const ids = new Set(ROUTES.map((route) => route.id));
    for (const id of [...Object.keys(ROUTE_CLASS_LIMIT), ...SESSION_EXEMPT]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("only revocation and archive skip the session limit", () => {
    expect([...SESSION_EXEMPT].sort()).toEqual([
      "credentials.revoke",
      "environments.archive",
      "projects.archive",
    ]);
  });
});

describe("the answers", () => {
  it("the request at the limit passes; the next is 429 with retry-after = the window's seconds left", async () => {
    const at = createRateLimiter({ pool: poolAnswering({ count: 300, secondsLeft: 17 }), ring });
    await expect(at.hit("rl:source", "198.51.100.7")).resolves.toBeUndefined();
    const over = createRateLimiter({ pool: poolAnswering({ count: 301, secondsLeft: 17 }), ring });
    const refused = await codeOf(over.hit("rl:source", "198.51.100.7"));
    expect(refused.code).toBe("rate_limited");
    expect(refused.reason).toBe("rl:source");
    expect(refused.headers).toEqual({ "retry-after": "17" });
  });

  it("a counter that cannot be written or read is 503 dependency_unavailable, never a pass", async () => {
    const broken = createRateLimiter({
      pool: poolAnswering(Object.assign(new Error("denied"), { code: "42501" })),
      ring,
    });
    expect((await codeOf(broken.hit("rl:session", "s"))).code).toBe("dependency_unavailable");
    expect((await codeOf(broken.count("rl:machine-miss", "s"))).code).toBe(
      "dependency_unavailable",
    );
  });

  it("widened limits apply only to the scopes named", async () => {
    const wide = createRateLimiter({
      pool: poolAnswering({ count: 301, secondsLeft: 5 }),
      ring,
      limits: { "rl:source": 10_000 },
    });
    await expect(wide.hit("rl:source", "x")).resolves.toBeUndefined();
    expect((await codeOf(wide.hit("rl:session", "x"))).code).toBe("rate_limited");
  });
});
