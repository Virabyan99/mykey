// Ancestry, membership, visibility, action and state (Run 3.7, P-52, P-53).
// The caller's authority is read from current rows on every request
// (`resolveAccess`, one statement) and decided by `decide` from the contract.
// Hidden is answered exactly like absent (404); a refusal is audited.
import { appendAudit } from "@mykey/audit";
import { decide, type Authority, type ErrorCode, type RouteDef } from "@mykey/contracts";
import {
  resolveAccess,
  type EnvironmentScope,
  type OrgScope,
  type ProjectScope,
  type Resolved,
} from "@mykey/db";
import type { Principal } from "./authn.ts";
import { ApiError, type AppDeps } from "./context.ts";
import { checkStates } from "./states.ts";

export type Scope = OrgScope | ProjectScope | EnvironmentScope;

export interface Access {
  scope: Scope | null;
  authority: Authority | null;
  /** The rows the decision was made on (Run 3.9: the state check comes after a replay lookup). */
  resolved: Resolved | null;
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
  if (route.scope === "none") return { scope: null, authority: null, resolved: null };
  const base = { route, principal, requestId };
  const named = [params.env, params.project, params.org, params.operation];
  const deepest = named.find((id) => id !== undefined) ?? null;
  const hidden = (organizationId: string | null) =>
    deny(deps, { ...base, reason: "hidden", code: "not_found", organizationId, targetId: deepest });

  // Operations are resolved by Run 4.1; until then every id is unknown.
  if (route.scope === "operation") return hidden(null);

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
