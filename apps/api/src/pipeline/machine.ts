// Machine authentication (Run 5.4, P-93, FR-1.44, D-42): the presented token
// is the only credential and the binding is the authorization.
//
//  1. Exactly one Authorization header `Bearer <token>`, the token at most
//     LIMITS.body.bearerMaxBytes of `A-Za-z0-9._-` — else 401, before any
//     request to OpenBao.
//  2. The namespace is this process's own organization, never the request's.
//  3. lookup-self with the presented token: denied or a 4xx → 401; sealed →
//     backend_sealed; anything else → dependency_unavailable.
//  4. One statement: the credential by (organization, accessor) with its
//     project, environment and organization. Absent → 401 (counted in the log
//     only); not `active` or past `effective_expires_at` on database time → 401.
//  5. The path's project and environment name must be the credential's own →
//     404 not_found, the same for an absent and a foreign target.
//  6. The organization, project and environment must be active: revoking or
//     archived → 403 action_denied; in review → 503 backend_inconsistent.
//
// Denials of a recognized credential (4–6) are audited as `access.denied` with
// a machine actor. The token stays a local of this module and of the reader
// client built from it; it is never logged, stored or put into an error.
//
// Session 11 (Run 11.3, P-188): a token that an exchange minted has no row of
// its own. Its `meta` says so and names its runtime credential, and step 4
// finds that row by id instead. Only the issuer can make a token from a
// machine role (D-17), and a wrong `meta` could only change which row is
// checked, never what OpenBao lets the token read; still the token's policy
// must be the one of that row's environment, or nobody is recognized. A
// runtime credential's networks are checked on every request (the source as
// the edge reports it), between the state and the path.
import { appendAudit } from "@mykey/audit";
import {
  LIMITS,
  credentialIdSchema,
  type CredentialId,
  type EnvironmentId,
  type ErrorCode,
  type OrganizationId,
  type ProjectId,
  type RouteDef,
} from "@mykey/contracts";
import { isCaptureRefusal, type EnvironmentScope } from "@mykey/db";
import { machineName, type OpenBaoClient } from "@mykey/openbao";
import { sourceAllowed } from "@mykey/operations";
import { now } from "../log.ts";
import { ApiError, type AppDeps } from "./context.ts";

export interface MachinePrincipal {
  kind: "machine";
  credentialId: CredentialId;
  scope: EnvironmentScope;
  /** Built from the presented token; this request only. */
  reader: OpenBaoClient;
}

const TOKEN = /^[A-Za-z0-9._-]+$/;
const BEARER = "Bearer ";

/** The token of the one Authorization header, or null when the header is not exactly one bearer. */
export function bearerOf(rawHeaders: readonly string[]): string | null {
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const value = rawHeaders[index + 1];
    if (rawHeaders[index]?.toLowerCase() === "authorization" && value !== undefined) {
      values.push(value);
    }
  }
  const [value] = values;
  if (values.length !== 1 || value === undefined) return null;
  if (!value.startsWith(BEARER)) return null;
  const token = value.slice(BEARER.length);
  if (token === "" || Buffer.byteLength(token, "utf8") > LIMITS.body.bearerMaxBytes) return null;
  return TOKEN.test(token) ? token : null;
}

interface CatalogRow {
  id: CredentialId;
  kind: "token" | "runtime";
  state: string;
  live: boolean;
  bound_cidrs: string[];
  project_id: ProjectId;
  environment_id: EnvironmentId;
  environment_name: string;
  environment_state: string;
  project_state: string;
  organization_state: string;
}

/** The reason of a refusal after OpenBao was asked about a token nobody can attribute (P-113). */
export const MISSED_LOOKUP = "missed_lookup";

function unattributable(deps: AppDeps, requestId: string, cause: "header" | "token" | "catalog") {
  deps.log({ event: "machine_unauthenticated", time: now(), requestId, cause });
  // Only a refusal that cost a lookup counts against the source (rl:machine-miss).
  return new ApiError("unauthenticated", cause === "header" ? undefined : MISSED_LOOKUP);
}

/** A parent's state as the machine routes answer it (P-93). */
export function parentCode(state: string): ErrorCode | null {
  if (state === "active") return null;
  if (state === "needs_review") return "backend_inconsistent";
  return "action_denied";
}

/**
 * The refusal of a recognized credential, audited with the machine actor.
 * `source` (Session 11): the caller is outside the credential's networks; the
 * row says so and holds no address.
 */
export async function denyMachine(
  deps: AppDeps,
  input: {
    route: RouteDef;
    requestId: string;
    organizationId: OrganizationId;
    row: { id: CredentialId; environment_id: EnvironmentId };
    reason: "hidden" | "state" | "source";
    code: ErrorCode;
  },
): Promise<never> {
  await appendAudit(deps.pool, {
    action: "access.denied",
    actor: { kind: "machine", id: input.row.id },
    source: "api",
    organizationId: input.organizationId,
    target: { kind: "environment", id: input.row.environment_id },
    outcome: "denied",
    requestId: input.requestId,
    operationId: null,
    details: { routeId: input.route.id, reason: input.reason },
  });
  throw new ApiError(input.code, input.reason);
}

/** At most once a minute per credential; its failure never changes the answer. */
export async function touch(deps: AppDeps, credentialId: CredentialId): Promise<void> {
  try {
    await deps.pool.query(
      `UPDATE app.machine_credential SET last_used_at = now()
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [credentialId],
    );
  } catch (error) {
    // P-118: skipped while a pair is captured.
    if (isCaptureRefusal(error)) return;
    deps.log({
      event: "machine_last_used",
      time: now(),
      outcome: "failed",
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
    });
  }
}

export async function authenticateMachine(
  deps: AppDeps,
  rawHeaders: readonly string[],
  params: Record<string, string>,
  route: RouteDef,
  requestId: string,
  /** The request's source (source.ts): what a runtime credential's networks are checked against. */
  source: string,
): Promise<MachinePrincipal> {
  const token = bearerOf(rawHeaders);
  if (token === null) throw unattributable(deps, requestId, "header");
  const organizationId = deps.bao?.organizationId() ?? null;
  if (deps.bao === undefined || organizationId === null) {
    throw new ApiError("dependency_unavailable");
  }
  const reader = deps.bao.withToken(organizationId, token);
  if (reader === null) throw new ApiError("dependency_unavailable");

  const self = await reader.tokenLookupSelf();
  if (!self.ok) {
    // A 5xx (OpenBao's audit device cannot write, Run 6.1) says nothing about the token.
    if (
      self.kind === "denied" ||
      (self.kind === "invalid" && self.status >= 400 && self.status < 500)
    ) {
      throw unattributable(deps, requestId, "token");
    }
    if (self.kind === "sealed") throw new ApiError("backend_sealed");
    throw new ApiError("dependency_unavailable");
  }

  // P-188: an exchanged token says what it is and names its runtime credential;
  // every other token is found by its accessor, as before. Never both.
  const named =
    self.data.meta?.exchange === "1"
      ? credentialIdSchema.safeParse(self.data.meta.credential_id)
      : null;
  if (named !== null && !named.success) throw unattributable(deps, requestId, "catalog");
  const runtimeId = named === null ? null : named.data;
  const found = await deps.pool.query<CatalogRow>(
    `SELECT c.id, c.kind, c.state, coalesce(c.effective_expires_at > now(), false) AS live,
            c.bound_cidrs,
            c.project_id, c.environment_id, e.name AS environment_name,
            e.state AS environment_state, p.state AS project_state,
            o.state AS organization_state
       FROM app.machine_credential c
       JOIN app.environment e
         ON e.organization_id = c.organization_id AND e.project_id = c.project_id
        AND e.id = c.environment_id
       JOIN app.project p ON p.organization_id = c.organization_id AND p.id = c.project_id
       JOIN app.organization o ON o.id = c.organization_id
      WHERE c.organization_id = $1
        AND (($3::uuid IS NULL AND c.kind = 'token' AND c.accessor = $2)
          OR ($3::uuid IS NOT NULL AND c.kind = 'runtime' AND c.id = $3::uuid))`,
    [organizationId, self.data.accessor, runtimeId],
  );
  const row = found.rows[0];
  if (row === undefined) throw unattributable(deps, requestId, "catalog");
  // The row was found by what the token says of itself: its policy must be the
  // one of that row's environment, or the token names a credential it is not of.
  if (row.kind === "runtime") {
    const policies = self.data.policies;
    if (policies.length !== 1 || policies[0] !== machineName(row.environment_id)) {
      throw unattributable(deps, requestId, "catalog");
    }
  }
  const deny = (reason: "hidden" | "state" | "source", code: ErrorCode) =>
    denyMachine(deps, { route, requestId, organizationId, row, reason, code });
  if (row.state !== "active" || !row.live) await deny("state", "unauthenticated");
  if (!sourceAllowed(row.bound_cidrs, source)) await deny("source", "unauthenticated");
  if (params.project !== row.project_id || params.envName !== row.environment_name) {
    await deny("hidden", "not_found");
  }
  for (const state of [row.organization_state, row.project_state, row.environment_state]) {
    const code = parentCode(state);
    if (code === "action_denied") await deny("state", code);
    if (code !== null) throw new ApiError(code);
  }
  await touch(deps, row.id);
  return {
    kind: "machine",
    credentialId: row.id,
    scope: {
      organizationId,
      projectId: row.project_id,
      environmentId: row.environment_id,
    },
    reader,
  };
}

/** Any query parameter, and any body but none or `{}`, is a selector (P-93). */
export function hasSelector(url: string, body: unknown): boolean {
  if (new URL(url).searchParams.size > 0) return true;
  if (body === undefined) return false;
  return (
    typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length > 0
  );
}
