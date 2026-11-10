import { ERROR_CODES, errorEnvelopeSchema } from "@mykey/contracts";
import { describe, expect, it } from "vitest";

const TABLE: Record<number, string[]> = {
  400: [
    "malformed_request",
    "forbidden_selector",
    "mixed_authentication",
    "unsupported_history_parameter",
  ],
  401: ["unauthenticated", "mfa_incomplete"],
  403: ["action_denied", "origin_rejected", "fresh_verification_required"],
  404: ["not_found"],
  409: [
    "version_conflict",
    "already_exists",
    "state_conflict",
    "key_under_review",
    "environment_changed",
    "listing_changed",
    "idempotency_conflict",
    "replay_expired",
    "credential_not_replayable",
  ],
  422: ["validation_failed", "precondition_required"],
  429: ["rate_limited"],
  503: [
    "busy",
    "outcome_unknown",
    "backend_inconsistent",
    "backend_sealed",
    "quarantined",
    "audit_unavailable",
    "dependency_unavailable",
  ],
  507: ["capacity_exceeded"],
};

/** The ten codes Documents 04 and 06 name literally. */
const SPEC_NAMED: Record<string, number> = {
  fresh_verification_required: 403,
  not_found: 404,
  environment_changed: 409,
  listing_changed: 409,
  idempotency_conflict: 409,
  replay_expired: 409,
  credential_not_replayable: 409,
  busy: 503,
  outcome_unknown: 503,
  backend_inconsistent: 503,
};

const requestId = "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e7f";

describe("error codes", () => {
  it("are exactly the D-14 table, each with its HTTP status", () => {
    const expected = Object.fromEntries(
      Object.entries(TABLE).flatMap(([status, codes]) =>
        codes.map((code) => [code, { status: Number(status) }]),
      ),
    );
    expect(ERROR_CODES).toEqual(expected);
    expect(Object.keys(ERROR_CODES)).toHaveLength(30);
  });

  it("keep the exact status of each spec-named code", () => {
    expect(Object.keys(SPEC_NAMED)).toHaveLength(10);
    for (const [code, status] of Object.entries(SPEC_NAMED)) {
      expect(ERROR_CODES[code as keyof typeof ERROR_CODES], code).toEqual({ status });
    }
  });
});

describe("error envelope", () => {
  it("accepts the minimal and the full envelope", () => {
    const minimal = { error: { code: "not_found", message: "Not found.", requestId } };
    expect(errorEnvelopeSchema.parse(minimal)).toEqual(minimal);
    const full = {
      error: {
        code: "outcome_unknown",
        message: "The outcome is not known yet.",
        requestId,
        operationId: "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e80",
        details: { retryAfterSeconds: 5 },
      },
    };
    expect(errorEnvelopeSchema.parse(full)).toEqual(full);
  });

  it("rejects an unknown code, a missing requestId and unknown keys", () => {
    const base = { code: "not_found", message: "Not found.", requestId };
    const bad: unknown[] = [
      { error: { ...base, code: "teapot" } },
      { error: { code: base.code, message: base.message } },
      { error: { ...base, requestId: "" } },
      { error: base, extra: true },
      { error: { ...base, stack: "at handler" } },
      { error: { ...base, message: 42 } },
      {},
      null,
    ];
    for (const candidate of bad) {
      expect(errorEnvelopeSchema.safeParse(candidate).success, JSON.stringify(candidate)).toBe(
        false,
      );
    }
  });
});
