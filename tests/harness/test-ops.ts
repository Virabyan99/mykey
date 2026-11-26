// A test-only idempotent route (Run 4.1 Task B): it stores an operation in the
// state its body names and answers from it, as a replay would. Used by the
// replay and status suites of tests/integration/operations.
import { z } from "zod";
import { ApiError, intentOf, type Handler } from "@mykey/api";
import { operationResponseSchema, type RouteDef } from "@mykey/contracts";
import { findOperation, withTransaction } from "@mykey/db";
import { beginOperation, replayAnswer } from "@mykey/operations";

export const STATES = [
  "accepted",
  "executing",
  "awaiting_input",
  "uncertain",
  "succeeded",
  "partial",
  "rejected",
] as const;

const body = z.strictObject({
  state: z.enum(STATES),
  errorCode: z.enum(["state_conflict", "credential_not_replayable"]).optional(),
});

export const TEST_OPS: RouteDef = {
  id: "test.ops",
  method: "POST",
  path: "/v1/organizations/:org/projects/:project/environments/:env/test-ops/:name",
  auth: "human",
  idempotent: true,
  ownerRun: "test",
  pending: false,
  request: { body },
  responses: { 200: operationResponseSchema, 202: operationResponseSchema },
  errors: [
    "malformed_request",
    "rate_limited",
    "busy",
    "quarantined",
    "mixed_authentication",
    "unauthenticated",
    "mfa_incomplete",
    "action_denied",
    "dependency_unavailable",
    "origin_rejected",
    "not_found",
    "validation_failed",
    "precondition_required",
    "idempotency_conflict",
    "replay_expired",
    "outcome_unknown",
    "audit_unavailable",
    "state_conflict",
    "backend_inconsistent",
  ],
  action: "secrets.write",
  scope: "environment",
  right: null,
};

/** Inserts the operation in the state the body names and answers from it, as a replay would. */
export const testOpsHandler: Handler = async (ctx, deps) => {
  const ring = deps.auth?.keys.replayFingerprint;
  if (
    ctx.principal === null ||
    ctx.scope === null ||
    ring === undefined ||
    ctx.idempotencyKey === null
  ) {
    throw new ApiError("dependency_unavailable");
  }
  const requested = ctx.body as z.infer<typeof body>;
  const intent = intentOf(ctx.route, ctx.params, ctx.principal, ctx.body);
  const begin = await withTransaction(deps.pool, async (tx) => {
    const started = await beginOperation(tx, ring, {
      principalKind: "user",
      principalId: intent.principalId,
      action: intent.action,
      target: intent.target,
      ...(intent.params === undefined ? {} : { params: intent.params }),
      idempotencyKey: ctx.idempotencyKey ?? "",
      organizationId: ctx.scope!.organizationId,
      ...("environmentId" in ctx.scope!
        ? { projectId: ctx.scope.projectId, environmentId: ctx.scope.environmentId }
        : {}),
      body: ctx.body,
    });
    if (started.kind !== "fresh") return started;
    const terminal = ["succeeded", "partial", "rejected"].includes(requested.state);
    await tx.query(
      `UPDATE app.operation SET state = $2, error_code = $3,
              result = CASE WHEN $2 IN ('succeeded', 'partial') THEN '{"ok":true}'::jsonb END,
              completed_at = CASE WHEN $4 THEN now() END,
              replay_expires_at = CASE WHEN $4 THEN now() + interval '30 days' END
        WHERE id = $1`,
      [started.operationId, requested.state, requested.errorCode ?? null, terminal],
    );
    return started;
  });
  if (begin.kind === "conflict") throw new ApiError("idempotency_conflict");
  const id = begin.kind === "fresh" ? begin.operationId : begin.operation.id;
  const row = await findOperation(deps.pool, id);
  if (row === null) throw new ApiError("dependency_unavailable");
  const answer = replayAnswer(ctx.route, row);
  if ("error" in answer) {
    throw new ApiError(answer.error, undefined, undefined, {
      ...(answer.operationId === undefined ? {} : { operationId: answer.operationId }),
    });
  }
  return answer;
};
