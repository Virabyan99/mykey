// Archive and reactivate (Run 5.3): helpers over the credentials fixture.
// Projects and environments made here go through the API and the fixture's
// provisioner, so each case can archive resources of its own. The archive
// driver of the tick is built here from the same identity files as the API.
import { randomBytes, randomUUID } from "node:crypto";
import { issuerBaoFromDirectory } from "@mykey/api";
import { createPool } from "@mykey/db";
import { continueArchives } from "@mykey/operations";
import type pg from "pg";
import { expect } from "vitest";
import { baoAnswer } from "./bao-raw.ts";
import type { CredentialsFixture } from "./credentials-fixture.ts";
import type { Answer } from "./secrets-fixture.ts";

export interface Place {
  projectId: string;
  environmentId: string;
  projectPath: string;
  path: string;
}

const orgPath = (f: CredentialsFixture) => `/v1/organizations/${f.tenants.a.organizationId}`;

/**
 * A new active project of organization A with one environment, active. The
 * rows are written by the superuser and the environment provisioned by the
 * fixture's provisioner (the test API runs no outbox dispatcher).
 */
export async function newProject(f: CredentialsFixture): Promise<Place> {
  const projectId = randomUUID();
  await f.api.superuser.query(
    "INSERT INTO app.project (id, organization_id, name, state) VALUES ($1, $2, $3, 'active')",
    [projectId, f.tenants.a.organizationId, `lc-${randomBytes(4).toString("hex")}`],
  );
  const projectPath = `${orgPath(f)}/projects/${projectId}`;
  return newEnvironment(f, { projectId, environmentId: "", projectPath, path: "" });
}

/** One more environment in the project, active. */
export async function newEnvironment(f: CredentialsFixture, project: Place): Promise<Place> {
  const { environmentId } = await f.fx.newEnvironment({ projectId: project.projectId });
  // The fixture stops its provisioner after setup; one runs while this environment is made.
  const provisioner = await f.fx.start();
  try {
    await f.fx.waitFor(environmentId, "active", 120_000);
  } finally {
    await provisioner.stop();
  }
  return {
    ...project,
    environmentId,
    path: `${project.projectPath}/environments/${environmentId}`,
  };
}

/** A credential issued through the route in `place`; fails unless 201. */
export async function issueAt(
  f: CredentialsFixture,
  place: Place,
  ttlSeconds = 600,
): Promise<{ credentialId: string; token: string; operationId: string }> {
  await f.freshen();
  const answer = await f.send("POST", `${place.path}/credentials`, {
    body: { name: "deploy", ttlSeconds },
    key: randomUUID(),
  });
  expect(answer.status, `issue: ${answer.code ?? ""}`).toBe(201);
  return {
    credentialId: (answer.body.credential as { credentialId: string }).credentialId,
    token: answer.body.token as string,
    operationId: answer.body.operationId as string,
  };
}

export function archive(
  f: CredentialsFixture,
  path: string,
  opts: { key?: string; user?: "ownerA" | "adminA" | "editorA" | "ownerB"; body?: unknown } = {},
): Promise<Answer> {
  return f.send("POST", `${path}/archive`, {
    body: opts.body ?? { confirmed: true },
    key: opts.key ?? randomUUID(),
    ...(opts.user === undefined ? {} : { user: opts.user }),
  });
}

export function reactivate(
  f: CredentialsFixture,
  path: string,
  opts: { key?: string; user?: "ownerA" | "adminA" | "editorA" | "ownerB" } = {},
): Promise<Answer> {
  return f.send("POST", `${path}/reactivate`, {
    body: { confirmed: true },
    key: opts.key ?? randomUUID(),
    ...(opts.user === undefined ? {} : { user: opts.user }),
  });
}

/** What OpenBao answers to a lookup of an accessor (root token): 200 alive, 400 gone. */
export async function accessorAnswer(f: CredentialsFixture, accessor: string): Promise<number> {
  return (
    await baoAnswer(f.stack, f.stack.bao.rootToken, "POST", "auth/token/lookup-accessor", {
      namespace: f.fx.namespace,
      body: { accessor },
    })
  ).status;
}

/** The accessors of every credential row of an environment. */
export async function accessorsOf(f: CredentialsFixture, environmentId: string): Promise<string[]> {
  const rows = await f.api.superuser.query<{ accessor: string }>(
    "SELECT accessor FROM app.machine_credential WHERE environment_id = $1 AND accessor IS NOT NULL",
    [environmentId],
  );
  return rows.rows.map((row) => row.accessor);
}

export async function resourceState(
  f: CredentialsFixture,
  kind: "project" | "environment",
  id: string,
): Promise<{ state: string; archive_origin: string | null; archive_operation_id: string | null }> {
  const rows = await f.api.superuser.query<{
    state: string;
    archive_origin: string | null;
    archive_operation_id: string | null;
  }>(
    kind === "project"
      ? "SELECT state, NULL AS archive_origin, archive_operation_id FROM app.project WHERE id = $1"
      : "SELECT state, archive_origin, archive_operation_id FROM app.environment WHERE id = $1",
    [id],
  );
  return rows.rows[0]!;
}

/** The tick's archive driver, as the API builds it (api_runtime, the issuer identity). */
export function archiveDriver(f: CredentialsFixture): {
  run(staleSeconds?: number): ReturnType<typeof continueArchives>;
  close(): Promise<void>;
} {
  const lockPool: pg.Pool = createPool(f.api.database.targets.api_runtime, { max: 4 });
  const issuer = issuerBaoFromDirectory(f.stack.bao, f.secretsDirectory);
  return {
    run: (staleSeconds = 0) =>
      continueArchives(
        { pool: f.api.pool, lockPool, issuer, bootId: randomUUID() },
        { staleSeconds },
      ),
    close: () => lockPool.end(),
  };
}

export async function successRows(f: CredentialsFixture, operationId: string): Promise<number> {
  const rows = await f.api.superuser.query(
    "SELECT 1 FROM audit.event WHERE operation_id = $1 AND outcome = 'success'",
    [operationId],
  );
  return rows.rowCount ?? 0;
}
