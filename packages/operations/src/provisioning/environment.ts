// The provisioner's job `environment.provision` (Run 3.8, P-55): claim the
// operation, then compare-then-act for the environment's KV scope, machine
// policy and token role, then one transaction that makes it active. A
// difference is never overwritten; an unclear answer is retried by the queue.
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import {
  LIMITS,
  type EnvironmentId,
  type OperationId,
  type OrganizationId,
  type ProjectId,
} from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import { machineName, machineTokenRole, renderMachinePolicy } from "@mykey/openbao";
import type { ProvisionerClient, ReadableTokenRole } from "@mykey/openbao/provisioner";
import type pg from "pg";
import { isDeepStrictEqual } from "node:util";

export const ENVIRONMENT_STEPS = ["kv-scope", "machine-policy", "token-role"] as const;

/** Every point a test may stop the job at: each step's three, then the final transaction. */
export const ENVIRONMENT_POINTS: readonly string[] = [
  ...ENVIRONMENT_STEPS.flatMap((step) => [
    `${step}:before`,
    `${step}:after-effect`,
    `${step}:after-record`,
  ]),
  "activate:before",
  "activate:after-effect",
];

export interface EnvironmentDeps {
  /** Logged in as `provisioner_runtime`. */
  pool: pg.Pool;
  /** The provisioner client for an organization this process serves, or null. */
  clientFor: (organizationId: OrganizationId) => Promise<ProvisionerClient | null>;
  bootId: string;
  crashAt?: (point: string) => void;
  /** True on the queue's last attempt: an unclear answer then ends in review instead of a retry. */
  lastAttempt?: boolean;
}

/** Thrown for an answer that may change: the queue retries the job. */
export class ProvisionRetry extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`environment provisioning will be retried: ${reason}`);
    this.reason = reason;
  }
}

const STALE_CLAIM_SECONDS = 60;

/** The digest of an environment's two objects, as the sweep recomputes it. */
export function policyDigest(policy: string, tokenRole: ReadableTokenRole): string {
  const fields = Object.keys(tokenRole).sort();
  const role = Object.fromEntries(
    fields.map((field) => [field, tokenRole[field as keyof ReadableTokenRole]]),
  );
  return createHash("sha256")
    .update(JSON.stringify({ policy, tokenRole: role }))
    .digest("hex");
}

/** The machine token role as OpenBao reads it back (`token_num_uses` 0 is omitted). */
export function readableRole(environmentId: EnvironmentId): ReadableTokenRole {
  const role: Partial<ReturnType<typeof machineTokenRole>> = machineTokenRole(environmentId);
  delete role.token_num_uses;
  return role as ReadableTokenRole;
}

interface Claimed {
  organizationId: OrganizationId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
}

async function claim(
  pool: pg.Pool,
  operationId: OperationId,
  bootId: string,
): Promise<Claimed | null> {
  const result = await pool.query<{ organization_id: OrganizationId; target: EnvironmentId }>(
    `UPDATE app.operation
        SET state = 'executing', executor_boot_id = $2, dispatched_at = now(), heartbeat_at = now()
      WHERE id = $1
        AND (state = 'accepted'
             OR (state = 'executing'
                 AND (executor_boot_id = $2
                      OR heartbeat_at < now() - make_interval(secs => $3))))
      RETURNING organization_id, target`,
    [operationId, bootId, STALE_CLAIM_SECONDS],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const environment = await pool.query<{ project_id: ProjectId }>(
    "SELECT project_id FROM app.environment WHERE organization_id = $1 AND id = $2",
    [row.organization_id, row.target],
  );
  const projectId = environment.rows[0]?.project_id;
  if (projectId === undefined)
    throw new Error("the operation names no environment of its organization");
  return { organizationId: row.organization_id, environmentId: row.target, projectId };
}

type Ended = "review" | "failed";

export async function provisionEnvironment(
  deps: EnvironmentDeps,
  operationId: OperationId,
): Promise<"active" | "review" | "failed" | "not_claimed"> {
  const { pool } = deps;
  const crash = (point: string) => deps.crashAt?.(point);
  const claimed = await claim(pool, operationId, deps.bootId);
  if (claimed === null) return "not_claimed";
  const { organizationId, environmentId, projectId } = claimed;
  const name = machineName(environmentId);
  const policy = renderMachinePolicy(projectId, environmentId);
  const role = machineTokenRole(environmentId);
  const readable = readableRole(environmentId);

  const client = await deps.clientFor(organizationId);
  if (client === null) {
    await end(pool, claimed, operationId, "failed");
    return "failed";
  }

  let ordinal =
    (
      await pool.query<{ next: number }>(
        "SELECT coalesce(max(ordinal), 0)::int + 1 AS next FROM app.operation_step WHERE operation_id = $1",
        [operationId],
      )
    ).rows[0]?.next ?? 1;

  type Verdict =
    | "verified"
    | "written"
    | "mismatch"
    | { cause: "denied" | "unreachable" | "sealed" | "unknown" };
  const effects: Record<(typeof ENVIRONMENT_STEPS)[number], () => Promise<Verdict>> = {
    "kv-scope": async () => {
      const config = await client.readKvConfig();
      if (!config.ok) return { cause: config.cause };
      if (config.value === null) return "mismatch";
      return config.value.cas_required === true &&
        config.value.max_versions === LIMITS.secret.versionsKept
        ? "verified"
        : "mismatch";
    },
    "machine-policy": async () => {
      const read = await client.readMachinePolicy(name);
      if (!read.ok) return { cause: read.cause };
      if (read.value === policy) return "verified";
      if (read.value !== null) return "mismatch";
      const written = await client.putMachinePolicy(name, policy);
      if (!written.ok) return { cause: written.cause };
      const back = await client.readMachinePolicy(name);
      if (!back.ok) return { cause: back.cause };
      return back.value === policy ? "written" : { cause: "unknown" };
    },
    "token-role": async () => {
      const read = await client.readMachineTokenRole(name);
      if (!read.ok) return { cause: read.cause };
      if (read.value !== null)
        return isDeepStrictEqual(read.value, readable) ? "verified" : "mismatch";
      const written = await client.putMachineTokenRole(name, role);
      if (!written.ok) return { cause: written.cause };
      const back = await client.readMachineTokenRole(name);
      if (!back.ok) return { cause: back.cause };
      return back.value !== null && isDeepStrictEqual(back.value, readable)
        ? "written"
        : { cause: "unknown" };
    },
  };

  try {
    for (const step of ENVIRONMENT_STEPS) {
      const stepId = randomUUID();
      await pool.query(
        "INSERT INTO app.operation_step (id, operation_id, ordinal, target) VALUES ($1, $2, $3, $4)",
        [stepId, operationId, ordinal, step],
      );
      ordinal += 1;
      await pool.query("UPDATE app.operation SET heartbeat_at = now() WHERE id = $1", [
        operationId,
      ]);
      crash(`${step}:before`);
      const verdict = await effects[step]();
      crash(`${step}:after-effect`);
      const outcome = typeof verdict === "string" ? verdict : "unknown";
      await pool.query("UPDATE app.operation_step SET outcome = $2 WHERE id = $1", [
        stepId,
        outcome,
      ]);
      crash(`${step}:after-record`);
      if (verdict === "mismatch") {
        await end(pool, claimed, operationId, "review");
        return "review";
      }
      if (typeof verdict !== "string") {
        if (verdict.cause === "denied") {
          await end(pool, claimed, operationId, "failed");
          return "failed";
        }
        if (deps.lastAttempt === true) {
          await end(pool, claimed, operationId, "failed");
          return "failed";
        }
        throw new ProvisionRetry(verdict.cause);
      }
    }

    crash("activate:before");
    const digest = policyDigest(policy, readable);
    await withTransaction(pool, async (tx) => {
      await tx.query(
        `UPDATE app.environment SET state = 'active', kv_ready = true, policy_digest = $3, review_reason = NULL
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, environmentId, digest],
      );
      await tx.query(
        "UPDATE app.project SET state = 'active' WHERE organization_id = $1 AND id = $2 AND state = 'pending'",
        [organizationId, projectId],
      );
      await tx.query(
        "UPDATE app.operation SET state = 'succeeded', completed_at = now(), heartbeat_at = now() WHERE id = $1",
        [operationId],
      );
      await appendAudit(tx, {
        action: "system.environment_provision",
        actor: { kind: "system", id: null },
        source: "system",
        organizationId,
        target: { kind: "environment", id: environmentId },
        outcome: "success",
        requestId: null,
        operationId,
        details: { outcome: "active" },
      });
    });
    crash("activate:after-effect");
    return "active";
  } finally {
    await client.close();
  }
}

/** Review (a difference) or failure (no reach): the environment goes to needs_review. */
async function end(
  pool: pg.Pool,
  claimed: Claimed,
  operationId: OperationId,
  how: Ended,
): Promise<void> {
  const reason = how === "review" ? "backend_inconsistent" : "provisioning_failed";
  await withTransaction(pool, async (tx) => {
    await tx.query(
      `UPDATE app.environment SET state = 'needs_review', review_reason = $3
        WHERE organization_id = $1 AND id = $2`,
      [claimed.organizationId, claimed.environmentId, reason],
    );
    await tx.query(
      "UPDATE app.operation SET state = 'awaiting_input', error_code = $2, heartbeat_at = now() WHERE id = $1",
      [operationId, reason],
    );
    await appendAudit(tx, {
      action: "system.environment_provision",
      actor: { kind: "system", id: null },
      source: "system",
      organizationId: claimed.organizationId,
      target: { kind: "environment", id: claimed.environmentId },
      outcome: "failure",
      requestId: null,
      operationId,
      details: { outcome: "review", reason },
    });
  });
}
