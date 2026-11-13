// Run 3.8 Task D (FR-1.08, FR-1.55, AC-1.09, PO-4): the provisioner on
// staging. The staging organization is active; the API holds no provisioner
// or root credential; the provisioner has no port and no route out; the runtime
// credential works only from the API's address; and a machine policy removed
// with the root token sends its environment to review within a sweep, where
// the owner sees 503 backend_inconsistent, the host reports reviewOpen and the
// probe opens review_open — and leaves it once the drill is undone.
// The synthetic project and environment stay for Run 3.10 (ids in the run note).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@mykey/db";
import { appRoleLogin, machineName, namespaceFor, renderMachinePolicy } from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { createSender } from "@mykey/operations";
import type { EnvironmentId, OperationId, OrganizationId, ProjectId } from "@mykey/contracts";
import type pg from "pg";
import {
  connectStaging,
  expectSuccess,
  hostStatus,
  loadHosts,
  registerSecret,
  sshExec,
  type StagingStack,
} from "../harness/staging.ts";
import { publicRequest, stagingOwnerSession } from "../harness/staging-owner.ts";

const host = loadHosts().staging;
/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b" as OrganizationId;
const API = "mykey-api-1";
const PROVISIONER = "mykey-provisioner-1";

let staging: StagingStack;
let superuser: pg.Pool;

const run = async (command: string, secretOutput = false): Promise<string> =>
  expectSuccess(
    await sshExec(host, command, { sudo: true, timeoutMs: 120_000, secretOutput }),
    command,
  ).stdout;

beforeAll(async () => {
  staging = await connectStaging({ openbao: true });
  superuser = createPool(
    {
      host: staging.pg.host,
      port: staging.pg.port,
      database: "postgres",
      user: "postgres",
      password: staging.pg.superuser.password,
      caCertPath: staging.pg.caCertPath,
    },
    { max: 3 },
  );
}, 120_000);

afterAll(async () => {
  await superuser.end();
  await staging.close();
});

async function waitUntil<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(value)}`);
    await sleep(5000);
  }
}

/** The probe's view of staging (`probe.ts state`: `{ now, state: HostState, alerts }`). */
function probeState(): { open?: Record<string, unknown> } {
  const result = spawnSync(process.execPath, ["scripts/probe.ts", "state", "staging"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`probe.ts state: ${result.stderr.slice(-300)}`);
  return (JSON.parse(result.stdout) as { state: { open?: Record<string, unknown> } }).state;
}

describe("the provisioner on staging", () => {
  it("the staging organization is active with a config_digest", async () => {
    const result = await superuser.query<{ state: string; config_digest: string | null }>(
      "SELECT state, config_digest FROM app.organization WHERE id = $1",
      [ORGANIZATION],
    );
    expect(result.rows[0]?.state).toBe("active");
    expect(result.rows[0]?.config_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the API mounts no provisioner secret, holds no root or provisioner credential, and its self-check logged runtimeLogin ok", async () => {
    const mounts = JSON.parse(
      await run(`docker inspect --format '{{json .Mounts}}' ${API}`, true),
    ) as {
      Source: string;
    }[];
    expect(mounts.some((mount) => mount.Source.includes("/secrets/provisioner"))).toBe(false);
    const files = (await run(`docker exec ${API} ls /run/mykey/secrets`, true))
      .trim()
      .split("\n")
      .sort();
    expect(files.filter((name) => /provisioner|root|unseal|recovery/.test(name))).toEqual([]);
    expect(files).toEqual(
      expect.arrayContaining([
        "db-password",
        "organization-id",
        "runtime-role-id",
        "runtime-secret-id",
      ]),
    );
    const env = await run(`docker inspect --format '{{json .Config.Env}}' ${API}`);
    expect(env).not.toMatch(/ROOT|PROVISIONER|SECRET_ID|BAO_TOKEN/i);
    const logs = await run(`docker logs ${API} 2>&1 | grep '"selfcheck"' | tail -n 1`);
    expect(logs).toContain('"runtimeLogin":"ok"');
  });

  it("the provisioner container has no published port and is only on the db and bao bridges", async () => {
    const inspect = JSON.parse(
      await run(
        `docker inspect --format '{{json .NetworkSettings.Ports}}|{{json .HostConfig.PortBindings}}|{{json .NetworkSettings.Networks}}' ${PROVISIONER} | tr '|' '\\n'`,
      ).then((text) => `[${text.trim().split("\n").join(",")}]`),
    ) as [Record<string, unknown> | null, Record<string, unknown> | null, Record<string, unknown>];
    const [ports, bindings, networks] = inspect;
    expect(Object.values(ports ?? {}).filter((value) => value !== null)).toEqual([]);
    expect(bindings ?? {}).toEqual({});
    expect(Object.keys(networks).sort()).toEqual(["mykey_bao", "mykey_db"]);
    const health = (
      await run(`docker inspect -f '{{.State.Health.Status}}' ${PROVISIONER}`)
    ).trim();
    expect(health).toBe("healthy");
  });

  it("the runtime credential is refused from the tunnel's address", async () => {
    const roleId = (await run("cat /etc/mykey/secrets/api/runtime-role-id", true)).trim();
    const secretId = (await run("cat /etc/mykey/secrets/api/runtime-secret-id", true)).trim();
    registerSecret(roleId);
    registerSecret(secretId);
    const login = await appRoleLogin(staging.bao, namespaceFor(ORGANIZATION), roleId, secretId);
    expect(login.ok).toBe(false);
  });

  it("AC-1.09: a machine policy removed with the root token → review within a sweep, 503 to the owner, reviewOpen and review_open; undone, the alert leaves", async () => {
    const baseline = (await hostStatus(host)).reviewOpen ?? 0;
    // A synthetic project and environment, provisioned by the provisioner.
    const projectId = randomUUID() as ProjectId;
    const environmentId = randomUUID() as EnvironmentId;
    const operationId = randomUUID() as OperationId;
    await superuser.query(
      "INSERT INTO app.project (id, organization_id, name, state) VALUES ($1, $2, $3, 'pending')",
      [projectId, ORGANIZATION, `Drill ${projectId.slice(0, 8)}`],
    );
    await superuser.query(
      `INSERT INTO app.environment (id, organization_id, project_id, name, state, kv_ready)
       VALUES ($1, $2, $3, 'drill', 'pending', false)`,
      [environmentId, ORGANIZATION, projectId],
    );
    await superuser.query(
      `INSERT INTO app.operation (id, organization_id, principal_kind, principal_id, action, target,
         idempotency_key, state)
       VALUES ($1, $2, 'system', 'staging-drill', 'environment.provision', $3, $3, 'accepted')`,
      [operationId, ORGANIZATION, environmentId],
    );
    const sender = await createSender(superuser);
    await sender.send("environment.provision", operationId);
    await sender.stop();
    process.stderr.write(`drill: project ${projectId} environment ${environmentId}\n`);
    const environmentState = async () =>
      (
        await superuser.query<{ state: string; review_reason: string | null }>(
          "SELECT state, review_reason FROM app.environment WHERE id = $1",
          [environmentId],
        )
      ).rows[0]!;
    await waitUntil("provisioning", environmentState, (row) => row.state === "active", 120_000);

    // The drift: the machine policy deleted with the root token.
    const admin = new OpenBaoAdmin(staging.bao, staging.bao.rootToken);
    const namespace = namespaceFor(ORGANIZATION);
    const name = machineName(environmentId);
    await admin.deletePolicy(namespace, name);
    // Undone in `finally`: a drill that stops early must not leave a review open.
    try {
      const detected = await waitUntil(
        "drift detection",
        environmentState,
        (row) => row.state === "needs_review",
        150_000,
      );
      expect(detected.review_reason).toBe("backend_inconsistent");

      const { cookie } = await stagingOwnerSession();
      const base = `/v1/organizations/${ORGANIZATION}/projects/${projectId}/environments`;
      const secrets = await publicRequest("GET", `${base}/${environmentId}/secrets`, { cookie });
      expect(secrets.status).toBe(503);
      expect((JSON.parse(secrets.body) as { error: { code: string } }).error.code).toBe(
        "backend_inconsistent",
      );
      // Listing still answers (its handler since Run 3.9) and shows the environment in review.
      const listed = await publicRequest("GET", base, { cookie });
      expect(listed.status).toBe(200);
      const shown = (JSON.parse(listed.body) as { environments: { id: string; state: string }[] })
        .environments;
      expect(shown.find((environment) => environment.id === environmentId)?.state).toBe(
        "needs_review",
      );

      expect((await hostStatus(host)).reviewOpen).toBe(baseline + 1);
      await waitUntil(
        "review_open at the probe",
        () => Promise.resolve(probeState()),
        (s) => s.open?.review_open !== undefined,
        240_000,
      );
    } finally {
      // Undo: the policy back, the environment active (the reconciliation command is Run 4.5).
      await admin.putPolicy(namespace, name, renderMachinePolicy(projectId, environmentId));
      await superuser.query(
        "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
        [environmentId],
      );
    }
    await waitUntil(
      "review_open leaves",
      () => Promise.resolve(probeState()),
      (s) => s.open?.review_open === undefined,
      300_000,
    );
    expect((await hostStatus(host)).reviewOpen).toBe(baseline);
  }, 900_000);
});
