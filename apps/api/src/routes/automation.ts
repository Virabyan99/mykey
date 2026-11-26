// The ten automation routes (Session 11, Run 11.5; P-191 to P-194, D-82).
//
// Who the caller is, which project its chain manages and which right the
// route asks for were decided by the pipeline (pipeline/automation.ts), and
// are decided again inside every change (automationRecheck). So a change by
// automation is the person's handler with a machine actor: the same protocol,
// the same operation record, the same audit action. Those five are named
// here and written where the person's are.
//
// What is written here is what automation reads, which is less than a person
// reads: only the projects its chain manages, a secret's name and times and
// never its value, runtime credentials and never a 30-day token.
import { LIMITS, credentialIdSchema } from "@mykey/contracts";
import {
  credentialKindOf,
  listEnvironments,
  listMetadataPage,
  listProjects,
  type EnvironmentScope,
  type OrgScope,
  type ProjectScope,
} from "@mykey/db";
import { readCursor, signCursor } from "../pipeline/cursor.ts";
import { ApiError, type Handler } from "../pipeline/context.ts";
import {
  credentialsListHandler,
  revokeRuntime,
  runtimeCredentialsIssueHandler,
} from "./credentials.ts";
import { operationsGetHandler } from "./operations.ts";
import {
  environmentView,
  environmentsCreateHandler,
  nextCursor,
  pageStart,
  projectView,
  projectsCreateHandler,
} from "./resources.ts";
import { secretsCreateHandler } from "./secrets.ts";

// ------------------------------------------------------------------ changes

/** automation.projects.create: the project is managed by the caller's chain (P-193). */
export const automationProjectsCreateHandler: Handler = projectsCreateHandler;
/** automation.environments.create: the provisioner builds it as it builds a person's (D-32). */
export const automationEnvironmentsCreateHandler: Handler = environmentsCreateHandler;
/** automation.secrets.create: create-only; an existing name is 409 and nothing changes (rule 7). */
export const automationSecretsCreateHandler: Handler = secretsCreateHandler;
/** automation.runtime_credentials.issue: the one answer that holds the client secret. */
export const automationRuntimeCredentialsIssueHandler: Handler = runtimeCredentialsIssueHandler;

/**
 * automation.runtime_credentials.revoke: a runtime credential of this
 * environment. A 30-day token is a person's to revoke: its id is the same 404
 * here as an absent one, and its row is not touched.
 */
export const automationRuntimeCredentialsRevokeHandler: Handler = async (ctx, deps) => {
  const scope = ctx.scope as EnvironmentScope | null;
  if (scope === null) throw new ApiError("dependency_unavailable");
  const credentialId = credentialIdSchema.safeParse(ctx.params.credential);
  if (!credentialId.success) throw new ApiError("not_found");
  if ((await credentialKindOf(deps.pool, scope, credentialId.data)) !== "runtime") {
    throw new ApiError("not_found");
  }
  return revokeRuntime(ctx, deps, scope, credentialId.data);
};

// -------------------------------------------------------------------- reads

/** automation.runtime_credentials.list: the person's list, which shows this caller runtime credentials only. */
export const automationRuntimeCredentialsListHandler: Handler = credentialsListHandler;
/** automation.operations.get: an operation a credential of the caller's chain made (the pipeline looked). */
export const automationOperationsGetHandler: Handler = operationsGetHandler;

interface Page {
  limit: number;
  cursor?: string;
}

/** automation.projects.list: the projects the caller's chain manages, paged as a person's list. */
export const automationProjectsListHandler: Handler = async (ctx, deps) => {
  const scope: OrgScope | null = ctx.scope;
  const automation = ctx.automation;
  if (scope === null || automation === null) throw new ApiError("dependency_unavailable");
  const { limit } = ctx.query as Page;
  // A cursor is one chain's: another chain's is refused as a cursor of another list.
  const scopeText = `${scope.organizationId}/${automation.ownerId}`;
  const start = await pageStart(ctx, deps, scopeText);
  const rows = await listProjects(
    deps.pool,
    scope,
    "all",
    { afterId: start.afterId, limit: limit + 1 },
    automation.ownerId,
  );
  return {
    status: 200,
    body: {
      projects: rows.slice(0, limit).map(projectView),
      nextCursor: nextCursor(ctx, deps, scopeText, rows, limit, start.generation),
    },
  };
};

/**
 * automation.projects.get: one managed project with its environments, which
 * is how a script learns that an environment's store is ready.
 */
export const automationProjectsGetHandler: Handler = async (ctx, deps) => {
  const scope = ctx.scope as ProjectScope | null;
  const automation = ctx.automation;
  if (scope === null || automation === null) throw new ApiError("dependency_unavailable");
  const [project] = await listProjects(
    deps.pool,
    scope,
    [scope.projectId],
    { afterId: null, limit: 1 },
    automation.ownerId,
  );
  // No longer managed since the pipeline looked: as absent.
  if (project === undefined) throw new ApiError("not_found");
  const max = LIMITS.listing.maxLimit;
  const environments = await listEnvironments(deps.pool, scope, "all", {
    afterId: null,
    limit: max + 1,
  });
  return {
    status: 200,
    body: {
      id: project.id,
      name: project.name,
      state: project.state,
      reviewReason: project.reviewReason,
      createdAt: project.createdAt.toISOString(),
      environments: environments.slice(0, max).map(environmentView),
      truncated: environments.length > max,
    },
  };
};

/**
 * automation.secrets.list: each name with its state, version and two times,
 * from the index and the version events. Never a value and never a digest:
 * neither table holds one. Paged as secrets.list; a write between two pages
 * is 409 listing_changed.
 */
export const automationSecretsListHandler: Handler = async (ctx, deps) => {
  const scope = ctx.scope as EnvironmentScope | null;
  const ring = deps.auth?.keys.cursorMac;
  if (scope === null || ring === undefined) throw new ApiError("dependency_unavailable");
  const { prefix, limit, cursor } = ctx.query as Page & { prefix?: string };
  const scopeText = `${scope.organizationId}/${scope.projectId}/${scope.environmentId}`;
  const expect = { routeId: ctx.route.id, scope: scopeText, filter: prefix ?? "" };
  const read = cursor === undefined ? null : readCursor(ring, cursor, expect);
  if (cursor !== undefined && read === null) throw new ApiError("malformed_request");
  const page = await listMetadataPage(deps.pool, scope, {
    prefix: prefix ?? null,
    after: read?.lastKey ?? null,
    limit: limit + 1,
  });
  if (read !== null && read.generation !== page.generation.toString()) {
    throw new ApiError("listing_changed");
  }
  const rows = page.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    status: 200,
    body: {
      secrets: rows.map((row) => ({
        name: row.name,
        state: row.state,
        version: row.version,
        createdAt: row.createdAt === null ? null : row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor:
        page.rows.length > limit && last !== undefined
          ? signCursor(ring, {
              ...expect,
              lastKey: last.name,
              generation: page.generation.toString(),
            })
          : null,
    },
  };
};
