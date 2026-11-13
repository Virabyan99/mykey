// The provisioner's drift sweep (Run 3.8, P-55): for an active organization,
// the KV mount, KV config and three policies against `config_digest`; for each
// of its active environments, the machine policy and token role against
// `policy_digest`. A difference or an absence sends that scope to review; an
// unreachable or sealed OpenBao changes nothing.
import { appendAudit } from "@mykey/audit";
import type { EnvironmentId, OrganizationId, ProjectId } from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import { machineName, renderMachinePolicy } from "@mykey/openbao";
import type { ProvisionerClient } from "@mykey/openbao/provisioner";
import type pg from "pg";
import { isDeepStrictEqual } from "node:util";
import { policyDigest, readableRole } from "./environment.ts";
import { APPROLE_NAMES, configDigest, kvConfigOf, kvMountOf, organizationPlan } from "./plan.ts";

export type DriftObject =
  | "kv_mount"
  | "kv_config"
  | "policy_runtime"
  | "policy_issuer"
  | "policy_provisioner"
  | "provisioner_login"
  | "machine_policy"
  | "machine_token_role";

export interface SweepDeps {
  /** Logged in as `provisioner_runtime`. */
  pool: pg.Pool;
  clientFor: (organizationId: OrganizationId) => Promise<ProvisionerClient | null>;
}

export interface Reviewed {
  scope: "organization" | "environment";
  id: string;
  object: DriftObject;
}

type Check = { ok: true } | { ok: false; object: DriftObject } | { ok: "skip" };

async function checkOrganization(
  client: ProvisionerClient,
  organizationId: OrganizationId,
  digest: string | null,
): Promise<Check> {
  const kvMount = await client.readKvMount();
  const kvConfig = await client.readKvConfig();
  // One after the other: the client logs in on its first call.
  const policies = [];
  for (const name of APPROLE_NAMES) policies.push(await client.readOrgPolicy(name));
  const answers = [kvMount, kvConfig, ...policies];
  for (const answer of answers) {
    if (!answer.ok) {
      return answer.cause === "denied"
        ? { ok: false, object: "provisioner_login" }
        : { ok: "skip" };
    }
  }
  if (!kvMount.ok || !kvConfig.ok) return { ok: "skip" };
  if (kvMount.value === null) return { ok: false, object: "kv_mount" };
  if (kvConfig.value === null) return { ok: false, object: "kv_config" };
  const texts = {} as Record<(typeof APPROLE_NAMES)[number], string>;
  for (const [index, name] of APPROLE_NAMES.entries()) {
    const answer = policies[index];
    if (!answer?.ok) return { ok: "skip" };
    if (answer.value === null) return { ok: false, object: `policy_${name}` };
    texts[name] = answer.value;
  }
  if (
    configDigest({ kvMount: kvMount.value, kvConfig: kvConfig.value, policies: texts }) === digest
  ) {
    return { ok: true };
  }
  // Name the object that differs from the plan.
  const plan = organizationPlan(organizationId, { runtime: [], issuer: [], provisioner: [] });
  const mount = kvMountOf(kvMount.value);
  if (mount.type !== plan.kvMount.type || mount.version !== plan.kvMount.version) {
    return { ok: false, object: "kv_mount" };
  }
  if (!isDeepStrictEqual(kvConfigOf(kvConfig.value), plan.kvConfig)) {
    return { ok: false, object: "kv_config" };
  }
  for (const name of APPROLE_NAMES) {
    if (texts[name] !== plan.policies[name]) return { ok: false, object: `policy_${name}` };
  }
  return { ok: false, object: "kv_config" };
}

async function checkEnvironment(
  client: ProvisionerClient,
  environment: { id: EnvironmentId; projectId: ProjectId; digest: string | null },
): Promise<Check> {
  const name = machineName(environment.id);
  const policy = await client.readMachinePolicy(name);
  const role = await client.readMachineTokenRole(name);
  for (const answer of [policy, role]) {
    if (!answer.ok) {
      return answer.cause === "denied"
        ? { ok: false, object: "provisioner_login" }
        : { ok: "skip" };
    }
  }
  if (!policy.ok || !role.ok) return { ok: "skip" };
  if (policy.value === null) return { ok: false, object: "machine_policy" };
  if (role.value === null) return { ok: false, object: "machine_token_role" };
  if (policyDigest(policy.value, role.value) === environment.digest) return { ok: true };
  if (policy.value !== renderMachinePolicy(environment.projectId, environment.id)) {
    return { ok: false, object: "machine_policy" };
  }
  if (!isDeepStrictEqual(role.value, readableRole(environment.id))) {
    return { ok: false, object: "machine_token_role" };
  }
  return { ok: false, object: "machine_policy" };
}

async function review(
  pool: pg.Pool,
  organizationId: OrganizationId,
  scope: "organization" | "environment",
  id: string,
  object: DriftObject,
): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    const updated =
      scope === "organization"
        ? await tx.query(
            `UPDATE app.organization SET state = 'needs_review', review_reason = 'backend_inconsistent'
              WHERE id = $1 AND state = 'active'`,
            [id],
          )
        : await tx.query(
            `UPDATE app.environment SET state = 'needs_review', review_reason = 'backend_inconsistent'
              WHERE organization_id = $1 AND id = $2 AND state = 'active'`,
            [organizationId, id],
          );
    // A scope already in review is not written again.
    if (updated.rowCount !== 1) return false;
    await appendAudit(tx, {
      action: "system.drift_detected",
      actor: { kind: "system", id: null },
      source: "system",
      organizationId,
      target: { kind: scope, id },
      outcome: "failure",
      requestId: null,
      operationId: null,
      details: { scope, object },
    });
    return true;
  });
}

export async function sweepOrganization(
  deps: SweepDeps,
  organizationId: OrganizationId,
): Promise<{ reviewed: Reviewed[] }> {
  const { pool } = deps;
  const reviewed: Reviewed[] = [];
  const organization = await pool.query<{ config_digest: string | null }>(
    "SELECT config_digest FROM app.organization WHERE id = $1 AND state = 'active'",
    [organizationId],
  );
  const row = organization.rows[0];
  if (row === undefined) return { reviewed };
  const client = await deps.clientFor(organizationId);
  if (client === null) return { reviewed };
  try {
    const org = await checkOrganization(client, organizationId, row.config_digest);
    if (org.ok === false) {
      if (await review(pool, organizationId, "organization", organizationId, org.object)) {
        reviewed.push({ scope: "organization", id: organizationId, object: org.object });
      }
      return { reviewed };
    }
    if (org.ok === "skip") return { reviewed };
    const environments = await pool.query<{
      id: EnvironmentId;
      project_id: ProjectId;
      policy_digest: string | null;
    }>(
      `SELECT id, project_id, policy_digest FROM app.environment
        WHERE organization_id = $1 AND state = 'active' ORDER BY id`,
      [organizationId],
    );
    for (const environment of environments.rows) {
      const check = await checkEnvironment(client, {
        id: environment.id,
        projectId: environment.project_id,
        digest: environment.policy_digest,
      });
      if (check.ok === "skip") return { reviewed };
      if (!check.ok) {
        const scope = check.object === "provisioner_login" ? "organization" : "environment";
        const id = scope === "organization" ? organizationId : environment.id;
        if (await review(pool, organizationId, scope, id, check.object)) {
          reviewed.push({ scope, id, object: check.object });
        }
        if (scope === "organization") return { reviewed };
      }
    }
    return { reviewed };
  } finally {
    await client.close();
  }
}

/** Sweeps every active organization this process serves. */
export async function sweepAll(deps: SweepDeps): Promise<Reviewed[]> {
  const organizations = await deps.pool.query<{ id: OrganizationId }>(
    "SELECT id FROM app.organization WHERE state = 'active' ORDER BY id",
  );
  const reviewed: Reviewed[] = [];
  for (const { id } of organizations.rows) {
    reviewed.push(...(await sweepOrganization(deps, id)).reviewed);
  }
  return reviewed;
}
