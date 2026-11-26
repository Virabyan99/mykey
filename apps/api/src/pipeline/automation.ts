// The automation auth class (Session 11, Run 11.5; P-191 to P-194, D-82): the
// bearer is an automation credential's secret, `mkac.<id>.<secret>`.
//
// A request, in order (route.ts calls these):
//
//  1. authenticateAutomation — exactly one Authorization header `Bearer <text>`
//     of that shape, else 401 before anything is read. One statement: the
//     credential by (organization, id). Absent, or the verifier does not match
//     the row as it is now: 401, a log line, one miss counted against the
//     source and no audit row (D-42: nobody can attribute the refusal). From
//     here the caller is known, and a refusal is audited as `access.denied`
//     with the machine actor: not `active`, past its expiry on database time,
//     or a source outside its networks → 401.
//  2. authorizeAutomation — the path. `:project` must be a project of this
//     organization that the caller's chain manages, and `:env` an environment
//     of that project; an operation must be one a credential of the chain
//     made. Everything else — another chain's, the owner's, an absent id, a
//     text that is no id — is one 404 (reason `hidden`). Then the route's
//     right, else 403 (reason `action`).
//  3. admitAutomationStates — the states (P-53), after a replay lookup.
//  4. automationRecheck — the credential, the right, the managed project and
//     the states again, inside the admission transaction (FR-1.10).
//
// OpenBao is not asked: the secret is not a token. It stays a local of
// authenticateAutomation; it is never logged, stored or put into an error.
import { appendAudit } from "@mykey/audit";
import {
  AUTOMATION_SECRET_PREFIX,
  parsePresentedSecret,
  type AutomationRight,
  type ErrorCode,
  type OperationId,
  type OrganizationId,
  type RouteDef,
} from "@mykey/contracts";
import {
  automationCredentialNow,
  chainHasCredential,
  findAutomationForAuth,
  findOperation,
  isCaptureRefusal,
  lockParents,
  resolveManaged,
  touchAutomationCredential,
  type OrgScope,
} from "@mykey/db";
import { automationBinding, sourceAllowed, verifierOf, verifies } from "@mykey/operations";
import type pg from "pg";
import { now } from "../log.ts";
import type { Access, Scope } from "./authz.ts";
import { ApiError, type AppDeps } from "./context.ts";
import { MISSED_LOOKUP, bearerOf } from "./machine.ts";
import { checkStates } from "./states.ts";

/** The automation credential whose secret a request presented. */
export interface AutomationPrincipal {
  kind: "automation";
  credentialId: string;
  /** The chain (P-193): what decides which projects it manages. */
  ownerId: string;
  /** The organization this process serves; never one taken from the request. */
  organizationId: OrganizationId;
  rights: ReadonlySet<AutomationRight>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Reason = "hidden" | "action" | "state" | "source";

/** What a refusal is about: the deepest thing the path names, when that is an id. */
function targetOf(
  organizationId: string,
  params: Record<string, string>,
): { kind: string; id: string | null } {
  const idOrNull = (id: string): string | null => (UUID.test(id) ? id : null);
  if (params.env !== undefined) return { kind: "environment", id: idOrNull(params.env) };
  if (params.project !== undefined) return { kind: "project", id: idOrNull(params.project) };
  return { kind: "organization", id: organizationId };
}

/** The refusal of a recognised credential, audited with the machine actor; the row holds no address. */
async function denyAutomation(
  deps: AppDeps,
  input: {
    route: RouteDef;
    requestId: string;
    organizationId: string;
    credentialId: string;
    target: { kind: string; id: string | null };
    reason: Reason;
    code: ErrorCode;
  },
): Promise<never> {
  await appendAudit(deps.pool, {
    action: "access.denied",
    actor: { kind: "machine", id: input.credentialId },
    source: "api",
    organizationId: input.organizationId,
    target: input.target,
    outcome: "denied",
    requestId: input.requestId,
    operationId: null,
    details: { routeId: input.route.id, reason: input.reason },
  });
  throw new ApiError(input.code, input.reason);
}

export async function authenticateAutomation(
  deps: AppDeps,
  rawHeaders: readonly string[],
  source: string,
  route: RouteDef,
  requestId: string,
): Promise<AutomationPrincipal> {
  const unattributable = (cause: "header" | "catalog"): ApiError => {
    deps.log({ event: "machine_unauthenticated", time: now(), requestId, cause });
    // Only a refusal that cost a read counts against the source (rl:machine-miss).
    return new ApiError("unauthenticated", cause === "header" ? undefined : MISSED_LOOKUP);
  };
  const text = bearerOf(rawHeaders);
  const presented = text === null ? null : parsePresentedSecret(text);
  if (text === null || presented?.prefix !== AUTOMATION_SECRET_PREFIX) {
    throw unattributable("header");
  }
  const organizationId = deps.bao?.organizationId() ?? null;
  const ring = deps.auth?.keys.resetVerifier;
  if (organizationId === null || ring === undefined) throw new ApiError("dependency_unavailable");

  const row = await findAutomationForAuth(deps.pool, organizationId, presented.id);
  if (row === null) {
    // The same work as for a row that exists: an id is not learned from the time.
    verifierOf(ring, text, []);
    throw unattributable("catalog");
  }
  // The verifier was made over the row's chain, rights and networks as issued
  // (D-82): a row that gained a right, changed chain or lost its networks is nobody's.
  const bound = automationBinding(organizationId, row.ownerId, row.rights, row.boundCidrs);
  if (!verifies(ring, { digest: row.verifier, keyId: row.verifierKeyId }, text, bound)) {
    throw unattributable("catalog");
  }
  const deny = (reason: Reason) =>
    denyAutomation(deps, {
      route,
      requestId,
      organizationId,
      credentialId: row.id,
      target: { kind: "organization", id: organizationId },
      reason,
      code: "unauthenticated",
    });
  if (row.state !== "active" || !row.live) await deny("state");
  if (!sourceAllowed(row.boundCidrs, source)) await deny("source");
  try {
    // At most once a minute; its failure never changes the answer.
    await touchAutomationCredential(deps.pool, row.id);
  } catch (error) {
    // P-118: skipped while a pair is captured.
    if (!isCaptureRefusal(error)) {
      deps.log({
        event: "machine_last_used",
        time: now(),
        outcome: "failed",
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }
  return {
    kind: "automation",
    credentialId: row.id,
    ownerId: row.ownerId,
    organizationId,
    rights: new Set(row.rights),
  };
}

/** The ids of the path, when each is an id; null when one is not. */
function pathIds(
  params: Record<string, string>,
): { projectId?: string; environmentId?: string } | null {
  const { project, env } = params;
  if ((project !== undefined && !UUID.test(project)) || (env !== undefined && !UUID.test(env))) {
    return null;
  }
  return {
    ...(project === undefined ? {} : { projectId: project }),
    ...(env === undefined ? {} : { environmentId: env }),
  };
}

/** True when the route asks for a right that `has` does not find. */
function lacksRight(route: RouteDef, has: (right: AutomationRight) => boolean): boolean {
  return route.right !== null && route.right !== "any" && !has(route.right);
}

/** The path, then the right. `authority` is null: an automation credential has rights, not a role. */
export async function authorizeAutomation(
  deps: AppDeps,
  route: RouteDef,
  params: Record<string, string>,
  principal: AutomationPrincipal,
  requestId: string,
): Promise<Access> {
  const { organizationId } = principal;
  const refuse = (reason: Reason, code: ErrorCode) =>
    denyAutomation(deps, {
      route,
      requestId,
      organizationId,
      credentialId: principal.credentialId,
      target: targetOf(organizationId, params),
      reason,
      code,
    });
  const hidden = () => refuse("hidden", "not_found");

  if (params.operation !== undefined) {
    // An operation is its maker's: one a credential of the caller's chain made.
    if (!UUID.test(params.operation)) return hidden();
    const operation = await findOperation(deps.pool, params.operation as OperationId);
    if (
      operation?.organizationId !== organizationId ||
      operation.principalKind !== "machine" ||
      !(await chainHasCredential(
        deps.pool,
        organizationId,
        principal.ownerId,
        operation.principalId,
      ))
    ) {
      return hidden();
    }
    const resolved = await resolveManaged(deps.pool, organizationId, principal.ownerId, {});
    return { scope: { organizationId } as Scope, authority: null, resolved, operation };
  }

  const ids = pathIds(params);
  if (ids === null) return hidden();
  const resolved = await resolveManaged(deps.pool, organizationId, principal.ownerId, ids);
  if (resolved.organization === null) return hidden();
  if (ids.projectId !== undefined && resolved.project === null) return hidden();
  if (ids.environmentId !== undefined && resolved.environment === null) return hidden();
  if (lacksRight(route, (right) => principal.rights.has(right))) {
    return refuse("action", "action_denied");
  }
  return { scope: { organizationId, ...ids } as Scope, authority: null, resolved };
}

/** The state step (P-53) of an automation request: after the path, the right and a replay lookup. */
export async function admitAutomationStates(
  deps: AppDeps,
  route: RouteDef,
  params: Record<string, string>,
  principal: AutomationPrincipal,
  requestId: string,
  access: Access,
): Promise<void> {
  if (access.resolved === null) return;
  const code = checkStates(route, access.resolved);
  if (code === null) return;
  await denyAutomation(deps, {
    route,
    requestId,
    organizationId: principal.organizationId,
    credentialId: principal.credentialId,
    target: targetOf(principal.organizationId, params),
    reason: "state",
    code,
  });
}

/**
 * The admission recheck (FR-1.10, Review focus 6): the parents locked FOR
 * SHARE, then the credential, its right, the managed project and the states
 * read again. A credential revoked, expired or replaced, or a project its
 * chain no longer manages, since the pipeline looked refuses the change in
 * its own transaction.
 */
export function automationRecheck(
  route: RouteDef,
  principal: AutomationPrincipal,
  scope: OrgScope & { projectId?: string; environmentId?: string },
) {
  return async (tx: pg.PoolClient): Promise<ErrorCode | null> => {
    await lockParents(tx, scope, null);
    const credential = await automationCredentialNow(
      tx,
      principal.organizationId,
      principal.credentialId,
    );
    if (
      credential?.state !== "active" ||
      !credential.live ||
      credential.ownerId !== principal.ownerId
    ) {
      return "unauthenticated";
    }
    if (lacksRight(route, (right) => credential.rights.includes(right))) return "action_denied";
    const resolved = await resolveManaged(tx, principal.organizationId, principal.ownerId, {
      ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
      ...(scope.environmentId === undefined ? {} : { environmentId: scope.environmentId }),
    });
    if (resolved.organization === null) return "not_found";
    if (scope.projectId !== undefined && resolved.project === null) return "not_found";
    if (scope.environmentId !== undefined && resolved.environment === null) return "not_found";
    return checkStates(route, resolved);
  };
}
