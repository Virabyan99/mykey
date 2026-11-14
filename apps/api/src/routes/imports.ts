// Import routes (Run 4.7, P-76, Doc 06 §8 "Import"). The preview classifies a
// dotenv file against the index and stores no value; apply and resume write it
// entry by entry through the mutation protocol. Every one of them runs inside
// the process's large-request gate. A handler maps the outcome to an answer.
import { LIMITS, decide } from "@mykey/contracts";
import type { EnvironmentScope } from "@mykey/db";
import {
  applyImport,
  operationResponse,
  previewImport,
  replayAnswer,
  type ImportOutcome,
} from "@mykey/operations";
import type { LargeGate } from "../large.ts";
import {
  ApiError,
  type ApiContext,
  type AppDeps,
  type Handler,
  type HandlerResult,
} from "../pipeline/context.ts";
import { intentOf } from "../pipeline/route.ts";
import { effectDeps, readDeps, recheckOf, refusedOf } from "./secrets.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * How long one request applies entries before it answers 202 and the import
 * waits for a resume: the large-request deadline less a margin for the
 * entry in flight and the answer.
 */
export const IMPORT_BUDGET_MS = LIMITS.deadlines.largeRequestMs - 20_000;

const budgetOf = (deps: AppDeps): number => deps.test?.importBudgetMs?.() ?? IMPORT_BUDGET_MS;

/** An import's outcome as an answer: finished 200, waiting 202, a replay as stored. */
function answerOf(ctx: ApiContext, outcome: ImportOutcome): HandlerResult {
  switch (outcome.kind) {
    case "finished":
      return { status: 200, body: operationResponse(outcome.operation) };
    case "waiting":
      return { status: 202, body: operationResponse(outcome.operation) };
    case "replay": {
      const answer = replayAnswer(ctx.route, outcome.operation);
      if ("error" in answer) {
        throw new ApiError(answer.error, "replay", undefined, {
          ...(answer.operationId === undefined ? {} : { operationId: answer.operationId }),
        });
      }
      return answer;
    }
    case "unknown":
      throw new ApiError("outcome_unknown", undefined, undefined, {
        operationId: outcome.operationId,
      });
    case "refused":
      return refusedOf(outcome);
  }
}

/** import.preview: 200 with the classification, or a refusal; nothing is written to the backend. */
export function importPreviewHandler(large: LargeGate): Handler {
  return (ctx, deps) =>
    large.run(async () => {
      const scope = ctx.scope as EnvironmentScope | null;
      const principal = ctx.principal;
      const ring = deps.auth?.keys.replayFingerprint;
      if (scope === null || principal === null || ring === undefined) {
        throw new ApiError("dependency_unavailable");
      }
      const target = { projectId: scope.projectId, environmentId: scope.environmentId };
      const outcome = await previewImport(
        { ...readDeps(deps), ring },
        {
          scope,
          userId: principal.userId,
          mayRead: decide(ctx.authority, target, "secrets.read") === "allow",
          bytes: ctx.body as Uint8Array,
          requestId: ctx.requestId,
          recheck: recheckOf(ctx, principal.userId, scope),
        },
      );
      if (outcome.kind === "refused") refusedOf(outcome);
      return { status: 200, body: outcome.body };
    });
}

/** import.apply: the previewed file, entry by entry; 200 finished, 202 waiting, 503 unknown. */
export function importApplyHandler(large: LargeGate): Handler {
  return (ctx, deps) =>
    large.run(async () => {
      const scope = ctx.scope as EnvironmentScope | null;
      const principal = ctx.principal;
      const key = ctx.idempotencyKey;
      if (scope === null || principal === null || key === null) {
        throw new ApiError("dependency_unavailable");
      }
      const previewId = ctx.params.preview ?? "";
      if (!UUID.test(previewId)) throw new ApiError("not_found");
      const outcome = await applyImport(effectDeps(deps), {
        scope,
        userId: principal.userId,
        previewId,
        bytes: ctx.body as Uint8Array,
        idempotencyKey: key,
        intent: intentOf(ctx.route, ctx.params, principal, ctx.body),
        requestId: ctx.requestId,
        budgetMs: budgetOf(deps),
        recheck: recheckOf(ctx, principal.userId, scope),
      });
      return answerOf(ctx, outcome);
    });
}
