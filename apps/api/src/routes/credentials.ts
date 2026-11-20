// Machine credentials (Run 5.1, P-86 … P-88, D-40). Issuance hands the
// request to the protocol of @mykey/operations, which owns the lock, the
// record, the one create and its proof; the token leaves only in the 201 this
// handler builds. The inventory reads the catalog only and never shows an
// accessor or a token.
import { LIMITS, credentialIdSchema, type OperationId } from "@mykey/contracts";
import {
  AuditReadTimeout,
  findCredentialByOperation,
  listCredentials,
  readCredentialsSummary,
  type CredentialRow,
  type EnvironmentScope,
  type Queryable,
} from "@mykey/db";
import {
  issueCredential,
  operationResponse,
  replayAnswer,
  revokeCredential,
  type CredentialDeps,
  type IssueOutcome,
} from "@mykey/operations";
import { readCursor, signCursor } from "../pipeline/cursor.ts";
import { ApiError, type ApiContext, type AppDeps, type Handler } from "../pipeline/context.ts";
import { intentOf } from "../pipeline/route.ts";
import { recheckOf } from "./secrets.ts";

/** The protocol's dependencies; a process without the issuer identity answers 503. */
export function credentialDeps(deps: AppDeps): CredentialDeps {
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
    ...(faults === undefined
      ? {}
      : { faults: (point, operationId) => faults(point, operationId ?? "") }),
  };
}

/** The inventory's shape of a credential (P-86): an `active` row past its expiry reads `expired`. */
export function credentialView(row: CredentialRow) {
  return {
    credentialId: row.id,
    name: row.name,
    projectId: row.projectId,
    environmentId: row.environmentId,
    state: row.state === "active" && row.expired ? ("expired" as const) : row.state,
    issuedBy: row.issuedBy,
    issuedAt: row.issuedAt === null ? null : row.issuedAt.toISOString(),
    expiresAt: row.effectiveExpiresAt === null ? null : row.effectiveExpiresAt.toISOString(),
    expiringSoon: row.expiringSoon,
    lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.toISOString(),
  };
}

/**
 * The details of `credential_not_replayable` (P-88): the credential the
 * replayed issuance made and its state now. Absent when the row is not found.
 */
export async function notReplayable(db: Queryable, operationId: OperationId): Promise<ApiError> {
  const credential = await findCredentialByOperation(db, operationId);
  return new ApiError("credential_not_replayable", "replay", undefined, {
    operationId,
    ...(credential === null
      ? {}
      : { details: { credentialId: credential.id, state: credentialView(credential).state } }),
  });
}

async function answerOf(ctx: ApiContext, deps: AppDeps, outcome: IssueOutcome) {
  switch (outcome.kind) {
    case "issued":
      return {
        status: 201,
        body: {
          operationId: outcome.operation.id,
          credential: credentialView(outcome.credential),
          token: outcome.token,
        },
        headers: { "cache-control": "no-store" },
      };
    case "replay": {
      const answer = replayAnswer(ctx.route, outcome.operation);
      if (!("error" in answer)) return answer;
      if (answer.error === "credential_not_replayable" && answer.operationId !== undefined) {
        throw await notReplayable(deps.pool, answer.operationId);
      }
      throw new ApiError(answer.error, "replay", undefined, {
        ...(answer.operationId === undefined ? {} : { operationId: answer.operationId }),
      });
    }
    case "refused":
      throw new ApiError(outcome.code, undefined, undefined, {
        ...(outcome.operationId === undefined ? {} : { operationId: outcome.operationId }),
      });
    case "unknown":
      throw new ApiError("outcome_unknown", undefined, undefined, {
        operationId: outcome.operationId,
      });
  }
}

export const credentialsIssueHandler: Handler = async (ctx, deps) => {
  const principal = ctx.principal;
  const scope = ctx.scope as EnvironmentScope | null;
  const key = ctx.idempotencyKey;
  if (principal === null || scope === null || key === null) {
    throw new ApiError("dependency_unavailable");
  }
  const body = ctx.body as { name: string; ttlSeconds: number };
  const outcome = await issueCredential(credentialDeps(deps), {
    routeId: ctx.route.id,
    scope,
    userId: principal.userId,
    name: body.name,
    ttlSeconds: body.ttlSeconds,
    idempotencyKey: key,
    intent: intentOf(ctx.route, ctx.params, principal, ctx.body),
    requestId: ctx.requestId,
    recheck: recheckOf(ctx, principal.userId, scope),
  });
  return answerOf(ctx, deps, outcome);
};

/** credentials.revoke (Run 5.2, P-89): denied first, revoked only when the backend proved it. */
export const credentialsRevokeHandler: Handler = async (ctx, deps) => {
  const principal = ctx.principal;
  const scope = ctx.scope as EnvironmentScope | null;
  const key = ctx.idempotencyKey;
  if (principal === null || scope === null || key === null) {
    throw new ApiError("dependency_unavailable");
  }
  // A :credential that is not an id names nothing: 404, as an absent one.
  const credentialId = credentialIdSchema.safeParse(ctx.params.credential);
  if (!credentialId.success) throw new ApiError("not_found");
  const outcome = await revokeCredential(credentialDeps(deps), {
    routeId: ctx.route.id,
    scope,
    userId: principal.userId,
    credentialId: credentialId.data,
    idempotencyKey: key,
    intent: intentOf(ctx.route, ctx.params, principal, ctx.body),
    requestId: ctx.requestId,
    recheck: recheckOf(ctx, principal.userId, scope),
  });
  switch (outcome.kind) {
    case "revoked":
      return { status: 200, body: operationResponse(outcome.operation) };
    case "replay": {
      const answer = replayAnswer(ctx.route, outcome.operation);
      if (!("error" in answer)) return answer;
      throw new ApiError(answer.error, "replay", undefined, {
        ...(answer.operationId === undefined ? {} : { operationId: answer.operationId }),
      });
    }
    case "refused":
      throw new ApiError(outcome.code, undefined, undefined, {
        ...(outcome.operationId === undefined ? {} : { operationId: outcome.operationId }),
      });
    case "unknown":
      throw new ApiError("outcome_unknown", undefined, undefined, {
        operationId: outcome.operationId,
      });
  }
};

interface ListQuery {
  limit: number;
  cursor?: string;
}

const SORT_KEY = /^[0-9]{1,19}\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** credentials.list: newest issuance first, paged like operations.list (never listing_changed). */
export const credentialsListHandler: Handler = async (ctx, deps) => {
  const ring = deps.auth?.keys.cursorMac;
  if (ring === undefined || ctx.scope === null) throw new ApiError("dependency_unavailable");
  const scope = ctx.scope as EnvironmentScope;
  const query = ctx.query as ListQuery;
  const scopeText = `${scope.organizationId}/${scope.projectId}/${scope.environmentId}`;
  let anchor: string | null = null;
  let after: string | null = null;
  if (query.cursor !== undefined) {
    const read = readCursor(ring, query.cursor, {
      routeId: ctx.route.id,
      scope: scopeText,
      filter: "",
    });
    if (read === null || !SORT_KEY.test(read.lastKey)) throw new ApiError("malformed_request");
    anchor = read.generation;
    after = read.lastKey;
  }
  const limit = Math.min(query.limit, LIMITS.listing.maxLimit);
  const rows = await listCredentials(deps.pool, scope, { anchor, after, limit: limit + 1 });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const pageAnchor = anchor ?? page[0]?.sortKey.split("|")[0] ?? null;
  const nextCursor =
    rows.length > limit && last !== undefined && pageAnchor !== null
      ? signCursor(ring, {
          routeId: ctx.route.id,
          scope: scopeText,
          filter: "",
          lastKey: last.sortKey,
          generation: pageAnchor,
        })
      : null;
  return { status: 200, body: { credentials: page.map(credentialView), nextCursor } };
};

/**
 * credentials.summary (Run 7.7, P-139, FR-1.91). The route's action (owner and
 * admin) is decided by the pipeline before this runs, so everything counted
 * here is something the caller may list.
 */
export const credentialsSummaryHandler: Handler = async (ctx, deps) => {
  if (ctx.scope === null) throw new ApiError("dependency_unavailable");
  let summary;
  try {
    summary = await readCredentialsSummary(
      deps.pool,
      ctx.scope.organizationId,
      LIMITS.listing.defaultLimit,
    );
  } catch (error) {
    if (error instanceof AuditReadTimeout) throw new ApiError("busy", "summary_read_timeout");
    throw error;
  }
  return {
    status: 200,
    body: {
      observedAt: summary.observedAt.toISOString(),
      byState: summary.byState,
      expiring: summary.expiring.map((row) => ({
        credentialId: row.id,
        name: row.name,
        projectId: row.projectId,
        environmentId: row.environmentId,
        expiresAt: row.expiresAt.toISOString(),
      })),
      expiringTruncated: summary.expiringTruncated,
    },
  };
};
