// Run 3.9 Task D (FR-1.16, AC-1.10): a new environment is pending until the
// provisioner has verified its machine policy and token role; a pending
// environment cannot start a credential issuance (proven at the state gate;
// Run 5.1 proves it again on the real issuance route); a provisioning failure
// becomes a review; the job carries the operation id only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EnvironmentId, ProjectId } from "@mykey/contracts";
import { machineName, machineTokenRole, renderMachinePolicy } from "@mykey/openbao";
import { policyDigest, readableRole } from "@mykey/operations/provisioner";
import { createProvisioningFixture, type ProvisioningFixture } from "../provisioning/fixture.ts";

let fx: ProvisioningFixture;

beforeAll(async () => {
  fx = await createProvisioningFixture({ shared: true });
}, 600_000);

afterAll(async () => {
  await fx.close();
}, 300_000);

async function post(path: string, body: unknown) {
  const response = await fx.api.request("POST", path, {
    body,
    cookie: await fx.tenants.cookie("ownerA"),
    headers: { "idempotency-key": randomUUID() },
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
}

const org = () => `/v1/organizations/${fx.tenants.a.organizationId}`;
const createEnvironment = (project: string, name: string) =>
  post(`${org()}/projects/${project}/environments`, { name });
const issue = (project: string, environment: string) =>
  post(`${org()}/projects/${project}/environments/${environment}/credentials`, { name: "c" });

describe("readiness", () => {
  it("a new environment is pending until its machine policy and token role are verified", async () => {
    const project = fx.tenants.a.project1;
    const created = await createEnvironment(project, "ready-check");
    expect(created.status).toBe(201);
    const { environmentId } = created.body.result as { environmentId: string };
    expect(await fx.environment(environmentId)).toMatchObject({
      state: "pending",
      kv_ready: false,
    });
    const refused = await issue(project, environmentId);
    expect(refused.status).toBe(409);
    expect((refused.body.error as { code: string }).code).toBe("state_conflict");
    const name = machineName(environmentId as EnvironmentId);
    expect(await fx.admin.readTokenRole(fx.namespace, name)).toBeNull();

    const provisioner = await fx.start();
    try {
      await fx.waitFor(environmentId, "active", 10_000);
    } finally {
      await provisioner.stop();
    }
    const row = await fx.environment(environmentId);
    expect(row.kv_ready).toBe(true);
    const policy = await fx.admin.readPolicy(fx.namespace, name);
    const role = await fx.admin.readTokenRole(fx.namespace, name);
    expect(policy).toBe(renderMachinePolicy(project as ProjectId, environmentId as EnvironmentId));
    expect(role).toEqual(readableRole(environmentId as EnvironmentId));
    expect(row.policy_digest).toBe(policyDigest(policy!, role!));
    expect(machineTokenRole(environmentId as EnvironmentId).token_num_uses).toBe(0);
  }, 120_000);

  it("the first verified environment activates the project", async () => {
    const created = await post(`${org()}/projects`, { name: `Fresh ${randomUUID().slice(0, 6)}` });
    expect(created.status).toBe(201);
    const { projectId, developmentEnvironmentId } = created.body.result as {
      projectId: string;
      developmentEnvironmentId: string;
    };
    const state = async () =>
      (
        await fx.api.superuser.query<{ state: string }>(
          "SELECT state FROM app.project WHERE id = $1",
          [projectId],
        )
      ).rows[0]?.state;
    expect(await state()).toBe("pending");
    const provisioner = await fx.start();
    try {
      await fx.waitFor(developmentEnvironmentId, "active", 10_000);
    } finally {
      await provisioner.stop();
    }
    expect(await state()).toBe("active");
  }, 120_000);

  it("the job carried an id only", async () => {
    const result = await fx.api.superuser.query<{ data: unknown }>(
      "SELECT data FROM jobs.job WHERE name = 'environment.provision' ORDER BY created_on DESC LIMIT 5",
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(Object.keys(row.data as object)).toEqual(["operationId"]);
    }
  });

  it("a provisioning failure becomes needs_review: reviewOpen counts it and credentials.issue answers 503", async () => {
    for (const accessor of await fx.admin.listSecretIdAccessors(fx.namespace, "provisioner")) {
      await fx.admin.destroySecretIdAccessor(fx.namespace, "provisioner", accessor);
    }
    const project = fx.tenants.a.project2;
    const created = await createEnvironment(project, "doomed");
    const { environmentId } = created.body.result as { environmentId: string };
    const provisioner = await fx.start();
    try {
      await fx.waitFor(environmentId, "needs_review", 60_000);
    } finally {
      await provisioner.stop();
    }
    expect((await fx.environment(environmentId)).review_reason).toBe("provisioning_failed");
    // The statement status.sh runs.
    const count = await fx.api.superuser.query<{ n: string }>(
      `SELECT ((SELECT count(*) FROM app.organization WHERE state = 'needs_review')
             + (SELECT count(*) FROM app.project WHERE state = 'needs_review')
             + (SELECT count(*) FROM app.environment WHERE state = 'needs_review'))::text AS n`,
    );
    expect(Number(count.rows[0]?.n)).toBeGreaterThanOrEqual(1);
    const answer = await issue(project, environmentId);
    expect(answer.status).toBe(503);
    expect((answer.body.error as { code: string }).code).toBe("backend_inconsistent");
  }, 180_000);
});
