// Secret mutations (Run 4.2, D-36): each handler builds a SecretRequest and
// hands it to the protocol of @mykey/operations, which owns the lock, the
// operation record, the one change and its proof. A handler only maps the
// outcome to an answer. Values never reach a log line or an error.
import {
  checkSecretName,
  decide,
  type ErrorCode,
  type OperationId,
  type UserId,
} from "@mykey/contracts";
import { lockParents, resolveAccess, type EnvironmentScope } from "@mykey/db";
import {
  operationResponse,
  readGate,
  replayAnswer,
  runSecretAction,
  type EffectDeps,
  type SecretAction,
  type SecretOutcome,
  type SecretRequest,
} from "@mykey/operations";
import type pg from "pg";
import {
  ApiError,
  type ApiContext,
  type AppDeps,
  type Handler,
  type HandlerResult,
} from "../pipeline/context.ts";
import { intentOf } from "../pipeline/route.ts";
import { checkStates } from "../pipeline/states.ts";

/** The protocol's dependencies; a process without the runtime identity answers 503. */
function effectDeps(deps: AppDeps): EffectDeps {
  const ring = deps.auth?.keys.replayFingerprint;
  if (deps.bao === undefined || deps.lockPool === undefined || ring === undefined) {
    throw new ApiError("dependency_unavailable");
  }
  const faults = deps.test?.faults;
  return {
    pool: deps.pool,
    lockPool: deps.lockPool,
    bao: deps.bao,
    bootId: deps.bootId,
    ring,
    gateOpen: () => readGate(deps.config.gatePath, deps.config.hostInstanceId).open,
    ...(faults === undefined ? {} : { faults }),
  };
}

/**
 * The admission recheck (FR-1.10): the parents locked FOR SHARE, then the
 * caller's authority and the states read again from the rows now locked.
 */
function recheckOf(ctx: ApiContext, userId: UserId, scope: EnvironmentScope) {
  return async (tx: pg.PoolClient): Promise<ErrorCode | null> => {
    await lockParents(tx, scope, null);
    const resolved = await resolveAccess(tx, userId, {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    });
    if (
      resolved.authority === null ||
      resolved.organization === null ||
      resolved.project === null ||
      resolved.environment === null
    ) {
      return "not_found";
    }
    const decision = decide(
      resolved.authority,
      { projectId: scope.projectId, environmentId: scope.environmentId },
      ctx.route.action,
    );
    if (decision === "hidden") return "not_found";
    if (decision === "denied") return "action_denied";
    return checkStates(ctx.route, resolved);
  };
}

function answerOf(ctx: ApiContext, outcome: SecretOutcome): HandlerResult {
  const operationOf = (id: OperationId | undefined) =>
    id === undefined ? {} : { operationId: id };
  switch (outcome.kind) {
    case "succeeded":
      return {
        status: 201 in ctx.route.responses ? 201 : 200,
        body: operationResponse(outcome.operation),
      };
    case "replay": {
      const answer = replayAnswer(ctx.route, outcome.operation);
      if ("error" in answer) {
        throw new ApiError(answer.error, "replay", undefined, operationOf(answer.operationId));
      }
      return answer;
    }
    case "refused":
      throw new ApiError(outcome.code, undefined, undefined, {
        ...operationOf(outcome.operationId),
        ...(outcome.details === undefined ? {} : { details: outcome.details }),
      });
    case "unknown":
      throw new ApiError("outcome_unknown", undefined, undefined, {
        operationId: outcome.operationId,
      });
  }
}

/** The common part of every secret mutation. */
async function mutate(
  ctx: ApiContext,
  deps: AppDeps,
  action: SecretAction,
  name: string,
  fields: Pick<SecretRequest, "value" | "expected" | "sourceVersion">,
): Promise<HandlerResult> {
  const principal = ctx.principal;
  const scope = ctx.scope as EnvironmentScope | null;
  const key = ctx.idempotencyKey;
  if (principal === null || scope === null || key === null) {
    throw new ApiError("dependency_unavailable");
  }
  const outcome = await runSecretAction(effectDeps(deps), {
    action,
    routeId: ctx.route.id,
    scope,
    userId: principal.userId,
    name,
    ...fields,
    idempotencyKey: key,
    intent: intentOf(ctx.route, ctx.params, principal, ctx.body),
    requestId: ctx.requestId,
    recheck: recheckOf(ctx, principal.userId, scope),
  });
  return answerOf(ctx, outcome);
}

/** A `:name` that is not a valid name names nothing: 404, as an absent one. */
export function nameParam(ctx: ApiContext): string {
  const name = ctx.params.name ?? "";
  if (!checkSecretName(name).ok) throw new ApiError("not_found");
  return name;
}

export const secretsCreateHandler: Handler = (ctx, deps) => {
  const body = ctx.body as { name: string; value: string };
  return mutate(ctx, deps, "create", body.name, { value: body.value });
};
