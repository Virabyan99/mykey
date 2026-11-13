// Shared by the environment and drift suites (Run 3.8 Task C): a private
// stack (these suites stop OpenBao), the tenants of Run 3.7 with organization
// A provisioned through the product, a credential directory and gate file for
// the provisioner process, and helpers for environment operations.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { namespaceFor } from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { createSender, type JobSender } from "@mykey/operations";
import type { OperationId, OrganizationId } from "@mykey/contracts";
import { startTestApi, type TestApi } from "../../harness/api.ts";
import { startProvisionerProcess, type ProvisionerProcess } from "../../harness/api-worker.ts";
import { provisionTestOrganization } from "../../harness/org-fixture.ts";
import { getSharedStack, startStack, type Stack } from "../../harness/stack.ts";
import { createTenants, type Tenants } from "../../harness/tenants.ts";

export interface ProvisioningFixture {
  api: TestApi;
  stack: Stack;
  tenants: Tenants;
  admin: OpenBaoAdmin;
  namespace: string;
  credentials: Awaited<ReturnType<typeof provisionTestOrganization>>["credentials"];
  directory: string;
  /** Writes the provisioner's gate record. */
  setGate(state: "open" | "closed"): void;
  start(opts?: { crashAt?: string; sweepSeconds?: number }): Promise<ProvisionerProcess>;
  /** A new pending environment in `projectId` (default project 1 of A) and its accepted operation; the job is sent. */
  newEnvironment(opts?: {
    projectId?: string;
    send?: boolean;
  }): Promise<{ environmentId: string; operationId: OperationId }>;
  send(operationId: OperationId): Promise<void>;
  environment(environmentId: string): Promise<{
    state: string;
    kv_ready: boolean;
    review_reason: string | null;
    policy_digest: string | null;
  }>;
  waitFor(environmentId: string, state: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

/** A TCP relay to the stack's OpenBao that follows its published port across restarts. */
async function startBaoRelay(stack: Stack): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const relay = net.createServer((client) => {
    const target = new URL(stack.bao.url);
    const upstream = net.connect({ host: target.hostname, port: Number(target.port) });
    sockets.add(client);
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => sockets.delete(client));
    upstream.on("close", () => sockets.delete(upstream));
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  return {
    url: `https://127.0.0.1:${String((relay.address() as net.AddressInfo).port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        relay.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * `shared`: the shared stack (suites that never stop a service); otherwise a
 * private one. `stubs`: routes without a handler answer through the harness stub.
 */
export async function createProvisioningFixture(
  opts: { shared?: boolean; stubs?: boolean } = {},
): Promise<ProvisioningFixture> {
  const stack = opts.shared === true ? await getSharedStack() : await startStack();
  const api = await startTestApi({
    stack,
    relayDatabase: opts.shared !== true,
    ...(opts.stubs === true ? { stubs: true } : {}),
  });
  const relay = await startBaoRelay(stack);
  const tenants = await createTenants(api);
  const organizationId = tenants.a.organizationId;
  const { credentials } = await provisionTestOrganization(api, stack, organizationId);
  const directory = mkdtempSync(join(tmpdir(), "mykey-provisioner-"));
  const secrets = join(directory, "secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "organization-id"), organizationId);
  writeFileSync(join(secrets, "provisioner-role-id"), credentials.provisioner.roleId);
  writeFileSync(join(secrets, "provisioner-secret-id"), credentials.provisioner.secretId);
  const gatePath = join(directory, "gate.json");
  const hostInstanceId = randomUUID();
  let epoch = 0;
  const setGate = (state: "open" | "closed") => {
    epoch += 1;
    writeFileSync(
      gatePath,
      JSON.stringify({
        version: 1,
        state,
        gateEpoch: epoch,
        hostInstanceId,
        writtenAt: new Date().toISOString(),
      }),
    );
  };
  setGate("open");
  const sender: JobSender = await createSender(api.pool);
  const processes: ProvisionerProcess[] = [];

  // The tenants' environments of A were inserted active without machine
  // objects: they go through the real job too, before any provisioner starts
  // (its first sweep would otherwise find them without their objects).
  const { env1a, env1b, env2a } = tenants.a;
  for (const environmentId of [env1a, env1b, env2a]) {
    const operationId = randomUUID() as OperationId;
    await api.superuser.query(
      "UPDATE app.environment SET state = 'pending', kv_ready = false WHERE id = $1",
      [environmentId],
    );
    await api.superuser.query(
      `INSERT INTO app.operation (id, organization_id, principal_kind, principal_id, action, target,
         idempotency_key, state)
       VALUES ($1, $2, 'system', 'test', 'environment.provision', $3, $3, 'accepted')`,
      [operationId, organizationId, environmentId],
    );
    await sender.send("environment.provision", operationId);
  }

  const fixture: ProvisioningFixture = {
    api,
    stack,
    tenants,
    // A new client each time: OpenBao's published port changes when the suite restarts it.
    get admin() {
      return new OpenBaoAdmin(stack.bao, stack.bao.rootToken);
    },
    namespace: namespaceFor(organizationId as OrganizationId),
    credentials,
    directory,
    setGate,
    async start(opts = {}) {
      const started = await startProvisionerProcess(api.database.targets.provisioner_runtime, {
        openBao: { url: relay.url, caCertPath: stack.bao.caCertPath },
        secretsDirectory: secrets,
        gatePath,
        hostInstanceId,
        stateFile: join(directory, `state-${randomUUID()}`),
        ...(opts.sweepSeconds === undefined ? {} : { sweepSeconds: opts.sweepSeconds }),
        ...(opts.crashAt === undefined ? {} : { crashAt: opts.crashAt }),
      });
      processes.push(started);
      return started;
    },
    async newEnvironment(opts = {}) {
      const environmentId = randomUUID();
      const operationId = randomUUID() as OperationId;
      const projectId = opts.projectId ?? tenants.a.project1;
      await api.superuser.query(
        `INSERT INTO app.environment (id, organization_id, project_id, name, state, kv_ready)
         VALUES ($1, $2, $3, $4, 'pending', false)`,
        [environmentId, organizationId, projectId, `e${environmentId.slice(0, 8)}`],
      );
      await api.superuser.query(
        `INSERT INTO app.operation (id, organization_id, principal_kind, principal_id, action, target,
           idempotency_key, state)
         VALUES ($1, $2, 'system', 'test', 'environment.provision', $3, $3, 'accepted')`,
        [operationId, organizationId, environmentId],
      );
      if (opts.send !== false) await sender.send("environment.provision", operationId);
      return { environmentId, operationId };
    },
    send: (operationId) => sender.send("environment.provision", operationId),
    async environment(environmentId) {
      const result = await api.superuser.query<{
        state: string;
        kv_ready: boolean;
        review_reason: string | null;
        policy_digest: string | null;
      }>(
        "SELECT state, kv_ready, review_reason, policy_digest FROM app.environment WHERE id = $1",
        [environmentId],
      );
      return result.rows[0]!;
    },
    async waitFor(environmentId, state, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const current = (await fixture.environment(environmentId)).state;
        if (current === state) return;
        if (Date.now() > deadline) {
          throw new Error(`environment stayed ${current}, expected ${state}`);
        }
        await sleep(250);
      }
    },
    async close() {
      for (const started of processes) await started.kill();
      await sender.stop();
      await relay.close();
      rmSync(directory, { recursive: true, force: true });
      await api.close();
      if (opts.shared !== true) await stack.stop();
    },
  };
  return fixture;
}
