// Archive and reactivate (Run 5.3, P-91, P-92, D-41). Archive is admitted in
// one transaction and driven inside the request as far as it goes: 200 when
// it finished, 202 with the envelope when the tick must continue it.
import type { ErrorCode, OperationId } from "@mykey/contracts";
import { decide } from "@mykey/contracts";
import { findOperation, lockParents, resolveAccess, type ProjectScope } from "@mykey/db";
import {
  beginArchive,
  driveArchive,
  operationResponse,
  reactivate,
  replayAnswer,
  type LifecycleDeps,
} from "@mykey/operations";
import type pg from "pg";
import { now } from "../log.ts";
import { ApiError, type ApiContext, type AppDeps, type Handler } from "../pipeline/context.ts";
import { intentOf } from "../pipeline/route.ts";
import { checkStates } from "../pipeline/states.ts";

/** The lifecycle protocol's dependencies; a process without the issuer identity answers 503. */
export function lifecycleDeps(deps: AppDeps): LifecycleDeps {
  const ring = deps.auth?.keys.replayFingerprint;
  if (deps.issuer === undefined || deps.lockPool === undefined || ring === undefined) {
    throw new ApiError("dependency_unavailable");
  }
  const faults = deps.test?.faults;
  return {
    pool: deps.pool,
    lockPool: deps.lockPool,
    issuer: deps.issuer,
    bootId: deps.bootId,
    ring,
    gateOpen: () => deps.gate?.open() === true,
    ...(deps.bao === undefined ? {} : { bao: deps.bao }),
    ...(faults === undefined ? {} : { faults: (point, operationId) => faults(point, operationId) }),
  };
}

type Scope = ProjectScope & { environmentId?: string };

/** Authority and the organization's state, re-read in the admission transaction. */
export function lifecycleRecheck(ctx: ApiContext, userId: string, scope: Scope) {
  return async (tx: pg.PoolClient): Promise<ErrorCode | null> => {
    await lockParents(tx, scope, null);
    const resolved = await resolveAccess(tx, userId as never, {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      ...(scope.environmentId === undefined ? {} : { environmentId: scope.environmentId }),
    });
    if (
      resolved.authority === null ||
      resolved.organization === null ||
      resolved.project === null ||
      (scope.environmentId !== undefined && resolved.environment === null)
    ) {
      return "not_found";
    }
    const decision = decide(
      resolved.authority,
      {
        projectId: scope.projectId,
        ...(scope.environmentId === undefined ? {} : { environmentId: scope.environmentId }),
      },
      ctx.route.action,
    );
    if (decision === "hidden") return "not_found";
    if (decision === "denied") return "action_denied";
    return checkStates(ctx.route, resolved);
  };
}

function refusal(code: ErrorCode, operationId?: OperationId): ApiError {
  return new ApiError(code, undefined, undefined, {
    ...(operationId === undefined ? {} : { operationId }),
  });
}

function lifecycleRequest(ctx: ApiContext) {
  const principal = ctx.principal;
  const scope = ctx.scope as Scope | null;
  const key = ctx.idempotencyKey;
  if (principal === null || scope === null || key === null) {
    throw new ApiError("dependency_unavailable");
  }
  return {
    routeId: ctx.route.id,
    kind: scope.environmentId === undefined ? ("project" as const) : ("environment" as const),
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    ...(scope.environmentId === undefined ? {} : { environmentId: scope.environmentId as never }),
    userId: principal.userId,
    idempotencyKey: key,
    intent: intentOf(ctx.route, ctx.params, principal, ctx.body),
    requestId: ctx.requestId,
    recheck: lifecycleRecheck(ctx, principal.userId, scope),
  };
}

export const archiveHandler: Handler = async (ctx, deps) => {
  const lifecycle = lifecycleDeps(deps);
  const start = await beginArchive(lifecycle, lifecycleRequest(ctx));
  if (start.kind === "refused") throw refusal(start.code, start.operationId);
  if (start.kind === "replay") {
    const answer = replayAnswer(ctx.route, start.operation);
    if (!("error" in answer)) return answer;
    throw refusal(answer.error, answer.operationId);
  }
  const operationId = start.operation.id;
  // The admission is committed. Whatever stops the drive from here on, the
  // answer names the operation: the tick continues it, and the owner can look
  // it up or send the same request again (Session 5's carried finding).
  let driven: "archived" | "waiting";
  try {
    await lifecycle.faults?.("archive_after_marker", operationId);
    driven = await driveArchive(lifecycle, operationId);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    deps.log({
      event: "unhandled",
      time: now(),
      requestId: ctx.requestId,
      routeId: ctx.route.id,
      errorClass: error instanceof Error ? error.constructor.name : "unknown",
    });
    throw refusal("dependency_unavailable", operationId);
  }
  const current = await findOperation(deps.pool, operationId);
  if (current === null) throw new ApiError("dependency_unavailable");
  return { status: driven === "archived" ? 200 : 202, body: operationResponse(current) };
};

/** Reads only, then one transaction (P-92): 200 with the envelope, or the refusal. */
export const reactivateHandler: Handler = async (ctx, deps) => {
  const outcome = await reactivate(lifecycleDeps(deps), lifecycleRequest(ctx));
  if (outcome.kind === "refused") throw refusal(outcome.code, outcome.operationId);
  if (outcome.kind === "replay") {
    const answer = replayAnswer(ctx.route, outcome.operation);
    if (!("error" in answer)) return answer;
    throw refusal(answer.error, answer.operationId);
  }
  return { status: 200, body: operationResponse(outcome.operation) };
};
