// The authentication of machine.exchange (Session 11, Run 11.3; P-187, D-81):
// the bearer is a runtime credential's client secret, `mkrc.<id>.<secret>`.
//
//  1. Exactly one Authorization header `Bearer <text>` of that shape — else
//     401, before anything is read.
//  2. One statement: the runtime credential by (organization, id) with its
//     project, environment and organization. Absent, or the verifier does not
//     match: 401, a log line, one miss counted against the source, and no
//     audit row (D-42: nobody can attribute the refusal).
//  3. From here the caller is known, and a refusal is audited as
//     `access.denied` with the machine actor: not `active`, past its expiry on
//     database time, or a source outside its networks → 401; a parent revoking
//     or archived → 403; in review → 503.
//
// OpenBao is not asked: a client secret is not a token. The secret stays a
// local of this module; it is never logged, stored or put into an error.
import {
  RUNTIME_SECRET_PREFIX,
  parsePresentedSecret,
  type CredentialId,
  type EnvironmentId,
  type ErrorCode,
  type ProjectId,
  type RouteDef,
} from "@mykey/contracts";
import type { EnvironmentScope } from "@mykey/db";
import { runtimeBinding, sourceAllowed, verifierOf, verifies } from "@mykey/operations";
import { now } from "../log.ts";
import { ApiError, type AppDeps } from "./context.ts";
import { MISSED_LOOKUP, bearerOf, denyMachine, parentCode, touch } from "./machine.ts";

/** The runtime credential whose client secret a request presented. */
export interface ExchangePrincipal {
  kind: "runtime_credential";
  credentialId: CredentialId;
  scope: EnvironmentScope;
  environmentName: string;
}

interface Row {
  id: CredentialId;
  state: string;
  live: boolean;
  verifier: Buffer;
  verifier_key_id: string;
  bound_cidrs: string[];
  project_id: ProjectId;
  environment_id: EnvironmentId;
  environment_name: string;
  environment_state: string;
  project_state: string;
  organization_state: string;
}

export async function authenticateExchange(
  deps: AppDeps,
  rawHeaders: readonly string[],
  route: RouteDef,
  requestId: string,
  source: string,
): Promise<ExchangePrincipal> {
  const unattributable = (cause: "header" | "catalog"): ApiError => {
    deps.log({ event: "machine_unauthenticated", time: now(), requestId, cause });
    // Only a refusal that cost a read counts against the source (rl:machine-miss).
    return new ApiError("unauthenticated", cause === "header" ? undefined : MISSED_LOOKUP);
  };
  const text = bearerOf(rawHeaders);
  const presented = text === null ? null : parsePresentedSecret(text);
  if (text === null || presented?.prefix !== RUNTIME_SECRET_PREFIX) throw unattributable("header");

  const organizationId = deps.bao?.organizationId() ?? null;
  const ring = deps.auth?.keys.resetVerifier;
  if (organizationId === null || ring === undefined) throw new ApiError("dependency_unavailable");

  const found = await deps.pool.query<Row>(
    `SELECT c.id, c.state, coalesce(c.effective_expires_at > now(), false) AS live,
            c.verifier, c.verifier_key_id, c.bound_cidrs,
            c.project_id, c.environment_id, e.name AS environment_name,
            e.state AS environment_state, p.state AS project_state,
            o.state AS organization_state
       FROM app.machine_credential c
       JOIN app.environment e
         ON e.organization_id = c.organization_id AND e.project_id = c.project_id
        AND e.id = c.environment_id
       JOIN app.project p ON p.organization_id = c.organization_id AND p.id = c.project_id
       JOIN app.organization o ON o.id = c.organization_id
      WHERE c.organization_id = $1 AND c.id = $2 AND c.kind = 'runtime'`,
    [organizationId, presented.id],
  );
  const row = found.rows[0];
  if (row === undefined) {
    // The same work as for a row that exists: an id is not learned from the time.
    verifierOf(ring, text, []);
    throw unattributable("catalog");
  }
  // The verifier was made over the row's environment and networks as issued
  // (D-81): a row that was moved or freed of its networks is nobody's.
  const bound = runtimeBinding(
    { organizationId, projectId: row.project_id, environmentId: row.environment_id },
    row.bound_cidrs,
  );
  if (!verifies(ring, { digest: row.verifier, keyId: row.verifier_key_id }, text, bound)) {
    throw unattributable("catalog");
  }

  const deny = (reason: "state" | "source", code: ErrorCode) =>
    denyMachine(deps, { route, requestId, organizationId, row, reason, code });
  if (row.state !== "active" || !row.live) await deny("state", "unauthenticated");
  if (!sourceAllowed(row.bound_cidrs, source)) await deny("source", "unauthenticated");
  for (const state of [row.organization_state, row.project_state, row.environment_state]) {
    const code = parentCode(state);
    if (code === "action_denied") await deny("state", code);
    if (code !== null) throw new ApiError(code);
  }
  await touch(deps, row.id);
  return {
    kind: "runtime_credential",
    credentialId: row.id,
    scope: {
      organizationId,
      projectId: row.project_id,
      environmentId: row.environment_id,
    },
    environmentName: row.environment_name,
  };
}
