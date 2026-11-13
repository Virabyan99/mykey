// The one envelope builder (Doc 06 §9). The message of an error comes from the
// table below, keyed by code — never from an exception — so no internal text
// can reach a client. Every response carries Cache-Control: no-store.
import { ERROR_CODES, type ErrorCode } from "@mykey/contracts";
import { z } from "zod";

export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  malformed_request: "The request is malformed.",
  forbidden_selector: "The request names a backend location, which is not allowed.",
  mixed_authentication: "Send either a session cookie or a bearer token, not both.",
  unsupported_history_parameter: "This history parameter is not supported.",
  unauthenticated: "Authentication is required.",
  mfa_incomplete: "The second factor has not been completed.",
  action_denied: "You may not do this here.",
  origin_rejected: "The request did not come from this site.",
  fresh_verification_required: "A recent second-factor verification is required.",
  not_found: "Not found.",
  version_conflict: "The secret has changed since it was read.",
  already_exists: "That name is already in use.",
  state_conflict: "This is not possible in the current state.",
  key_under_review: "This secret is under review.",
  environment_changed: "The environment has changed.",
  listing_changed: "The list has changed; start again from the first page.",
  idempotency_conflict: "This idempotency key was used for a different request.",
  replay_expired: "The record of this request has expired.",
  credential_not_replayable: "A credential is shown only once and cannot be replayed.",
  validation_failed: "A value in the request is not valid.",
  precondition_required: "A required request header is missing or invalid.",
  rate_limited: "Too many attempts. Try again later.",
  busy: "The service is busy. Try again shortly.",
  outcome_unknown: "The outcome is not known yet.",
  backend_inconsistent: "This needs review before it can be used.",
  backend_sealed: "The secret store is sealed.",
  quarantined: "The service is not open.",
  audit_unavailable: "The action was not performed because it could not be recorded.",
  dependency_unavailable: "A dependency is unavailable. Try again later.",
  capacity_exceeded: "The environment is full.",
});

const NO_STORE = { "cache-control": "no-store" } as const;

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const merged = new Headers(headers);
  merged.set("content-type", "application/json; charset=utf-8");
  merged.set("cache-control", NO_STORE["cache-control"]);
  return new Response(JSON.stringify(body), { status, headers: merged });
}

/**
 * The details an error may carry, by code (Run 4.1): an allowlist. A key
 * outside a schema is stripped; details that fail their schema, or details on
 * a code that takes none, are dropped.
 */
const DETAILS: Partial<Record<ErrorCode, z.ZodType<Record<string, unknown>>>> = {
  version_conflict: z.object({
    currentVersion: z.int().positive(),
    currentStateTag: z.string().min(1).max(64),
    state: z.enum(["live", "deleted"]),
  }),
  capacity_exceeded: z.object({ limit: z.enum(["names", "bytes", "response"]) }),
};

/** The details of `code` as they may be sent; `valid` is false when some were dropped as invalid. */
export function checkDetails(
  code: ErrorCode,
  details: Record<string, unknown> | undefined,
): { valid: boolean; details: Record<string, unknown> | undefined } {
  if (details === undefined) return { valid: true, details: undefined };
  const schema = DETAILS[code];
  if (schema === undefined) return { valid: false, details: undefined };
  const parsed = schema.safeParse(details);
  return parsed.success
    ? { valid: true, details: parsed.data }
    : { valid: false, details: undefined };
}

export interface ErrorExtra {
  operationId?: string;
  details?: Record<string, unknown>;
}

export function errorResponse(
  code: ErrorCode,
  requestId: string,
  headers?: Record<string, string>,
  extra: ErrorExtra = {},
): Response {
  const { details } = checkDetails(code, extra.details);
  return jsonResponse(
    ERROR_CODES[code].status,
    {
      error: {
        code,
        message: ERROR_MESSAGES[code],
        requestId,
        ...(extra.operationId === undefined ? {} : { operationId: extra.operationId }),
        ...(details === undefined ? {} : { details }),
      },
    },
    headers,
  );
}
