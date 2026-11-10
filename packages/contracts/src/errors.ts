// The error envelope and the complete code list (Doc 04 §8.1, Doc 06 §9, D-14).
// A handler may return only a code listed here, with exactly this status.
import { z } from "zod";
import { operationIdSchema, requestIdSchema } from "./ids.ts";

const CODES = {
  malformed_request: { status: 400 },
  forbidden_selector: { status: 400 },
  mixed_authentication: { status: 400 },
  unsupported_history_parameter: { status: 400 },
  unauthenticated: { status: 401 },
  mfa_incomplete: { status: 401 },
  action_denied: { status: 403 },
  origin_rejected: { status: 403 },
  fresh_verification_required: { status: 403 },
  not_found: { status: 404 },
  version_conflict: { status: 409 },
  already_exists: { status: 409 },
  state_conflict: { status: 409 },
  key_under_review: { status: 409 },
  environment_changed: { status: 409 },
  listing_changed: { status: 409 },
  idempotency_conflict: { status: 409 },
  replay_expired: { status: 409 },
  credential_not_replayable: { status: 409 },
  validation_failed: { status: 422 },
  precondition_required: { status: 422 },
  rate_limited: { status: 429 },
  busy: { status: 503 },
  outcome_unknown: { status: 503 },
  backend_inconsistent: { status: 503 },
  backend_sealed: { status: 503 },
  quarantined: { status: 503 },
  audit_unavailable: { status: 503 },
  dependency_unavailable: { status: 503 },
  capacity_exceeded: { status: 507 },
} as const;

export type ErrorCode = keyof typeof CODES;

for (const entry of Object.values(CODES)) Object.freeze(entry);
export const ERROR_CODES: Readonly<Record<ErrorCode, { readonly status: number }>> =
  Object.freeze(CODES);

export const ERROR_CODE_NAMES = Object.freeze(Object.keys(CODES) as ErrorCode[]);

export const errorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(ERROR_CODE_NAMES),
    message: z.string().min(1),
    requestId: requestIdSchema,
    operationId: operationIdSchema.optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
