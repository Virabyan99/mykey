// Projects and environments (Run 3.9, P-58, P-59). Creates and renames take
// the transaction of their operation; uniqueness is the database's, exact
// after NFC. No function here deletes a project or an environment.
import { randomUUID } from "node:crypto";
import type { EnvironmentId, OperationId, ProjectId } from "@mykey/contracts";
import type pg from "pg";
import type { EnvironmentScope, OrgScope, ProjectScope } from "../scope.ts";
import type { Queryable } from "../tx.ts";
import { enqueueOutbox } from "./outbox.ts";

const UNIQUE_VIOLATION = "23505";

/** Runs `statement` under a savepoint; a unique violation answers `name_taken` and leaves the transaction usable. */
async function unlessTaken(
  tx: pg.PoolClient,
  statement: () => Promise<void>,
): Promise<"ok" | "name_taken"> {
  await tx.query("SAVEPOINT resource_name");
  try {
    await statement();
    await tx.query("RELEASE SAVEPOINT resource_name");
    return "ok";
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT resource_name");
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) return "name_taken";
    throw error;
  }
}

/** The environment's provisioning: one system operation `environment.provision` and its outbox row. */
async function provisioningOperation(
  tx: pg.PoolClient,
  scope: OrgScope,
  environmentId: EnvironmentId,
): Promise<OperationId> {
  const operationId = randomUUID() as OperationId;
  await tx.query(
    `INSERT INTO app.operation (id, organization_id, principal_kind, principal_id, action, target,
       idempotency_key, state)
     VALUES ($1, $2, 'system', 'provisioner', 'environment.provision', $3, $3, 'accepted')`,
    [operationId, scope.organizationId, environmentId],
  );
  await enqueueOutbox(tx, operationId, "environment.provision");
  return operationId;
}

export async function createProject(
  tx: pg.PoolClient,
  scope: OrgScope,
  input: { projectId: ProjectId; name: string; developmentEnvironmentId: EnvironmentId },
): Promise<"created" | "name_taken"> {
  const taken = await unlessTaken(tx, async () => {
    await tx.query(
      "INSERT INTO app.project (id, organization_id, name, state) VALUES ($1, $2, $3, 'pending')",
      [input.projectId, scope.organizationId, input.name],
    );
  });
  if (taken === "name_taken") return "name_taken";
  await tx.query(
    `INSERT INTO app.environment (id, organization_id, project_id, name, state, kv_ready)
     VALUES ($1, $2, $3, 'development', 'pending', false)`,
    [input.developmentEnvironmentId, scope.organizationId, input.projectId],
  );
  await provisioningOperation(tx, scope, input.developmentEnvironmentId);
  return "created";
}

export async function createEnvironment(
  tx: pg.PoolClient,
  scope: ProjectScope,
  input: { environmentId: EnvironmentId; name: string },
): Promise<"created" | "name_taken"> {
  const taken = await unlessTaken(tx, async () => {
    await tx.query(
      `INSERT INTO app.environment (id, organization_id, project_id, name, state, kv_ready)
       VALUES ($1, $2, $3, $4, 'pending', false)`,
      [input.environmentId, scope.organizationId, scope.projectId, input.name],
    );
  });
  if (taken === "name_taken") return "name_taken";
  await provisioningOperation(tx, scope, input.environmentId);
  return "created";
}

export async function renameProject(
  tx: pg.PoolClient,
  scope: ProjectScope,
  name: string,
): Promise<"renamed" | "name_taken" | "unchanged"> {
  const current = await tx.query<{ name: string }>(
    "SELECT name FROM app.project WHERE organization_id = $1 AND id = $2 FOR UPDATE",
    [scope.organizationId, scope.projectId],
  );
  if (current.rows[0]?.name === name) return "unchanged";
  const taken = await unlessTaken(tx, async () => {
    await tx.query("UPDATE app.project SET name = $3 WHERE organization_id = $1 AND id = $2", [
      scope.organizationId,
      scope.projectId,
      name,
    ]);
  });
  return taken === "name_taken" ? "name_taken" : "renamed";
}

export async function renameEnvironment(
  tx: pg.PoolClient,
  scope: EnvironmentScope,
  name: string,
): Promise<"renamed" | "name_taken" | "unchanged"> {
  const current = await tx.query<{ name: string }>(
    `SELECT name FROM app.environment
      WHERE organization_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE`,
    [scope.organizationId, scope.projectId, scope.environmentId],
  );
  if (current.rows[0]?.name === name) return "unchanged";
  const taken = await unlessTaken(tx, async () => {
    await tx.query(
      "UPDATE app.environment SET name = $4 WHERE organization_id = $1 AND project_id = $2 AND id = $3",
      [scope.organizationId, scope.projectId, scope.environmentId, name],
    );
  });
  return taken === "name_taken" ? "name_taken" : "renamed";
}

/** Raises the organization's resource generation (every create); answers the new value. */
export async function bumpResourceGeneration(tx: pg.PoolClient, scope: OrgScope): Promise<bigint> {
  const result = await tx.query<{ generation: string }>(
    `UPDATE app.organization SET resource_generation = resource_generation + 1
      WHERE id = $1 RETURNING resource_generation::text AS generation`,
    [scope.organizationId],
  );
  return BigInt(result.rows[0]?.generation ?? "0");
}

export async function resourceGeneration(db: Queryable, scope: OrgScope): Promise<bigint> {
  const result = await db.query<{ generation: string }>(
    "SELECT resource_generation::text AS generation FROM app.organization WHERE id = $1",
    [scope.organizationId],
  );
  return BigInt(result.rows[0]?.generation ?? "0");
}

/**
 * The states of a scope's rows, locked until the transaction ends (FR-1.10's
 * recheck): parents FOR SHARE, the row being changed (`own`) FOR UPDATE — a
 * share lock later raised to an update lock would deadlock two renames.
 */
export async function lockParents(
  tx: pg.PoolClient,
  scope: OrgScope & { projectId?: string; environmentId?: string },
  own: "project" | "environment" | null = null,
): Promise<{ organization: string | null; project: string | null; environment: string | null }> {
  const organization = await tx.query<{ state: string }>(
    "SELECT state FROM app.organization WHERE id = $1 FOR SHARE",
    [scope.organizationId],
  );
  const project =
    scope.projectId === undefined
      ? null
      : await tx.query<{ state: string }>(
          `SELECT state FROM app.project WHERE organization_id = $1 AND id = $2 ${own === "project" ? "FOR UPDATE" : "FOR SHARE"}`,
          [scope.organizationId, scope.projectId],
        );
  const environment =
    scope.environmentId === undefined
      ? null
      : await tx.query<{ state: string }>(
          `SELECT state FROM app.environment WHERE organization_id = $1 AND id = $2 ${own === "environment" ? "FOR UPDATE" : "FOR SHARE"}`,
          [scope.organizationId, scope.environmentId],
        );
  return {
    organization: organization.rows[0]?.state ?? null,
    project: project?.rows[0]?.state ?? null,
    environment: environment?.rows[0]?.state ?? null,
  };
}

export interface ProjectRow {
  id: string;
  name: string;
  state: string;
  reviewReason: string | null;
  createdAt: Date;
}

export interface EnvironmentRow extends ProjectRow {
  kvReady: boolean;
}

/** A project as a list shows it. Session 11 (P-193): `managedBy` is a chain's first credential, or null. */
export interface ListedProject extends ProjectRow {
  managedBy: string | null;
}

export async function listProjects(
  db: Queryable,
  scope: OrgScope,
  visible: "all" | readonly string[],
  page: { afterId: string | null; limit: number },
): Promise<ListedProject[]> {
  const result = await db.query<ListedProject>(
    `SELECT id, name, state, review_reason AS "reviewReason", created_at AS "createdAt",
            managed_by AS "managedBy"
       FROM app.project
      WHERE organization_id = $1
        AND ($2::uuid[] IS NULL OR id = ANY ($2::uuid[]))
        AND ($3::uuid IS NULL OR id > $3::uuid)
      ORDER BY id LIMIT $4`,
    [scope.organizationId, visible === "all" ? null : [...visible], page.afterId, page.limit],
  );
  return result.rows;
}

export async function listEnvironments(
  db: Queryable,
  scope: ProjectScope,
  visible: "all" | readonly string[],
  page: { afterId: string | null; limit: number },
): Promise<EnvironmentRow[]> {
  const result = await db.query<EnvironmentRow>(
    `SELECT id, name, state, review_reason AS "reviewReason", kv_ready AS "kvReady",
            created_at AS "createdAt"
       FROM app.environment
      WHERE organization_id = $1 AND project_id = $2
        AND ($3::uuid[] IS NULL OR id = ANY ($3::uuid[]))
        AND ($4::uuid IS NULL OR id > $4::uuid)
      ORDER BY id LIMIT $5`,
    [
      scope.organizationId,
      scope.projectId,
      visible === "all" ? null : [...visible],
      page.afterId,
      page.limit,
    ],
  );
  return result.rows;
}
