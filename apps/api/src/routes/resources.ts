// Projects and environments (Run 3.9, P-58, P-59): create and rename as
// durable, replayable operations in one transaction each; lists as keyset
// pages under signed cursors. No route deletes either.
import { randomUUID } from "node:crypto";
import { appendAudit, type AuditAction } from "@mykey/audit";
import { LIMITS, type EnvironmentId, type ErrorCode, type ProjectId } from "@mykey/contracts";
import {
  bumpResourceGeneration,
  completeOperation,
  createEnvironment,
  createProject,
  listEnvironments,
  listProjects,
  lockParents,
  renameEnvironment,
  renameProject,
  resourceGeneration,
  withTransaction,
  type EnvironmentRow,
  type EnvironmentScope,
  type ListedProject,
  type OrgScope,
  type ProjectScope,
} from "@mykey/db";
import { beginOperation, operationResponse } from "@mykey/operations";
import type pg from "pg";
import { automationRecheck } from "../pipeline/automation.ts";
import { actorOf } from "../pipeline/caller.ts";
import { readCursor, signCursor } from "../pipeline/cursor.ts";
import { ApiError, type ApiContext, type AppDeps, type Handler } from "../pipeline/context.ts";

interface Done {
  result: Record<string, unknown>;
  audit: { action: AuditAction; kind: "project" | "environment"; id: string; name: string } | null;
}

function organizationCode(state: string | null): ErrorCode | null {
  if (state === "active") return null;
  return state === "needs_review" ? "backend_inconsistent" : "state_conflict";
}

/** metadata_write (P-53): a project or environment that is pending or active. */
function resourceCode(state: string | null): ErrorCode | null {
  return state === "pending" || state === "active" ? null : "state_conflict";
}

/**
 * Who changes, where and under which key. Session 11: the caller is a person
 * or an automation credential (a machine actor), whose credential, right and
 * managed project are checked again inside the change.
 */
function requireContext(ctx: ApiContext, deps: AppDeps) {
  const actor = actorOf(ctx);
  const scope = ctx.scope;
  const key = ctx.idempotencyKey;
  const ring = deps.auth?.keys.replayFingerprint;
  if (actor === null || scope === null || key === null || ring === undefined) {
    throw new ApiError("dependency_unavailable");
  }
  const recheck =
    ctx.automation === null ? null : automationRecheck(ctx.route, ctx.automation, scope);
  return { actor, scope, key, ring, recheck };
}

/** The common part of every create and rename. */
async function mutate(
  ctx: ApiContext,
  deps: AppDeps,
  target: string,
  creates: boolean,
  work: (tx: pg.PoolClient) => Promise<Done>,
): Promise<{ status: number; body: unknown }> {
  const { actor, scope, key, ring, recheck } = requireContext(ctx, deps);
  const completed = 201 in ctx.route.responses ? 201 : 200;
  return withTransaction(deps.pool, async (tx) => {
    const begin = await beginOperation(tx, ring, {
      principalKind: actor.kind,
      principalId: actor.id,
      action: ctx.route.id,
      target,
      idempotencyKey: key,
      organizationId: scope.organizationId,
      ...("projectId" in scope ? { projectId: scope.projectId } : {}),
      ...("environmentId" in scope ? { environmentId: scope.environmentId } : {}),
      body: ctx.body,
    });
    if (begin.kind === "conflict") throw new ApiError("idempotency_conflict");
    if (begin.kind === "replay") {
      const stored = begin.operation;
      return {
        status: stored.state === "succeeded" ? completed : 202,
        body: operationResponse(stored),
      };
    }
    // A create raises the list generation first: the organization row's lock is
    // then this transaction's before any share lock, so two creates in one
    // organization queue instead of deadlocking (seen in Run 3.9's race test).
    if (creates) await bumpResourceGeneration(tx, scope);
    // Admission recheck under share locks (FR-1.10): the states the pipeline read may have moved.
    // A rename changes the scope's deepest row; a create only reads its parents.
    const own = creates
      ? null
      : "environmentId" in scope
        ? "environment"
        : "projectId" in scope
          ? "project"
          : null;
    const parents = await lockParents(tx, scope, own);
    const code =
      organizationCode(parents.organization) ??
      ("projectId" in scope ? resourceCode(parents.project) : null) ??
      ("environmentId" in scope ? resourceCode(parents.environment) : null);
    if (code !== null) throw new ApiError(code);
    // An automation caller (FR-1.10): its credential, its right and the project its chain manages, now.
    const refused = recheck === null ? null : await recheck(tx);
    if (refused !== null) throw new ApiError(refused);

    const done = await work(tx);
    const row = await completeOperation(
      tx,
      begin.operationId,
      done.result,
      LIMITS.operation.terminalRetentionDays,
    );
    if (done.audit !== null) {
      await appendAudit(tx, {
        action: done.audit.action,
        actor,
        source: "api",
        organizationId: scope.organizationId,
        target: { kind: done.audit.kind, id: done.audit.id },
        outcome: "success",
        requestId: ctx.requestId,
        operationId: begin.operationId,
        // Code points, as the name rules count them.
        details: { nameLength: Array.from(done.audit.name).length },
      });
    }
    return { status: completed, body: operationResponse(row) };
  });
}

const nameOf = (ctx: ApiContext): string => (ctx.body as { name: string }).name;

export const projectsCreateHandler: Handler = (ctx, deps) => {
  const scope = ctx.scope as OrgScope;
  return mutate(ctx, deps, scope.organizationId, true, async (tx) => {
    const projectId = randomUUID() as ProjectId;
    const developmentEnvironmentId = randomUUID() as EnvironmentId;
    const name = nameOf(ctx);
    const outcome = await createProject(tx, scope, {
      projectId,
      name,
      developmentEnvironmentId,
      // Session 11 (P-193): a project made by automation is managed by its maker's chain.
      managedBy: ctx.automation?.ownerId ?? null,
    });
    if (outcome === "name_taken") throw new ApiError("already_exists");
    return {
      result: { projectId, developmentEnvironmentId },
      audit: { action: "project.create", kind: "project", id: projectId, name },
    };
  });
};

export const projectsRenameHandler: Handler = (ctx, deps) => {
  const scope = ctx.scope as ProjectScope;
  return mutate(ctx, deps, scope.projectId, false, async (tx) => {
    const name = nameOf(ctx);
    const outcome = await renameProject(tx, scope, name);
    if (outcome === "name_taken") throw new ApiError("already_exists");
    return {
      result: {},
      audit:
        outcome === "renamed"
          ? { action: "project.rename", kind: "project", id: scope.projectId, name }
          : null,
    };
  });
};

export const environmentsCreateHandler: Handler = (ctx, deps) => {
  const scope = ctx.scope as ProjectScope;
  return mutate(ctx, deps, scope.projectId, true, async (tx) => {
    const environmentId = randomUUID() as EnvironmentId;
    const name = nameOf(ctx);
    const outcome = await createEnvironment(tx, scope, { environmentId, name });
    if (outcome === "name_taken") throw new ApiError("already_exists");
    return {
      result: { environmentId },
      audit: { action: "environment.create", kind: "environment", id: environmentId, name },
    };
  });
};

export const environmentsRenameHandler: Handler = (ctx, deps) => {
  const scope = ctx.scope as EnvironmentScope;
  return mutate(ctx, deps, scope.environmentId, false, async (tx) => {
    const name = nameOf(ctx);
    const outcome = await renameEnvironment(tx, scope, name);
    if (outcome === "name_taken") throw new ApiError("already_exists");
    return {
      result: {},
      audit:
        outcome === "renamed"
          ? { action: "environment.rename", kind: "environment", id: scope.environmentId, name }
          : null,
    };
  });
};

// -------------------------------------------------------------------- lists

interface Page {
  limit: number;
  cursor?: string;
}

/** The page's start and the generation its cursor must carry; 400 or 409 when the cursor does not fit. */
export async function pageStart(
  ctx: ApiContext,
  deps: AppDeps,
  scopeText: string,
): Promise<{ afterId: string | null; generation: bigint }> {
  const ring = deps.auth?.keys.cursorMac;
  const scope = ctx.scope;
  if (ring === undefined || scope === null) throw new ApiError("dependency_unavailable");
  const current = await resourceGeneration(deps.pool, scope);
  const { cursor } = ctx.query as Page;
  if (cursor === undefined) return { afterId: null, generation: current };
  const read = readCursor(ring, cursor, { routeId: ctx.route.id, scope: scopeText, filter: "" });
  if (read === null) throw new ApiError("malformed_request");
  if (read.generation !== current.toString()) throw new ApiError("listing_changed");
  return { afterId: read.lastKey, generation: current };
}

export function nextCursor(
  ctx: ApiContext,
  deps: AppDeps,
  scopeText: string,
  rows: { id: string }[],
  limit: number,
  generation: bigint,
): string | null {
  const ring = deps.auth?.keys.cursorMac;
  if (ring === undefined || rows.length <= limit) return null;
  const last = rows[limit - 1];
  if (last === undefined) return null;
  return signCursor(ring, {
    routeId: ctx.route.id,
    scope: scopeText,
    filter: "",
    lastKey: last.id,
    generation: generation.toString(),
  });
}

/** A project as a list shows it. */
export const projectView = (row: ListedProject) => ({
  id: row.id,
  name: row.name,
  state: row.state,
  reviewReason: row.reviewReason,
  createdAt: row.createdAt.toISOString(),
  managedBy: row.managedBy,
});

/** An environment as a list shows it. */
export const environmentView = (row: EnvironmentRow) => ({
  id: row.id,
  name: row.name,
  state: row.state,
  reviewReason: row.reviewReason,
  kvReady: row.kvReady,
  createdAt: row.createdAt.toISOString(),
});

export const projectsListHandler: Handler = async (ctx, deps) => {
  const scope = ctx.scope as OrgScope;
  const authority = ctx.authority;
  if (authority === null) throw new ApiError("dependency_unavailable");
  const visible =
    authority.role === "member"
      ? [
          ...new Set([
            ...authority.projectGrants.keys(),
            ...[...authority.environmentGrants.values()].map((grant) => grant.projectId),
          ]),
        ]
      : "all";
  const { limit } = ctx.query as Page;
  const scopeText = scope.organizationId;
  const start = await pageStart(ctx, deps, scopeText);
  const rows = await listProjects(deps.pool, scope, visible, {
    afterId: start.afterId,
    limit: limit + 1,
  });
  return {
    status: 200,
    body: {
      projects: rows.slice(0, limit).map(projectView),
      nextCursor: nextCursor(ctx, deps, scopeText, rows, limit, start.generation),
    },
  };
};

export const environmentsListHandler: Handler = async (ctx, deps) => {
  const scope = ctx.scope as ProjectScope;
  const authority = ctx.authority;
  if (authority === null) throw new ApiError("dependency_unavailable");
  const visible =
    authority.role !== "member" || authority.projectGrants.has(scope.projectId)
      ? "all"
      : [...authority.environmentGrants.entries()]
          .filter(([, grant]) => grant.projectId === scope.projectId)
          .map(([id]) => id);
  const { limit } = ctx.query as Page;
  const scopeText = `${scope.organizationId}/${scope.projectId}`;
  const start = await pageStart(ctx, deps, scopeText);
  const rows = await listEnvironments(deps.pool, scope, visible, {
    afterId: start.afterId,
    limit: limit + 1,
  });
  return {
    status: 200,
    body: {
      environments: rows.slice(0, limit).map(environmentView),
      nextCursor: nextCursor(ctx, deps, scopeText, rows, limit, start.generation),
    },
  };
};
