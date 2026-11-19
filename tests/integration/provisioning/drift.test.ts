// Run 3.8 Task C (FR-1.55, AC-1.09, P-55): the drift sweep sends exactly the
// scope whose objects changed to review, writes one audit row per detection,
// changes nothing while OpenBao is away, and the pipeline then answers 503
// backend_inconsistent for that scope's secret routes while still listing it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EnvironmentId, ProjectId } from "@mykey/contracts";
import { machineName, machineTokenRole, renderMachinePolicy, renderPolicy } from "@mykey/openbao";
import { LIMITS } from "@mykey/contracts";
import { errorOf } from "../../harness/api.ts";
import type { ProvisionerProcess } from "../../harness/api-worker.ts";
import { baoFetch, startService, stopService } from "../../harness/stack.ts";
import { createProvisioningFixture, type ProvisioningFixture } from "./fixture.ts";

let fx: ProvisioningFixture;
let provisioner: ProvisionerProcess;

beforeAll(async () => {
  fx = await createProvisioningFixture();
  provisioner = await fx.start();
  for (const id of [fx.tenants.a.env1a, fx.tenants.a.env1b, fx.tenants.a.env2a]) {
    await fx.waitFor(id, "active");
  }
}, 600_000);

afterAll(async () => {
  await provisioner.stop();
  await fx.close();
}, 300_000);

const env = (id: string) => id as EnvironmentId;

/** Puts every object back as provisioned and every scope back to active. */
async function restore(): Promise<void> {
  const { namespace, admin } = fx;
  for (const name of ["runtime", "issuer", "provisioner"] as const) {
    await admin.putPolicy(namespace, name, renderPolicy(name));
  }
  await admin.putKvConfig(namespace, {
    cas_required: true,
    max_versions: LIMITS.secret.versionsKept,
    delete_version_after: "0s",
  });
  const { a } = fx.tenants;
  for (const [id, project] of [
    [a.env1a, a.project1],
    [a.env1b, a.project1],
    [a.env2a, a.project2],
  ] as const) {
    await admin.putPolicy(
      namespace,
      machineName(env(id)),
      renderMachinePolicy(project as ProjectId, env(id)),
    );
    await admin.putTokenRole(namespace, machineName(env(id)), machineTokenRole(env(id)));
  }
  await fx.api.superuser.query(
    "UPDATE app.organization SET state = 'active', review_reason = NULL WHERE id = $1",
    [a.organizationId],
  );
  await fx.api.superuser.query(
    "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE organization_id = $1",
    [a.organizationId],
  );
}

beforeEach(async () => {
  await restore();
});

async function states() {
  const { a } = fx.tenants;
  const organization = await fx.api.superuser.query<{ state: string }>(
    "SELECT state FROM app.organization WHERE id = $1",
    [a.organizationId],
  );
  const environments = await fx.api.superuser.query<{ id: string; state: string }>(
    "SELECT id, state FROM app.environment WHERE id = ANY($1)",
    [[a.env1a, a.env1b, a.env2a]],
  );
  const of = (id: string) => environments.rows.find((row) => row.id === id)?.state;
  return {
    organization: organization.rows[0]?.state,
    env1a: of(a.env1a),
    env1b: of(a.env1b),
    env2a: of(a.env2a),
  };
}

async function driftRows(targetId: string): Promise<{ scope: string; object: string }[]> {
  const result = await fx.api.superuser.query<{ scope: string; object: string }>(
    `SELECT details->>'scope' AS scope, details->>'object' AS object FROM audit.event
      WHERE action = 'system.drift_detected' AND target_id = $1 ORDER BY occurred_at`,
    [targetId],
  );
  return result.rows;
}

describe("drift sweep", () => {
  it("machine policy deleted → within one sweep that environment is needs_review, its sibling and the organization are not", async () => {
    const { a } = fx.tenants;
    const before = (await driftRows(a.env1a)).length;
    await baoFetch(fx.stack, `/v1/sys/policies/acl/${machineName(env(a.env1a))}`, {
      method: "DELETE",
      namespace: fx.namespace,
    });
    await provisioner.sweep();
    expect(await states()).toEqual({
      organization: "active",
      env1a: "needs_review",
      env1b: "active",
      env2a: "active",
    });
    const rows = await driftRows(a.env1a);
    expect(rows.slice(before)).toEqual([{ scope: "environment", object: "machine_policy" }]);
    await provisioner.sweep();
    expect(await driftRows(a.env1a)).toHaveLength(before + 1);
  });

  it("token role changed (longer TTL) → that environment is needs_review", async () => {
    const { a } = fx.tenants;
    const before = (await driftRows(a.env1b)).length;
    await fx.admin.putTokenRole(fx.namespace, machineName(env(a.env1b)), {
      ...machineTokenRole(env(a.env1b)),
      token_explicit_max_ttl: LIMITS.machineToken.maxTtlSeconds + 3600,
    });
    await provisioner.sweep();
    expect(await states()).toEqual({
      organization: "active",
      env1a: "active",
      env1b: "needs_review",
      env2a: "active",
    });
    expect((await driftRows(a.env1b)).slice(before)).toEqual([
      { scope: "environment", object: "machine_token_role" },
    ]);
  });

  const ORGANIZATION_CASES: [string, () => Promise<void>, string][] = [
    [
      "policy runtime deleted",
      async () => {
        await baoFetch(fx.stack, "/v1/sys/policies/acl/runtime", {
          method: "DELETE",
          namespace: fx.namespace,
        });
      },
      "policy_runtime",
    ],
    [
      "kv/config changed",
      async () => {
        await fx.admin.putKvConfig(fx.namespace, {
          cas_required: true,
          max_versions: 5,
          delete_version_after: "0s",
        });
      },
      "kv_config",
    ],
    [
      "a mount whose delete_version_after was changed",
      async () => {
        await fx.admin.putKvConfig(fx.namespace, {
          cas_required: true,
          max_versions: 20,
          delete_version_after: "1h",
        });
      },
      "kv_config",
    ],
    [
      "policy provisioner deleted",
      async () => {
        await baoFetch(fx.stack, "/v1/sys/policies/acl/provisioner", {
          method: "DELETE",
          namespace: fx.namespace,
        });
      },
      "provisioner_login",
    ],
  ];

  for (const [label, change, object] of ORGANIZATION_CASES) {
    it(`${label} → the organization is needs_review`, async () => {
      const { a } = fx.tenants;
      const before = (await driftRows(a.organizationId)).length;
      await change();
      await provisioner.sweep();
      expect((await states()).organization).toBe("needs_review");
      expect((await driftRows(a.organizationId)).slice(before)).toEqual([
        { scope: "organization", object },
      ]);
      await provisioner.sweep();
      expect(await driftRows(a.organizationId)).toHaveLength(before + 1);
    });
  }

  it("OpenBao stopped during a sweep → nothing changes state", async () => {
    await stopService(fx.stack, "openbao");
    try {
      const before = provisioner.logs.length;
      await provisioner.sweep();
      // The log says OpenBao could not be read — never that it is equal, never
      // another incarnation. Two outcomes are right, and timing picks one: the
      // incarnation check (Run 6.7) still holds a good reading from the last 5 s,
      // so the sweep runs and counts the organization unread; or it reads now and
      // the sweep is skipped as `unreachable` (Session 6 gate).
      const outcome = provisioner.logs
        .slice(before)
        .find((entry) => entry.event === "sweep" || entry.event === "sweep_skipped");
      expect([
        { event: "sweep", reviewed: 0, unread: 1 },
        { event: "sweep_skipped", cause: "unreachable" },
      ]).toContainEqual(outcome);
      expect(await states()).toEqual({
        organization: "active",
        env1a: "active",
        env1b: "active",
        env2a: "active",
      });
    } finally {
      await startService(fx.stack, "openbao");
    }
  }, 240_000);

  it("the pipeline then answers 503 backend_inconsistent for a secret route on that scope and still lists it", async () => {
    const { a } = fx.tenants;
    await baoFetch(fx.stack, `/v1/sys/policies/acl/${machineName(env(a.env1a))}`, {
      method: "DELETE",
      namespace: fx.namespace,
    });
    await provisioner.sweep();
    const cookie = await fx.tenants.cookie("ownerA");
    const base = `/v1/organizations/${a.organizationId}/projects/${a.project1}/environments`;
    const reviewed = await fx.api.request("GET", `${base}/${a.env1a}/secrets`, { cookie });
    expect(reviewed.status).toBe(503);
    expect((await errorOf(reviewed)).code).toBe("backend_inconsistent");
    // Listing still answers (its handler since Run 3.9) and shows the scope in review.
    const listed = await fx.api.request("GET", base, { cookie });
    expect(listed.status).toBe(200);
    const shown = (
      (await listed.clone().json()) as { environments: { id: string; state: string }[] }
    ).environments;
    expect(shown.find((environment) => environment.id === a.env1a)?.state).toBe("needs_review");
    const auditDenied = await fx.api.superuser.query(
      "SELECT 1 FROM audit.event WHERE action = 'access.denied' AND request_id = $1",
      [listed.headers.get("x-request-id")],
    );
    expect(auditDenied.rowCount).toBe(0);
    // A sibling environment is not in review: its list answers (handler since Run 4.3).
    const sibling = await fx.api.request("GET", `${base}/${a.env1b}/secrets`, { cookie });
    expect(sibling.status).toBe(200);
  });
});
