// The operator's organization provisioning (Run 3.8, P-54, P-55). One durable
// operation per organization; every step reads its object first and acts only
// on an absence — an object that differs from the plan stops the run for
// review and is never overwritten. A resumed run starts at the first step.
import { randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import type { OperationId, OrganizationId } from "@mykey/contracts";
import { insertOperation, withTransaction } from "@mykey/db";
import type { AppRoleName } from "@mykey/openbao";
import type { OpenBaoAdmin } from "@mykey/openbao/admin";
import type pg from "pg";
import {
  APPROLE_NAMES,
  appRoleEquals,
  configDigest,
  isFreshKvConfig,
  kvConfigOf,
  kvMountOf,
  organizationPlan,
  type OrganizationPlan,
} from "./plan.ts";

export const ORGANIZATION_STEPS = [
  "owner-binding",
  "namespace",
  "kv-mount",
  "approle-auth",
  "policy:runtime",
  "policy:issuer",
  "policy:provisioner",
  "approle:runtime",
  "approle:issuer",
  "approle:provisioner",
  "read-back",
  "secret-ids",
  "activate",
] as const;
export type OrganizationStep = (typeof ORGANIZATION_STEPS)[number];

/** Every point a test may stop the run at: before, after the effect, after its record. */
export const ORGANIZATION_POINTS: readonly string[] = ORGANIZATION_STEPS.flatMap((step) => [
  `${step}:before`,
  `${step}:after-effect`,
  `${step}:after-record`,
]);

export type StepOutcome = "verified" | "written" | "mismatch" | "unknown";

export type ProvisionResult =
  | { outcome: "active"; operationId: OperationId; configDigest: string }
  | { outcome: "review"; operationId: OperationId; step: string }
  | { outcome: "retry"; operationId: OperationId; step: string; cause: string }
  | { outcome: "refused"; reason: "no_organization" | "no_owner" | "several_owners" }
  | { outcome: "busy" };

export interface ProvisionDeps {
  /** Logged in as `maintenance` (the operator identity). */
  pool: pg.Pool;
  admin: OpenBaoAdmin;
  /** Installs a role's new credential where its process reads it. */
  deliver: (name: AppRoleName, credential: { roleId: string; secretId: string }) => Promise<void>;
  boundCidrs: Record<AppRoleName, readonly string[]>;
  crashAt?: (point: string) => void;
}

const ACTION = "organization.provision";

class Stop extends Error {
  readonly kind: "mismatch" | "unknown";
  readonly step: string;
  readonly detail: string;

  constructor(kind: "mismatch" | "unknown", step: string, detail: string) {
    super(`${kind} at ${step}`);
    this.kind = kind;
    this.step = step;
    this.detail = detail;
  }
}

// ------------------------------------------------------------------ compare

/** Names of the objects that differ from the plan (empty: equal). Reads only. */
async function compareAll(admin: OpenBaoAdmin, plan: OrganizationPlan): Promise<string[]> {
  const { namespace } = plan;
  if (!(await admin.readNamespace(namespace))) return ["namespace"];
  const differs: string[] = [];
  const mount = await admin.readKvMount(namespace);
  const config = await admin.readKvConfig(namespace);
  if (
    mount === null ||
    config === null ||
    !isKvMountEqual(mount, plan) ||
    !isKvConfigEqual(config, plan)
  ) {
    differs.push("kv-mount");
  }
  if ((await admin.readAuthMount(namespace, "approle")) !== "approle") differs.push("approle-auth");
  for (const name of APPROLE_NAMES) {
    if ((await admin.readPolicy(namespace, name)) !== plan.policies[name]) {
      differs.push(`policy:${name}`);
    }
  }
  if (!differs.includes("approle-auth")) {
    for (const name of APPROLE_NAMES) {
      const role = await admin.readAppRole(namespace, name);
      if (role === null || !appRoleEquals(role, plan.appRoles[name])) {
        differs.push(`approle:${name}`);
      }
    }
  } else {
    differs.push(...APPROLE_NAMES.map((name) => `approle:${name}`));
  }
  return differs;
}

function isKvMountEqual(read: Record<string, unknown>, plan: OrganizationPlan): boolean {
  const { type, version } = kvMountOf(read);
  return type === plan.kvMount.type && version === plan.kvMount.version;
}

function isKvConfigEqual(read: Record<string, unknown>, plan: OrganizationPlan): boolean {
  const config = kvConfigOf(read);
  return (
    config.cas_required === plan.kvConfig.cas_required &&
    config.max_versions === plan.kvConfig.max_versions &&
    config.delete_version_after === plan.kvConfig.delete_version_after
  );
}

/** `ops verify-organization`: every object read back with the operator token; nothing written. */
export async function verifyOrganization(
  deps: { admin: OpenBaoAdmin; boundCidrs: Record<AppRoleName, readonly string[]> },
  organizationId: OrganizationId,
): Promise<{ differs: string[] }> {
  return {
    differs: await compareAll(deps.admin, organizationPlan(organizationId, deps.boundCidrs)),
  };
}

// -------------------------------------------------------------------- steps

type Effect = () => Promise<"verified" | "written">;

function stepEffects(
  deps: ProvisionDeps,
  plan: OrganizationPlan,
  state: { digest: string | null },
): Record<Exclude<OrganizationStep, "owner-binding" | "activate">, Effect> {
  const { admin } = deps;
  const { namespace } = plan;
  const mismatch = (step: string): never => {
    throw new Stop("mismatch", step, "differs from the plan");
  };
  const confirm = (step: string, equal: boolean): "written" => {
    if (!equal) throw new Stop("unknown", step, "read-back differs after the write");
    return "written";
  };

  const policy =
    (name: AppRoleName): Effect =>
    async () => {
      const step = `policy:${name}`;
      const read = await admin.readPolicy(namespace, name);
      if (read === plan.policies[name]) return "verified";
      if (read !== null) return mismatch(step);
      await admin.putPolicy(namespace, name, plan.policies[name]);
      return confirm(step, (await admin.readPolicy(namespace, name)) === plan.policies[name]);
    };

  const appRole =
    (name: AppRoleName): Effect =>
    async () => {
      const step = `approle:${name}`;
      const read = await admin.readAppRole(namespace, name);
      if (read !== null)
        return appRoleEquals(read, plan.appRoles[name]) ? "verified" : mismatch(step);
      const { ttlSeconds, boundCidrs } = plan.appRoleWrites[name];
      await admin.putAppRole(namespace, name, ttlSeconds, boundCidrs);
      const back = await admin.readAppRole(namespace, name);
      return confirm(step, back !== null && appRoleEquals(back, plan.appRoles[name]));
    };

  return {
    namespace: async () => {
      if (await admin.readNamespace(namespace)) return "verified";
      await admin.createNamespace(namespace);
      return confirm("namespace", await admin.readNamespace(namespace));
    },
    "kv-mount": async () => {
      let mount = await admin.readKvMount(namespace);
      let wrote = false;
      if (mount === null) {
        await admin.mountKvOnly(namespace);
        mount = await admin.readKvMount(namespace);
        wrote = true;
      }
      if (mount === null) throw new Stop("unknown", "kv-mount", "mount not read back");
      if (!isKvMountEqual(mount, plan)) return mismatch("kv-mount");
      const config = await admin.readKvConfig(namespace);
      if (config !== null && isKvConfigEqual(config, plan)) return wrote ? "written" : "verified";
      // A mount this command made and was stopped before configuring still has the defaults.
      if (config !== null && !isFreshKvConfig(config)) return mismatch("kv-mount");
      await admin.putKvConfig(namespace, plan.kvConfig);
      const back = await admin.readKvConfig(namespace);
      return confirm("kv-mount", back !== null && isKvConfigEqual(back, plan));
    },
    "approle-auth": async () => {
      const type = await admin.readAuthMount(namespace, "approle");
      if (type === "approle") return "verified";
      if (type !== null) return mismatch("approle-auth");
      await admin.enableAppRole(namespace);
      return confirm(
        "approle-auth",
        (await admin.readAuthMount(namespace, "approle")) === "approle",
      );
    },
    "policy:runtime": policy("runtime"),
    "policy:issuer": policy("issuer"),
    "policy:provisioner": policy("provisioner"),
    "approle:runtime": appRole("runtime"),
    "approle:issuer": appRole("issuer"),
    "approle:provisioner": appRole("provisioner"),
    "read-back": async () => {
      const differs = await compareAll(admin, plan);
      if (differs.length > 0) return mismatch(differs[0] ?? "read-back");
      const kvMount = await admin.readKvMount(namespace);
      const kvConfig = await admin.readKvConfig(namespace);
      if (kvMount === null || kvConfig === null) {
        throw new Stop("unknown", "read-back", "mount vanished");
      }
      state.digest = configDigest({ kvMount, kvConfig, policies: plan.policies });
      return "verified";
    },
    "secret-ids": async () => {
      for (const name of APPROLE_NAMES) {
        for (const accessor of await admin.listSecretIdAccessors(namespace, name)) {
          await admin.destroySecretIdAccessor(namespace, name, accessor);
        }
        const { secretId } = await admin.newSecretId(namespace, name);
        const { roleId } = await admin.readRoleId(namespace, name);
        await deps.deliver(name, { roleId, secretId });
      }
      return "written";
    },
  };
}

// ---------------------------------------------------------------- the run

async function ownerCount(pool: pg.Pool, organizationId: string): Promise<number | null> {
  const result = await pool.query<{ exists: boolean; owners: number }>(
    `SELECT EXISTS (SELECT 1 FROM app.organization WHERE id = $1) AS exists,
            (SELECT count(*)::int FROM app.membership
              WHERE organization_id = $1 AND role = 'owner' AND state = 'active') AS owners`,
    [organizationId],
  );
  const row = result.rows[0];
  return row?.exists === true ? row.owners : null;
}

async function openOperation(pool: pg.Pool, organizationId: OrganizationId): Promise<OperationId> {
  return withTransaction(pool, async (tx) => {
    const key = {
      principalKind: "operator" as const,
      principalId: "operator",
      action: ACTION,
      target: organizationId,
      idempotencyKey: organizationId,
    };
    await insertOperation(tx, {
      ...key,
      id: randomUUID() as OperationId,
      organizationId,
      state: "executing",
      fingerprint: null,
      fingerprintKeyId: null,
      result: null,
    });
    const found = await tx.query<{ id: OperationId }>(
      `SELECT id FROM app.operation
        WHERE principal_kind = $1 AND principal_id = $2 AND action = $3 AND target = $4
          AND idempotency_key = $5`,
      [key.principalKind, key.principalId, key.action, key.target, key.idempotencyKey],
    );
    const id = found.rows[0]?.id;
    if (id === undefined) throw new Error("operation row not found after insert");
    await tx.query(
      "UPDATE app.operation SET state = 'executing', error_code = NULL WHERE id = $1 AND state <> 'succeeded'",
      [id],
    );
    return id;
  });
}

async function nextOrdinal(pool: pg.Pool, operationId: OperationId): Promise<number> {
  const result = await pool.query<{ next: number }>(
    "SELECT coalesce(max(ordinal), 0)::int + 1 AS next FROM app.operation_step WHERE operation_id = $1",
    [operationId],
  );
  return result.rows[0]?.next ?? 1;
}

export async function provisionOrganization(
  deps: ProvisionDeps,
  organizationId: OrganizationId,
): Promise<ProvisionResult> {
  const { pool } = deps;
  const lock = await pool.connect();
  try {
    const held = await lock.query<{ held: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held",
      [`${ACTION}:${organizationId}`],
    );
    if (held.rows[0]?.held !== true) return { outcome: "busy" };
    try {
      return await provisionLocked(deps, organizationId);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        `${ACTION}:${organizationId}`,
      ]);
    }
  } finally {
    lock.release();
  }
}

async function provisionLocked(
  deps: ProvisionDeps,
  organizationId: OrganizationId,
): Promise<ProvisionResult> {
  const { pool } = deps;
  const crash = (point: string) => deps.crashAt?.(point);
  const owners = await ownerCount(pool, organizationId);
  if (owners === null) return { outcome: "refused", reason: "no_organization" };

  const operationId = await openOperation(pool, organizationId);
  let ordinal = await nextOrdinal(pool, operationId);
  const plan = organizationPlan(organizationId, deps.boundCidrs);
  const state: { digest: string | null } = { digest: null };
  const effects = stepEffects(deps, plan, state);

  const record = async (step: string): Promise<string> => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO app.operation_step (id, operation_id, ordinal, target) VALUES ($1, $2, $3, $4)`,
      [id, operationId, ordinal, step],
    );
    ordinal += 1;
    return id;
  };
  const finish = (stepId: string, outcome: StepOutcome) =>
    pool.query("UPDATE app.operation_step SET outcome = $2 WHERE id = $1", [stepId, outcome]);

  for (const step of ORGANIZATION_STEPS) {
    const stepId = await record(step);
    crash(`${step}:before`);
    let outcome: StepOutcome;
    try {
      if (step === "owner-binding") {
        if (owners !== 1) {
          await finish(stepId, "mismatch");
          await pool.query(
            "UPDATE app.operation SET state = 'rejected', error_code = $2, completed_at = now() WHERE id = $1",
            [operationId, owners === 0 ? "no_owner" : "several_owners"],
          );
          return { outcome: "refused", reason: owners === 0 ? "no_owner" : "several_owners" };
        }
        outcome = "verified";
      } else if (step === "activate") {
        if (state.digest === null) throw new Stop("unknown", step, "no digest");
        await activate(pool, organizationId, operationId, state.digest);
        outcome = "written";
      } else {
        outcome = await effects[step]();
      }
    } catch (error) {
      const stop =
        error instanceof Stop
          ? error
          : new Stop("unknown", step, error instanceof Error ? error.message : "error");
      await finish(stepId, stop.kind);
      if (stop.kind === "mismatch") {
        await review(pool, organizationId, operationId, step);
        return { outcome: "review", operationId, step };
      }
      await pool.query(
        "UPDATE app.operation SET state = 'uncertain', error_code = 'outcome_unknown' WHERE id = $1 AND state <> 'succeeded'",
        [operationId],
      );
      return { outcome: "retry", operationId, step, cause: stop.detail };
    }
    crash(`${step}:after-effect`);
    await finish(stepId, outcome);
    crash(`${step}:after-record`);
  }
  if (state.digest === null) throw new Error("unreachable: activated without a digest");
  return { outcome: "active", operationId, configDigest: state.digest };
}

async function activate(
  pool: pg.Pool,
  organizationId: OrganizationId,
  operationId: OperationId,
  digest: string,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const before = await tx.query<{ state: string }>(
      "SELECT state FROM app.organization WHERE id = $1 FOR UPDATE",
      [organizationId],
    );
    await tx.query(
      `UPDATE app.organization
          SET state = 'active', review_reason = NULL, config_digest = $2, provisioning_operation_id = $3
        WHERE id = $1`,
      [organizationId, digest, operationId],
    );
    await tx.query(
      `UPDATE app.operation
          SET state = 'succeeded', error_code = NULL, result = $2, completed_at = coalesce(completed_at, now())
        WHERE id = $1`,
      [operationId, JSON.stringify({ configDigest: digest })],
    );
    if (before.rows[0]?.state !== "active") {
      await appendAudit(tx, {
        action: "operator.organization_provision",
        actor: { kind: "operator", id: null },
        source: "operator",
        organizationId,
        target: { kind: "organization", id: organizationId },
        outcome: "success",
        requestId: null,
        operationId,
        details: { outcome: "active" },
      });
    }
  });
}

async function review(
  pool: pg.Pool,
  organizationId: OrganizationId,
  operationId: OperationId,
  step: string,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await tx.query(
      "UPDATE app.organization SET state = 'needs_review', review_reason = 'backend_inconsistent' WHERE id = $1",
      [organizationId],
    );
    await tx.query(
      "UPDATE app.operation SET state = 'awaiting_input', error_code = 'backend_inconsistent' WHERE id = $1",
      [operationId],
    );
    await appendAudit(tx, {
      action: "operator.organization_provision",
      actor: { kind: "operator", id: null },
      source: "operator",
      organizationId,
      target: { kind: "organization", id: organizationId },
      outcome: "failure",
      requestId: null,
      operationId,
      details: { outcome: "review", step },
    });
  });
}
