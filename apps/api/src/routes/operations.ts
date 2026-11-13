// Operation status and list (Run 4.1, P-63, Doc 04 §4.1). Who may see an
// operation was decided by the pipeline (scope `operation`); the list shows a
// member only its own operations and an owner or admin all of them. Children
// of an import are reached through their parent.
import { LIMITS } from "@mykey/contracts";
import { listOperations, type EnvironmentScope } from "@mykey/db";
import { operationResponse } from "@mykey/operations";
import { readCursor, signCursor } from "../pipeline/cursor.ts";
import { ApiError, type Handler } from "../pipeline/context.ts";

export const operationsGetHandler: Handler = (ctx) => {
  if (ctx.operation === null) return Promise.reject(new ApiError("dependency_unavailable"));
  return Promise.resolve({ status: 200, body: operationResponse(ctx.operation) });
};

interface ListQuery {
  limit: number;
  cursor?: string;
  state?: "unfinished";
}

const SORT_KEY = /^[0-9]{1,19}\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const operationsListHandler: Handler = async (ctx, deps) => {
  const ring = deps.auth?.keys.cursorMac;
  const principal = ctx.principal;
  const authority = ctx.authority;
  if (ring === undefined || principal === null || authority === null || ctx.scope === null) {
    throw new ApiError("dependency_unavailable");
  }
  const scope = ctx.scope as EnvironmentScope;
  const query = ctx.query as ListQuery;
  const manager = authority.role === "owner" || authority.role === "admin";
  const scopeText = `${scope.organizationId}/${scope.projectId}/${scope.environmentId}`;
  const filter = query.state ?? "";
  let anchor: string | null = null;
  let after: string | null = null;
  if (query.cursor !== undefined) {
    const read = readCursor(ring, query.cursor, {
      routeId: ctx.route.id,
      scope: scopeText,
      filter,
    });
    if (read === null || !SORT_KEY.test(read.lastKey)) throw new ApiError("malformed_request");
    anchor = read.generation;
    after = read.lastKey;
  }
  const limit = Math.min(query.limit, LIMITS.listing.maxLimit);
  const rows = await listOperations(
    deps.pool,
    scope,
    {
      principalId: manager ? null : principal.userId,
      unfinishedOnly: query.state === "unfinished",
    },
    { anchor, after, limit: limit + 1 },
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  // The first page's first row is the anchor of every later page.
  const pageAnchor = anchor ?? page[0]?.sortKey.split("|")[0] ?? null;
  const nextCursor =
    rows.length > limit && last !== undefined && pageAnchor !== null
      ? signCursor(ring, {
          routeId: ctx.route.id,
          scope: scopeText,
          filter,
          lastKey: last.sortKey,
          generation: pageAnchor,
        })
      : null;
  return {
    status: 200,
    body: {
      operations: page.map((row) => ({
        operationId: row.id,
        action: row.action,
        state: row.state,
        name: row.secretName,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
        replayExpiresAt: row.replayExpiresAt === null ? null : row.replayExpiresAt.toISOString(),
        errorCode: row.state === "rejected" ? row.errorCode : null,
        mine: row.principalKind === "user" && row.principalId === principal.userId,
      })),
      nextCursor,
    },
  };
};
