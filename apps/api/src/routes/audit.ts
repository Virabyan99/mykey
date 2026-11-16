// The audit view (Run 6.1, P-106, P-107, FR-1.58). An owner or admin of the
// organization (the pipeline decided: action `audit.view`) reads its tenant
// rows and the account rows of its members, newest first, in keyset pages
// under an anchor: the first page fixes the anchor on database time and no
// row after it is served by that listing. The signed cursor carries the
// anchor, the last row and a digest of the filters; another filter is
// `409 listing_changed`, a cursor that does not verify `400 malformed_request`.
// Each row's details pass their action's schema again on the way out.
import { createHash } from "node:crypto";
import { SERVED_ACTIONS, servedDetails, type AuditAction } from "@mykey/audit";
import { LIMITS } from "@mykey/contracts";
import {
  AuditReadTimeout,
  databaseNowMicros,
  listAuditEvents,
  projectTargetIds,
  type AuditRow,
} from "@mykey/db";
import { now } from "../log.ts";
import { readCursor, signCursor } from "../pipeline/cursor.ts";
import {
  ApiError,
  type ApiContext,
  type AppDeps,
  type HandlerResult,
} from "../pipeline/context.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LAST_KEY = /^([0-9a-f]{16})\|([0-9]{1,19})\|([0-9a-f-]{36})$/;
const DAY_MS = 86_400_000;
/** The default window and the widest one (P-107). */
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 92;

export interface ListingQuery {
  limit: number;
  cursor?: string;
  from?: string;
  to?: string;
  action?: string;
  outcome?: string;
  actorKind?: string;
  actorId?: string;
  projectId?: string;
  environmentId?: string;
  operationId?: string;
  requestId?: string;
}

/** A served row: the item every listing shares. */
export interface AuditItem {
  id: string;
  occurredAt: string;
  actor: { kind: string; id: string | null };
  source: string | null;
  action: string;
  target: { kind: string; id: string | null } | null;
  outcome: string;
  requestId: string | null;
  operationId: string | null;
  details: Record<string, string | number | boolean | null>;
}

/** The filters a cursor is bound to: every query key but `limit` and `cursor`, sorted. */
function filterDigest(query: ListingQuery): string {
  const entries = Object.entries(query)
    .filter(([key, value]) => key !== "limit" && key !== "cursor" && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 16);
}

const microsOf = (micros: string): Date => new Date(Number(BigInt(micros) / 1000n));

/**
 * One page of the organization's served rows under `actions`, the window and
 * the filters; answers the rows to serve, the next cursor and the anchor.
 */
export async function auditPage(
  ctx: ApiContext,
  deps: AppDeps,
  actions: readonly AuditAction[],
): Promise<{ rows: AuditRow[]; nextCursor: string | null; anchor: string }> {
  const ring = deps.auth?.keys.cursorMac;
  if (ring === undefined || ctx.scope === null) throw new ApiError("dependency_unavailable");
  const organizationId = ctx.scope.organizationId;
  const query = ctx.query as ListingQuery;
  const digest = filterDigest(query);
  const expect = { routeId: ctx.route.id, scope: organizationId, filter: "" };

  let anchorMicros: string;
  let after: { occurredAtMicros: string; id: string } | undefined;
  if (query.cursor !== undefined) {
    const read = readCursor(ring, query.cursor, expect);
    const key = read === null ? null : LAST_KEY.exec(read.lastKey);
    if (read === null || key === null) throw new ApiError("malformed_request");
    if (key[1] !== digest) throw new ApiError("listing_changed");
    anchorMicros = read.generation;
    const [, , occurredAtMicros = "", id = ""] = key;
    after = { occurredAtMicros, id };
  } else {
    anchorMicros = await databaseNowMicros(deps.pool);
  }

  const anchor = microsOf(anchorMicros);
  const to = query.to === undefined ? anchor : new Date(query.to);
  const from =
    query.from === undefined
      ? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS)
      : new Date(query.from);
  if (from.getTime() > to.getTime()) throw new ApiError("validation_failed", "window");
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new ApiError("validation_failed", "window");
  }

  let targetIds: string[] | undefined;
  if (query.projectId !== undefined) {
    targetIds = await projectTargetIds(deps.pool, organizationId, query.projectId);
    if (query.environmentId !== undefined) {
      targetIds = targetIds.filter((id) => id === query.environmentId);
    }
  } else if (query.environmentId !== undefined) {
    targetIds = [query.environmentId];
  }

  const limit = Math.min(query.limit, LIMITS.listing.maxLimit);
  let rows: AuditRow[];
  try {
    rows = await listAuditEvents(deps.pool, {
      organizationId,
      from,
      to,
      anchorMicros,
      ...(after === undefined ? {} : { after }),
      actions,
      ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
      ...(query.actorKind === undefined ? {} : { actorKind: query.actorKind }),
      ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
      ...(targetIds === undefined ? {} : { targetIds }),
      ...(query.operationId === undefined ? {} : { operationId: query.operationId }),
      ...(query.requestId === undefined ? {} : { requestId: query.requestId }),
      limit: limit + 1,
    });
  } catch (error) {
    if (error instanceof AuditReadTimeout) throw new ApiError("busy", "audit_read_timeout");
    throw error;
  }
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined
      ? signCursor(ring, {
          ...expect,
          lastKey: `${digest}|${last.occurredAtMicros}|${last.id}`,
          generation: anchorMicros,
        })
      : null;
  return { rows: page, nextCursor, anchor: anchor.toISOString() };
}

/** A stored row as served; details that fail their schema are `{}` and logged (P-107). */
export function itemOf(ctx: ApiContext, deps: AppDeps, row: AuditRow): AuditItem {
  const { details, valid } = servedDetails(row.action as AuditAction, row.details);
  if (!valid) {
    deps.log({
      event: "output_invalid",
      time: now(),
      requestId: ctx.requestId,
      routeId: ctx.route.id,
      eventId: row.id,
    });
  }
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actor: { kind: row.actorKind, id: row.actorId },
    source: row.source,
    action: row.action,
    target: row.targetKind === null ? null : { kind: row.targetKind, id: row.targetId },
    outcome: row.outcome,
    requestId: row.requestId,
    operationId: row.operationId,
    details,
  };
}

export const auditListHandler = async (ctx: ApiContext, deps: AppDeps): Promise<HandlerResult> => {
  const query = ctx.query as ListingQuery;
  let actions: readonly AuditAction[] = SERVED_ACTIONS;
  if (query.action !== undefined) {
    const chosen = SERVED_ACTIONS.find((action) => action === query.action);
    if (chosen === undefined) throw new ApiError("validation_failed", "action");
    actions = [chosen];
  }
  const { rows, nextCursor, anchor } = await auditPage(ctx, deps, actions);
  return {
    status: 200,
    body: { items: rows.map((row) => itemOf(ctx, deps, row)), nextCursor, anchor },
  };
};

/** The ids among `values` that are UUIDs (target ids are text in the log). */
export const uuidsOf = (values: readonly (string | null)[]): string[] => [
  ...new Set(values.filter((value): value is string => value !== null && UUID.test(value))),
];
