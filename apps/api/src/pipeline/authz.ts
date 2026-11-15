// Ancestry, membership, visibility, action and state (Run 3.7, P-52, P-53).
// The caller's authority is read from current rows on every request
// (`resolveAccess`, one statement) and decided by `decide` from the contract.
// Hidden is answered exactly like absent (404); a refusal is audited.
import { appendAudit } from "@mykey/audit";
import {
  ROUTES,
  decide,
  type Action,
  type Authority,
  type ErrorCode,
  type OperationId,
  type RouteDef,
} from "@mykey/contracts";
import {
  findOperation,
  resolveAccess,
  type OperationRow,
  type EnvironmentScope,
  type OrgScope,
  type ProjectScope,
  type Resolved,
} from "@mykey/db";
import type { UserPrincipal as Principal } from "./authn.ts";
import { ApiError, type AppDeps } from "./context.ts";
import { checkStates } from "./states.ts";

export type Scope = OrgScope | ProjectScope | EnvironmentScope;

export interface Access {
  scope: Scope | null;
  authority: Authority | null;
  /** The rows the decision was made on (Run 3.9: the state check comes after a replay lookup). */
  resolved: Resolved | null;
  /** The operation a route of scope `operation` names (Run 4.1). */
  operation?: OperationRow;
}

export type DenialReason = "hidden" | "action" | "state" | "fresh";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Audits `access.denied` and throws the answer. */
export async function deny(
  deps: AppDeps,
  input: {
    route: RouteDef;
    principal: Principal;
    requestId: string;
    reason: DenialReason;
    code: ErrorCode;
    /** Only when the caller is a member of it. */
    organizationId: string | null;
    targetId: string | null;
  },
): Promise<never> {
  await appendAudit(deps.pool, {
    action: "access.denied",
    actor: { kind: "user", id: input.principal.userId },
    source: "api",
    organizationId: input.organizationId,
    target:
      input.route.scope === "none"
        ? null
        : {
            kind: input.route.scope,
            id: input.targetId !== null && UUID.test(input.targetId) ? input.targetId : null,
          },
    outcome: "denied",
    requestId: input.requestId,
    operationId: null,
    details: { routeId: input.route.id, reason: input.reason },
  });
  throw new ApiError(input.code, input.reason);
}

export async function authorize(
  deps: AppDeps,
  route: RouteDef,
  params: Record<string, string>,
  principal: Principal,
  requestId: string,
): Promise<Access> {
  const base = { route, principal, requestId };
  if (route.scope === "none") {
    if (route.action === null) return { scope: null, authority: null, resolved: null };
    return authorizeService(deps, route, principal, (organizationId) =>
      deny(deps, { ...base, reason: "hidden", code: "not_found", organizationId, targetId: null }),
    );
  }
  const named = [params.env, params.project, params.org, params.operation];
  const deepest = named.find((id) => id !== undefined) ?? null;
  const hidden = (organizationId: string | null) =>
    deny(deps, { ...base, reason: "hidden", code: "not_found", organizationId, targetId: deepest });

  if (route.scope === "operation") return authorizeOperation(deps, params, principal, hidden);

  const organizationId = params.org;
  const projectId = params.project;
  const environmentId = params.env;
  if (
    organizationId === undefined ||
    [organizationId, projectId, environmentId].some((id) => id !== undefined && !UUID.test(id))
  ) {
    return hidden(null);
  }

  const resolved = await resolveAccess(deps.pool, principal.userId, {
    organizationId,
    ...(projectId === undefined ? {} : { projectId }),
    ...(environmentId === undefined ? {} : { environmentId }),
  });
  const { authority } = resolved;
  if (authority === null || resolved.organization === null) return hidden(null);
  const member = organizationId;
  if (projectId !== undefined && resolved.project === null) return hidden(member);
  if (environmentId !== undefined && resolved.environment === null) return hidden(member);

  const decision = decide(
    authority,
    {
      ...(projectId === undefined ? {} : { projectId }),
      ...(environmentId === undefined ? {} : { environmentId }),
    },
    route.action,
  );
  if (decision === "hidden") return hidden(member);
  if (decision === "denied") {
    return deny(deps, {
      ...base,
      reason: "action",
      code: "action_denied",
      organizationId: member,
      targetId: deepest,
    });
  }
  const scope = {
    organizationId,
    ...(projectId === undefined ? {} : { projectId }),
    ...(environmentId === undefined ? {} : { environmentId }),
  } as Scope;
  return { scope, authority, resolved };
}

/**
 * Service scope (Run 5.9, P-101): a human route with an action whose path
 * names no organization is about the service this process runs for, so it is
 * authorized against the process's own organization (`deps.bao`), never one
 * taken from the request. No such organization: 503. `decide` answers; a
 * caller who is not a member is hidden like everyone else.
 */
async function authorizeService(
  deps: AppDeps,
  route: RouteDef,
  principal: Principal,
  hidden: (organizationId: string | null) => Promise<never>,
): Promise<Access> {
  const organizationId = deps.bao?.organizationId() ?? null;
  if (organizationId === null) throw new ApiError("dependency_unavailable");
  const resolved = await resolveAccess(deps.pool, principal.userId, { organizationId });
  const { authority } = resolved;
  if (authority === null || resolved.organization === null) return hidden(null);
  const decision = decide(authority, {}, route.action);
  if (decision !== "allow") return hidden(organizationId);
  return { scope: { organizationId } as Scope, authority, resolved };
}

/** The action of the route that made an operation; `resources.manage` when no route has its id. */
function actionOfOperation(deps: AppDeps, action: string): Action | null {
  const route =
    ROUTES.find((candidate) => candidate.id === action) ??
    deps.test?.routes?.find((entry) => entry.def.id === action)?.def;
  return route === undefined ? "resources.manage" : route.action;
}

/**
 * Scope `operation` (P-63, D-35): the operation's own organization, project
 * and environment, read on this request. An owner or admin of the organization
 * sees it; a member sees its own operation while `decide` still allows that
 * member the operation's action on its scope. Everyone else: hidden, exactly
 * like an absent id.
 */
async function authorizeOperation(
  deps: AppDeps,
  params: Record<string, string>,
  principal: Principal,
  hidden: (organizationId: string | null) => Promise<never>,
): Promise<Access> {
  const id = params.operation ?? "";
  if (!UUID.test(id)) return hidden(null);
  const operation = await findOperation(deps.pool, id as OperationId);
  if (operation?.organizationId == null) return hidden(null);
  const { organizationId, projectId, environmentId } = operation;
  const resolved = await resolveAccess(deps.pool, principal.userId, {
    organizationId,
    ...(projectId === null ? {} : { projectId }),
    ...(environmentId === null ? {} : { environmentId }),
  });
  const { authority } = resolved;
  if (authority === null || resolved.organization === null) return hidden(null);
  if (projectId !== null && resolved.project === null) return hidden(organizationId);
  if (environmentId !== null && resolved.environment === null) return hidden(organizationId);
  const target = {
    ...(projectId === null ? {} : { projectId }),
    ...(environmentId === null ? {} : { environmentId }),
  };
  const manager = authority.role === "owner" || authority.role === "admin";
  const author =
    operation.principalKind === "user" &&
    operation.principalId === principal.userId &&
    decide(authority, target, actionOfOperation(deps, operation.action)) === "allow";
  if (!manager && !author) return hidden(organizationId);
  const scope = { organizationId, ...target } as Scope;
  return { scope, authority, resolved, operation };
}

/** The state step (P-53): after visibility, action and — for a mutation — the replay lookup. */
export async function admitStates(
  deps: AppDeps,
  route: RouteDef,
  params: Record<string, string>,
  principal: Principal,
  requestId: string,
  access: Access,
): Promise<void> {
  if (access.resolved === null || access.scope === null) return;
  const code = checkStates(route, access.resolved);
  if (code === null) return;
  await deny(deps, {
    route,
    principal,
    requestId,
    reason: "state",
    code,
    organizationId: access.scope.organizationId,
    targetId: params.env ?? params.project ?? params.org ?? null,
  });
}
