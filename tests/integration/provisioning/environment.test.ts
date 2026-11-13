// Run 3.8 Task C (FR-1.12, P-55): the provisioner process takes an accepted
// `environment.provision` operation to an active environment — compare, then
// act; killed anywhere, it ends with one policy and one token role; a foreign
// object or a lost credential sends the environment to review; an unreachable
// OpenBao leaves it pending until it returns; a closed gate runs nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { machineName, renderMachinePolicy } from "@mykey/openbao";
import { ENVIRONMENT_POINTS, readableRole } from "@mykey/operations/provisioner";
import type { EnvironmentId, ProjectId } from "@mykey/contracts";
import { setTimeout as sleep } from "node:timers/promises";
import { startService, stopService } from "../../harness/stack.ts";
import { createProvisioningFixture, type ProvisioningFixture } from "./fixture.ts";

let fx: ProvisioningFixture;

beforeAll(async () => {
  fx = await createProvisioningFixture();
}, 600_000);

afterAll(async () => {
  await fx.close();
}, 300_000);

async function auditActives(environmentId: string): Promise<number> {
  const result = await fx.api.superuser.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit.event
      WHERE action = 'system.environment_provision' AND target_id = $1 AND details->>'outcome' = 'active'`,
    [environmentId],
  );
  return result.rows[0]!.n;
}

async function operationState(operationId: string): Promise<string> {
  const result = await fx.api.superuser.query<{ state: string }>(
    "SELECT state FROM app.operation WHERE id = $1",
    [operationId],
  );
  return result.rows[0]!.state;
}

async function objectsEqualPlan(environmentId: string, projectId: string): Promise<void> {
  const name = machineName(environmentId as EnvironmentId);
  expect(await fx.admin.readPolicy(fx.namespace, name)).toBe(
    renderMachinePolicy(projectId as ProjectId, environmentId as EnvironmentId),
  );
  expect(await fx.admin.readTokenRole(fx.namespace, name)).toEqual(
    readableRole(environmentId as EnvironmentId),
  );
}

describe("environment provisioning", () => {
  it("an accepted environment.provision operation ends active: policy and token role equal to the plan, kv_ready, policy_digest, project active", async () => {
    const provisioner = await fx.start();
    try {
      for (const id of [fx.tenants.a.env1a, fx.tenants.a.env1b, fx.tenants.a.env2a]) {
        await fx.waitFor(id, "active");
      }
      await fx.api.superuser.query("UPDATE app.project SET state = 'pending' WHERE id = $1", [
        fx.tenants.a.project2,
      ]);
      const { environmentId, operationId } = await fx.newEnvironment({
        projectId: fx.tenants.a.project2,
      });
      await fx.waitFor(environmentId, "active");
      await objectsEqualPlan(environmentId, fx.tenants.a.project2);
      const row = await fx.environment(environmentId);
      expect(row.kv_ready).toBe(true);
      expect(row.policy_digest).toMatch(/^[0-9a-f]{64}$/);
      const project = await fx.api.superuser.query<{ state: string }>(
        "SELECT state FROM app.project WHERE id = $1",
        [fx.tenants.a.project2],
      );
      expect(project.rows[0]?.state).toBe("active");
      expect(await operationState(operationId)).toBe("succeeded");
      expect(await auditActives(environmentId)).toBe(1);
    } finally {
      await provisioner.stop();
    }
  });

  it(`killed at each of its ${String(ENVIRONMENT_POINTS.length)} points and restarted: one policy, one token role, active once`, async () => {
    for (const point of ENVIRONMENT_POINTS) {
      const { environmentId, operationId } = await fx.newEnvironment();
      const doomed = await fx.start({ crashAt: point });
      expect(await doomed.exited, point).toBe(137);
      // The stale-claim rule: the dead worker's claim is old enough to take over.
      await fx.api.superuser.query(
        "UPDATE app.operation SET heartbeat_at = now() - interval '2 minutes' WHERE id = $1 AND state = 'executing'",
        [operationId],
      );
      // The queue would hand the job out again after its expiry; the test sends it again now.
      await fx.send(operationId);
      const clean = await fx.start();
      try {
        await fx.waitFor(environmentId, "active");
        await objectsEqualPlan(environmentId, fx.tenants.a.project1);
        expect(await auditActives(environmentId), point).toBe(1);
        expect(await operationState(operationId), point).toBe("succeeded");
      } finally {
        await clean.stop();
      }
    }
  }, 600_000);

  it("two workers, one job delivered twice: one executes, the other returns", async () => {
    const first = await fx.start();
    const second = await fx.start();
    try {
      const { environmentId, operationId } = await fx.newEnvironment();
      await fx.send(operationId);
      await fx.waitFor(environmentId, "active");
      // Both deliveries are settled.
      const deadline = Date.now() + 30_000;
      const settled = () =>
        [...first.logs, ...second.logs].filter(
          (entry) => entry.event === "job" && entry.operationId === operationId,
        );
      while (settled().length < 2 && Date.now() < deadline) await sleep(200);
      expect(
        settled()
          .map((entry) => entry.outcome)
          .sort(),
      ).toEqual(["active", "not_claimed"]);
      expect(await auditActives(environmentId)).toBe(1);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  it("a different machine policy already present → needs_review / backend_inconsistent, object untouched", async () => {
    const { environmentId, operationId } = await fx.newEnvironment({ send: false });
    const name = machineName(environmentId as EnvironmentId);
    const foreign = 'path "kv/data/*" { capabilities = ["read"] }\n';
    await fx.admin.putPolicy(fx.namespace, name, foreign);
    const provisioner = await fx.start();
    try {
      await fx.send(operationId);
      await fx.waitFor(environmentId, "needs_review");
      expect((await fx.environment(environmentId)).review_reason).toBe("backend_inconsistent");
      expect(await fx.admin.readPolicy(fx.namespace, name)).toBe(foreign);
      expect(await fx.admin.readTokenRole(fx.namespace, name)).toBeNull();
    } finally {
      await provisioner.stop();
    }
  });

  it("gate closed → no job is executed; opened → it runs", async () => {
    fx.setGate("closed");
    const provisioner = await fx.start();
    try {
      const { environmentId } = await fx.newEnvironment();
      await sleep(4000);
      expect((await fx.environment(environmentId)).state).toBe("pending");
      expect(provisioner.logs.some((entry) => entry.event === "job_deferred")).toBe(true);
      fx.setGate("open");
      await fx.waitFor(environmentId, "active", 120_000);
    } finally {
      fx.setGate("open");
      await provisioner.stop();
    }
  }, 180_000);

  it("gate closed longer than the queue's retries (200 s) → still runs once it opens", async () => {
    fx.setGate("closed");
    const provisioner = await fx.start();
    try {
      const { environmentId } = await fx.newEnvironment();
      await sleep(200_000);
      expect((await fx.environment(environmentId)).state).toBe("pending");
      fx.setGate("open");
      await fx.waitFor(environmentId, "active", 90_000);
    } finally {
      fx.setGate("open");
      await provisioner.stop();
    }
  }, 360_000);

  it("OpenBao stopped → the environment stays pending and becomes active after it returns", async () => {
    const provisioner = await fx.start();
    try {
      await stopService(fx.stack, "openbao");
      const { environmentId } = await fx.newEnvironment();
      await sleep(5000);
      expect((await fx.environment(environmentId)).state).toBe("pending");
      await startService(fx.stack, "openbao");
      await fx.waitFor(environmentId, "active", 150_000);
    } finally {
      await provisioner.stop();
    }
  }, 240_000);

  // Run 4.1 Task D (carried from the Session 3 report).
  /** No other job is waiting: a crash point is met by this test's job only. */
  async function settleTenants(): Promise<void> {
    const provisioner = await fx.start();
    try {
      for (const id of [fx.tenants.a.env1a, fx.tenants.a.env1b, fx.tenants.a.env2a]) {
        await fx.waitFor(id, "active");
      }
    } finally {
      await provisioner.stop();
    }
  }

  it("activation requires the environment to be pending and the claim to be current", async () => {
    await settleTenants();
    const { environmentId, operationId } = await fx.newEnvironment();
    const doomed = await fx.start({ crashAt: "token-role:after-record" });
    expect(await doomed.exited).toBe(137);
    // Between the last step and activation, someone else sends the environment to review.
    await fx.api.superuser.query(
      "UPDATE app.environment SET state = 'needs_review', review_reason = 'backend_inconsistent' WHERE id = $1",
      [environmentId],
    );
    await fx.api.superuser.query(
      "UPDATE app.operation SET heartbeat_at = now() - interval '2 minutes' WHERE id = $1",
      [operationId],
    );
    await fx.send(operationId);
    const clean = await fx.start();
    try {
      const deadline = Date.now() + 60_000;
      while ((await operationState(operationId)) === "executing" && Date.now() < deadline) {
        await sleep(250);
      }
      // Give a late activation every chance to happen before asserting it did not.
      await sleep(2000);
      expect((await fx.environment(environmentId)).state).toBe("needs_review");
      // The job ran to its end (not left executing) and did not succeed.
      expect(await operationState(operationId)).toBe("awaiting_input");
      expect(
        clean.logs.some((entry) => entry.event === "job" && entry.operationId === operationId),
      ).toBe(true);
      expect(await auditActives(environmentId)).toBe(0);
    } finally {
      await clean.stop();
    }
  }, 180_000);

  it("a job held by a killed provisioner is taken again within three minutes", async () => {
    await settleTenants();
    const { environmentId } = await fx.newEnvironment();
    const doomed = await fx.start({ crashAt: "machine-policy:before" });
    expect(await doomed.exited).toBe(137);
    const started = Date.now();
    // Nobody sends the job again: the queue's expiry hands it out.
    const second = await fx.start();
    try {
      await fx.waitFor(environmentId, "active", 180_000);
      expect(Date.now() - started).toBeLessThan(180_000);
      await objectsEqualPlan(environmentId, fx.tenants.a.project1);
      expect(await auditActives(environmentId)).toBe(1);
    } finally {
      await second.stop();
    }
  }, 240_000);

  it("kv-scope compares all three fields: delete_version_after changed → the new environment is needs_review / backend_inconsistent", async () => {
    const plan = await fx.admin.readKvConfig(fx.namespace);
    await fx.admin.putKvConfig(fx.namespace, {
      cas_required: true,
      max_versions: 20,
      delete_version_after: "1h",
    });
    const provisioner = await fx.start();
    try {
      const { environmentId } = await fx.newEnvironment();
      await fx.waitFor(environmentId, "needs_review");
      expect((await fx.environment(environmentId)).review_reason).toBe("backend_inconsistent");
    } finally {
      await provisioner.stop();
      await fx.admin.putKvConfig(fx.namespace, {
        cas_required: plan?.cas_required,
        max_versions: plan?.max_versions,
        delete_version_after: plan?.delete_version_after,
      });
      // The start-up sweep sent the organization to review for the same change.
      await fx.api.superuser.query(
        "UPDATE app.organization SET state = 'active', review_reason = NULL WHERE id = $1",
        [fx.tenants.a.organizationId],
      );
    }
  });

  it("a step answered denied ends the job at once: one attempt, the environment in review, no retry", async () => {
    const original = await fx.admin.readPolicy(fx.namespace, "provisioner");
    expect(original).not.toBeNull();
    // Narrowed for one path: the machine policies.
    await fx.admin.putPolicy(
      fx.namespace,
      "provisioner",
      `${original ?? ""}\npath "sys/policies/acl/machine-env-*" { capabilities = ["deny"] }\n`,
    );
    const provisioner = await fx.start();
    try {
      const { environmentId, operationId } = await fx.newEnvironment();
      await fx.waitFor(environmentId, "needs_review");
      expect((await fx.environment(environmentId)).review_reason).toBe("provisioning_failed");
      const steps = await fx.api.superuser.query<{ target: string }>(
        "SELECT target FROM app.operation_step WHERE operation_id = $1 ORDER BY ordinal",
        [operationId],
      );
      expect(steps.rows.map((row) => row.target)).toEqual(["kv-scope", "machine-policy"]);
      // The queue's own record: the job completed on its first attempt.
      let job: { state: string; retry_count: number } | undefined;
      for (let i = 0; i < 50 && job?.state !== "completed"; i += 1) {
        job = (
          await fx.api.superuser.query<{ state: string; retry_count: number }>(
            "SELECT state, retry_count FROM jobs.job WHERE data->>'operationId' = $1",
            [operationId],
          )
        ).rows[0];
        if (job?.state !== "completed") await sleep(200);
      }
      expect(job).toEqual({ state: "completed", retry_count: 0 });
    } finally {
      await provisioner.stop();
      await fx.admin.putPolicy(fx.namespace, "provisioner", original ?? "");
    }
  });

  it("provisioner credential destroyed → the environment is needs_review / provisioning_failed", async () => {
    for (const accessor of await fx.admin.listSecretIdAccessors(fx.namespace, "provisioner")) {
      await fx.admin.destroySecretIdAccessor(fx.namespace, "provisioner", accessor);
    }
    const provisioner = await fx.start();
    try {
      const { environmentId } = await fx.newEnvironment();
      await fx.waitFor(environmentId, "needs_review");
      expect((await fx.environment(environmentId)).review_reason).toBe("provisioning_failed");
    } finally {
      await provisioner.stop();
    }
  });
});
