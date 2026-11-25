// Automation credentials, the owner's three routes (Session 11, Run 11.5;
// P-185, P-191 to P-193, D-82). The owner or an admin issues one with a fresh
// second factor, lists them and revokes them. Each change is one transaction
// of @mykey/operations with no OpenBao; the secret leaves only in the 201
// this file builds, and the list never shows a secret or a verifier.
import { LIMITS, credentialIdSchema, decide, type ErrorCode, type UserId } from "@mykey/contracts";
import {
  listAutomationCredentials,
  lockParents,
  resolveAccess,
  type AutomationCredentialRow,
  type OrgScope,
} from "@mykey/db";
import {
  issueAutomationCredential,
  operationResponse,
  parseCidrs,
  replayAnswer,
  revokeAutomationCredential,
} from "@mykey/operations";
import type pg from "pg";
import { readCursor, signCursor } from "../pipeline/cursor.ts";
import { ApiError, type ApiContext, type AppDeps, type Handler } from "../pipeline/context.ts";
import { intentOf } from "../pipeline/route.ts";
import { checkStates } from "../pipeline/states.ts";
import { notReplayable, runtimeCredentialDeps } from "./credentials.ts";

/** The owner's view (the contract's `automationCredentialView`): an `active` row past its expiry reads `expired`. */
export function automationCredentialView(row: AutomationCredentialRow) {
  return {
    credentialId: row.id,
    ownerId: row.ownerId,
    name: row.name,
    rights: row.rights,
    boundCidrs: row.boundCidrs,
    state: row.state === "active" && row.expired ? ("expired" as const) : row.state,
    issuedBy: row.issuedBy,
    issuedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    expiringSoon: row.expiringSoon,
    lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.toISOString(),
    managedProjects: row.managedProjects,
  };
}

/**
 * The admission recheck of an organization's route (FR-1.10): the
 * organization locked FOR SHARE, then the caller's authority and its state
 * read again in the transaction.
 */
function organizationRecheck(ctx: ApiContext, userId: UserId, scope: OrgScope) {
  return async (tx: pg.PoolClient): Promise<ErrorCode | null> => {
    await lockParents(tx, scope, null);
    const resolved = await resolveAccess(tx, userId, { organizationId: scope.organizationId });
    if (resolved.authority === null || resolved.organization === null) return "not_found";
    const decision = decide(resolved.authority, {}, ctx.route.action);
    if (decision === "hidden") return "not_found";
    if (decision === "denied") return "action_denied";
    return checkStates(ctx.route, resolved);
  };
}

function requireContext(ctx: ApiContext) {
  const principal = ctx.principal;
  const scope: OrgScope | null = ctx.scope;
  const key = ctx.idempotencyKey;
  if (principal === null || scope === null || key === null) {
    throw new ApiError("dependency_unavailable");
  }
  return { principal, scope, key };
}

/** What a replayed operation answers; `credential_not_replayable` names the credential it made. */
async function replayOf(
  ctx: ApiContext,
  deps: AppDeps,
  operation: Parameters<typeof replayAnswer>[1],
) {
  const answer = replayAnswer(ctx.route, operation);
  if (!("error" in answer)) return answer;
  if (answer.error === "credential_not_replayable" && answer.operationId !== undefined) {
    throw await notReplayable(deps.pool, answer.operationId);
  }
  throw new ApiError(answer.error, "replay", undefined, {
    ...(answer.operationId === undefined ? {} : { operationId: answer.operationId }),
  });
}

/** automation_credentials.issue: the secret leaves only in this 201. */
export const automationCredentialsIssueHandler: Handler = async (ctx, deps) => {
  const { principal, scope, key } = requireContext(ctx);
  const body = ctx.body as {
    name: string;
    rights: Parameters<typeof issueAutomationCredential>[1]["rights"];
    ttlSeconds: number;
    cidrs: string[];
    replaces?: string;
  };
  // The schema checks the text; whether each entry is a network is checked here.
  if (parseCidrs(body.cidrs) === null) throw new ApiError("validation_failed");
  const outcome = await issueAutomationCredential(runtimeCredentialDeps(deps), {
    routeId: ctx.route.id,
    organizationId: scope.organizationId,
    actor: { kind: "user", id: principal.userId },
    name: body.name,
    rights: body.rights,
    ttlSeconds: body.ttlSeconds,
    cidrs: body.cidrs,
    ...(body.replaces === undefined ? {} : { replaces: body.replaces }),
    idempotencyKey: key,
    intent: intentOf(ctx.route, ctx.params, principal, ctx.body),
    requestId: ctx.requestId,
    recheck: organizationRecheck(ctx, principal.userId, scope),
  });
  switch (outcome.kind) {
    case "issued":
      return {
        status: 201,
        body: {
          operationId: outcome.operation.id,
          credential: automationCredentialView(outcome.credential),
          secret: outcome.secret,
        },
        headers: { "cache-control": "no-store" },
      };
    case "replay":
      return replayOf(ctx, deps, outcome.operation);
    case "refused":
      throw new ApiError(outcome.code);
  }
};

/** automation_credentials.revoke: one transaction; what the chain made stays. */
export const automationCredentialsRevokeHandler: Handler = async (ctx, deps) => {
  const { principal, scope, key } = requireContext(ctx);
  // A :credential that is not an id names nothing: 404, as an absent one.
  const credentialId = credentialIdSchema.safeParse(ctx.params.credential);
  if (!credentialId.success) throw new ApiError("not_found");
  const outcome = await revokeAutomationCredential(runtimeCredentialDeps(deps), {
    routeId: ctx.route.id,
    organizationId: scope.organizationId,
    actor: { kind: "user", id: principal.userId },
    credentialId: credentialId.data,
    idempotencyKey: key,
    intent: intentOf(ctx.route, ctx.params, principal, ctx.body),
    requestId: ctx.requestId,
    recheck: organizationRecheck(ctx, principal.userId, scope),
  });
  switch (outcome.kind) {
    case "revoked":
      return { status: 200, body: operationResponse(outcome.operation) };
    case "replay":
      return replayOf(ctx, deps, outcome.operation);
    case "refused":
      throw new ApiError(outcome.code);
  }
};

interface ListQuery {
  limit: number;
  cursor?: string;
}

const SORT_KEY = /^[0-9]{1,19}\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** automation_credentials.list: newest first, paged like credentials.list. */
export const automationCredentialsListHandler: Handler = async (ctx, deps) => {
  const ring = deps.auth?.keys.cursorMac;
  if (ring === undefined || ctx.scope === null) throw new ApiError("dependency_unavailable");
  const scope: OrgScope = ctx.scope;
  const query = ctx.query as ListQuery;
  let anchor: string | null = null;
  let after: string | null = null;
  if (query.cursor !== undefined) {
    const read = readCursor(ring, query.cursor, {
      routeId: ctx.route.id,
      scope: scope.organizationId,
      filter: "",
    });
    if (read === null || !SORT_KEY.test(read.lastKey)) throw new ApiError("malformed_request");
    anchor = read.generation;
    after = read.lastKey;
  }
  const limit = Math.min(query.limit, LIMITS.listing.maxLimit);
  const rows = await listAutomationCredentials(deps.pool, scope.organizationId, {
    anchor,
    after,
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const pageAnchor = anchor ?? page[0]?.sortKey.split("|")[0] ?? null;
  const nextCursor =
    rows.length > limit && last !== undefined && pageAnchor !== null
      ? signCursor(ring, {
          routeId: ctx.route.id,
          scope: scope.organizationId,
          filter: "",
          lastKey: last.sortKey,
          generation: pageAnchor,
        })
      : null;
  return {
    status: 200,
    body: { credentials: page.map(automationCredentialView), nextCursor },
  };
};
