// Reactivation (Run 5.3, P-92, FR-1.18, D-41): database work and reads only.
//
// The target must be `archived`; an environment also needs origin `self` and
// its project `active`. Before the transition, each environment it brings
// back (the target; for a project, the children archived with origin
// `project` under the project's own archive operation) is verified with
// reads: the machine policy and token role exist and their digest equals
// `policy_digest` (issuer session); the names OpenBao lists equal the index's
// (runtime identity); every credential is `revoked` and each stored accessor
// answers 400. Then one transaction: the operation inserted and finished in
// it, the states re-read, `lifecycle_transition(reactivate)`, the audit row.
// No executing operation is ever visible: a crash before the commit leaves
// nothing. A failed verification changes nothing and is recorded as a
// rejected operation. No credential is created, renewed or re-activated.
import { randomUUID } from "node:crypto";
import { AuditUnavailable, appendAudit, type AuditAction } from "@mykey/audit";
import {
  LIMITS,
  type EnvironmentId,
  type ErrorCode,
  type OperationId,
  type OrganizationId,
  type ProjectId,
} from "@mykey/contracts";
import {
  findOperationByKey,
  finishOperation,
  insertOperation,
  lifecycleTransition,
  listIndex,
  lockParents,
  withTransaction,
  type OperationRow,
} from "@mykey/db";
import { environmentPrefix, machineName, type BaoResult, type OpenBaoClient } from "@mykey/openbao";
import type pg from "pg";
import { policyDigest } from "../provisioning/digest.ts";
import { intentFingerprint, sameIntent } from "../replay.ts";
import type { IssuerSession } from "../runtime.ts";
import type { ArchiveRequest, LifecycleDeps } from "./archive.ts";

export type ReactivateOutcome =
  | { kind: "reactivated" | "replay"; operation: OperationRow }
  | { kind: "refused"; code: ErrorCode; operationId?: OperationId };

type Refused = Extract<ReactivateOutcome, { kind: "refused" }>;

class Refusal extends Error {
  readonly outcome: Refused;

  constructor(code: ErrorCode) {
    super(code);
    this.name = "Refusal";
    this.outcome = { kind: "refused", code };
  }
}

const AUDIT: Record<string, AuditAction> = {
  "projects.reactivate": "project.reactivate",
  "environments.reactivate": "environment.reactivate",
};

interface Target {
  archiveOperationId: OperationId | null;
  environments: { id: EnvironmentId; policyDigest: string | null }[];
}

/** The target as it reads now; a refusal when it cannot be reactivated. */
async function readTarget(db: pg.Pool | pg.PoolClient, request: ArchiveRequest): Promise<Target> {
  if (request.kind === "project") {
    const project = await db.query<{ state: string; archive_operation_id: OperationId | null }>(
      `SELECT state, archive_operation_id FROM app.project
        WHERE organization_id = $1 AND id = $2`,
      [request.organizationId, request.projectId],
    );
    const row = project.rows[0];
    if (row === undefined) throw new Refusal("not_found");
    if (row.state !== "archived" || row.archive_operation_id === null) {
      throw new Refusal("state_conflict");
    }
    const children = await db.query<{ id: EnvironmentId; policy_digest: string | null }>(
      `SELECT id, policy_digest FROM app.environment
        WHERE organization_id = $1 AND project_id = $2 AND state = 'archived'
          AND archive_origin = 'project' AND archive_operation_id = $3
        ORDER BY id`,
      [request.organizationId, request.projectId, row.archive_operation_id],
    );
    return {
      archiveOperationId: row.archive_operation_id,
      environments: children.rows.map((env) => ({ id: env.id, policyDigest: env.policy_digest })),
    };
  }
  const environment = await db.query<{
    state: string;
    archive_origin: string | null;
    archive_operation_id: OperationId | null;
    policy_digest: string | null;
    project_state: string;
  }>(
    `SELECT e.state, e.archive_origin, e.archive_operation_id, e.policy_digest,
            p.state AS project_state
       FROM app.environment e
       JOIN app.project p ON p.organization_id = e.organization_id AND p.id = e.project_id
      WHERE e.organization_id = $1 AND e.project_id = $2 AND e.id = $3`,
    [request.organizationId, request.projectId, request.environmentId],
  );
  const row = environment.rows[0];
  if (row === undefined || request.environmentId === undefined) throw new Refusal("not_found");
  if (row.state !== "archived" || row.archive_origin !== "self" || row.project_state !== "active") {
    throw new Refusal("state_conflict");
  }
  return {
    archiveOperationId: row.archive_operation_id,
    environments: [{ id: request.environmentId, policyDigest: row.policy_digest }],
  };
}

type Verdict = "verified" | "backend_inconsistent" | "dependency_unavailable";

/** An answer that does not say what the backend holds: nothing can be concluded from it. */
function unclear(result: BaoResult<unknown>): boolean {
  return !result.ok && (result.kind === "unknown" || result.kind === "sealed");
}

async function verifyEnvironment(
  deps: LifecycleDeps,
  session: IssuerSession,
  runtime: OpenBaoClient,
  organizationId: OrganizationId,
  projectId: ProjectId,
  environment: Target["environments"][number],
): Promise<Verdict> {
  const name = machineName(environment.id);
  const policy = await session.client.readMachinePolicy(name);
  const role = await session.client.readMachineTokenRole(name);
  if (unclear(policy) || unclear(role)) return "dependency_unavailable";
  if (!policy.ok || !role.ok || environment.policyDigest === null) return "backend_inconsistent";
  if (policyDigest(policy.data, role.data) !== environment.policyDigest) {
    return "backend_inconsistent";
  }

  const scope = { organizationId, projectId, environmentId: environment.id };
  const index = await listIndex(deps.pool, scope, {
    prefix: null,
    after: null,
    limit: LIMITS.environment.maxNames + 1,
  });
  if (index.rows.some((row) => row.state === "needs_review")) return "backend_inconsistent";
  const listed = await runtime.kvList(environmentPrefix(projectId, environment.id));
  if (unclear(listed)) return "dependency_unavailable";
  let names: string[];
  if (listed.ok) names = listed.data.names;
  else if (listed.kind === "not_found") names = [];
  else return "backend_inconsistent";
  const indexed = new Set(index.rows.map((row) => row.name));
  if (names.length !== indexed.size || !names.every((entry) => indexed.has(entry))) {
    return "backend_inconsistent";
  }

  const credentials = await deps.pool.query<{ state: string; accessor: string | null }>(
    `SELECT state, accessor FROM app.machine_credential
      WHERE organization_id = $1 AND environment_id = $2`,
    [organizationId, environment.id],
  );
  for (const credential of credentials.rows) {
    if (credential.state !== "revoked") return "backend_inconsistent";
    if (credential.accessor === null) continue;
    const lookup = await session.client.tokenLookupAccessor(credential.accessor);
    if (!lookup.ok && lookup.kind === "invalid" && lookup.status === 400) continue;
    if (lookup.ok) return "backend_inconsistent";
    return "dependency_unavailable";
  }
  return "verified";
}

async function verify(
  deps: LifecycleDeps,
  request: ArchiveRequest,
  target: Target,
): Promise<Verdict> {
  if (target.environments.length === 0) return "verified";
  const runtime = deps.bao?.clientFor(request.organizationId) ?? null;
  if (runtime === null) return "dependency_unavailable";
  const opened = await deps.issuer.open(request.organizationId);
  if (!opened?.ok) return "dependency_unavailable";
  try {
    for (const environment of target.environments) {
      const verdict = await verifyEnvironment(
        deps,
        opened.data,
        runtime,
        request.organizationId,
        request.projectId,
        environment,
      );
      if (verdict !== "verified") return verdict;
    }
    return "verified";
  } finally {
    await opened.data.close();
  }
}

export async function reactivate(
  deps: LifecycleDeps,
  request: ArchiveRequest,
): Promise<ReactivateOutcome> {
  const target = request.kind === "project" ? request.projectId : request.environmentId;
  if (target === undefined) throw new Error("an environment reactivation names its environment");
  const key = {
    principalKind: "user" as const,
    principalId: request.userId,
    action: request.routeId,
    target,
    idempotencyKey: request.idempotencyKey,
  };
  const replayOf = (found: OperationRow): ReactivateOutcome => {
    if (!sameIntent(deps.ring, found, request.intent)) {
      return { kind: "refused", code: "idempotency_conflict" };
    }
    return { kind: "replay", operation: found };
  };
  const earlier = await findOperationByKey(deps.pool, key);
  if (earlier !== null) return replayOf(earlier);

  let seen: Target;
  try {
    seen = await readTarget(deps.pool, request);
  } catch (error) {
    if (error instanceof Refusal) return error.outcome;
    throw error;
  }
  const verdict = await verify(deps, request, seen);

  const operationId = randomUUID() as OperationId;
  try {
    const finished = await withTransaction(deps.pool, async (tx) => {
      const { digest, keyId } = intentFingerprint(deps.ring, request.intent);
      const inserted = await insertOperation(tx, {
        ...key,
        id: operationId,
        organizationId: request.organizationId,
        projectId: request.projectId,
        ...(request.environmentId === undefined ? {} : { environmentId: request.environmentId }),
        expected: { environments: seen.environments.length },
        executorBootId: deps.bootId,
        state: "executing",
        fingerprint: digest,
        fingerprintKeyId: keyId,
        result: null,
      });
      if (inserted === "exists") {
        const found = await findOperationByKey(tx, key);
        if (found === null) throw new Error("operation key exists but its row was not found");
        return replayOf(found);
      }
      const capture = await tx.query<{ capture_mode: string }>(
        "SELECT capture_mode FROM app.service_control FOR SHARE",
      );
      if (capture.rows[0]?.capture_mode !== "idle") throw new Refusal("busy");
      if (!deps.gateOpen()) throw new Refusal("quarantined");
      // The rows in the order every admission takes them (organization, project,
      // environment; the target FOR UPDATE); then authority and the states, re-read.
      await lockParents(
        tx,
        {
          organizationId: request.organizationId,
          projectId: request.projectId,
          ...(request.environmentId === undefined ? {} : { environmentId: request.environmentId }),
        },
        request.kind,
      );
      const code = await request.recheck(tx);
      if (code !== null) throw new Refusal(code);
      const now = await readTarget(tx, request);
      if (
        now.archiveOperationId !== seen.archiveOperationId ||
        now.environments.map((env) => env.id).join() !==
          seen.environments.map((env) => env.id).join()
      ) {
        throw new Refusal("state_conflict");
      }
      const audit = (outcome: "success" | "failure") =>
        appendAudit(tx, {
          action: AUDIT[request.routeId] ?? "environment.reactivate",
          actor: { kind: "user", id: request.userId },
          source: "api",
          organizationId: request.organizationId,
          target: { kind: request.kind, id: target },
          outcome,
          requestId: request.requestId,
          operationId,
          details: { environments: seen.environments.length },
        });
      if (verdict !== "verified") {
        const rejected = await finishOperation(
          tx,
          operationId,
          deps.bootId,
          { state: "rejected", errorCode: verdict },
          LIMITS.operation.terminalRetentionDays,
        );
        if (rejected === null) throw new Error("reactivation operation vanished");
        await audit("failure");
        return { kind: "refused" as const, code: verdict as ErrorCode, operationId };
      }
      const moved = await lifecycleTransition(tx, {
        kind: request.kind,
        organizationId: request.organizationId,
        id: target,
        operationId,
        step: "reactivate",
      });
      if (!moved) throw new Refusal("state_conflict");
      const done = await finishOperation(
        tx,
        operationId,
        deps.bootId,
        {
          state: "succeeded",
          result: { state: "active", environments: seen.environments.length },
        },
        LIMITS.operation.terminalRetentionDays,
      );
      if (done === null) throw new Error("reactivation operation vanished");
      await audit("success");
      return { kind: "reactivated" as const, operation: done };
    });
    return finished;
  } catch (error) {
    if (error instanceof Refusal) return error.outcome;
    if (error instanceof AuditUnavailable) return { kind: "refused", code: "audit_unavailable" };
    throw error;
  }
}
