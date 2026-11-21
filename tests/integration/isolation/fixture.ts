// Run 8.2 (P-151): two organizations, both provisioned in OpenBao through the
// product, each behind its own real-handler API over one database and one
// OpenBao. Side A is the in-process API of the secret suites (A's runtime and
// issuer identities); side B is an API process holding B's. Each side has one
// of every addressable thing: a project, an environment, a secret, a machine
// credential and its token, an operation and an import preview.
//
// Values never leave the helpers: tokens are used, never printed (Doc 10 §4.1).
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OperationId } from "@mykey/contracts";
import { createSender } from "@mykey/operations";
import { expect } from "vitest";
import { TEST_ORIGIN, requestTo, type RequestInit, type TestApi } from "../../harness/api.ts";
import {
  startApiProcess,
  startProvisionerProcess,
  type ApiProcess,
} from "../../harness/api-worker.ts";
import {
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { gateText } from "../../harness/gate.ts";
import { provisionTestOrganization } from "../../harness/org-fixture.ts";
import type { Stack } from "../../harness/stack.ts";

export type AppRoleIdentity = "runtime" | "issuer" | "provisioner";

export interface Side {
  name: "a" | "b";
  organizationId: string;
  /** The real-handler API of this organization. */
  request: TestApi["request"];
  /** The owner's session cookie (mfa_complete). */
  owner: string;
  ids: {
    projectId: string;
    environmentId: string;
    environmentName: string;
    secretName: string;
    credentialId: string;
    operationId: string;
    previewId: string;
    sessionId: string;
  };
  /** Issued by the product for ids.environmentId. */
  machineToken: string;
  appRole(identity: AppRoleIdentity): { roleId: string; secretId: string };
}

export interface IsolationFixture {
  a: Side;
  b: Side;
  stack: Stack;
  f: CredentialsFixture;
  /** Every session freshly verified (the routes that need a fresh code). */
  freshen(): Promise<void>;
  close(): Promise<void>;
}

const json = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text();
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
};

async function seedSide(
  request: TestApi["request"],
  cookie: string,
  path: string,
  label: string,
): Promise<{ secretName: string; operationId: string; previewId: string }> {
  const secretName = `ISO_${label}_${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  const created = await request("POST", `${path}/secrets`, {
    cookie,
    headers: { "idempotency-key": randomUUID() },
    body: { name: secretName, value: `synthetic-${randomUUID()}` },
  });
  const createdBody = await json(created);
  expect(created.status, `create on ${label}`).toBe(201);
  const operationId = createdBody.operationId as string;
  const preview = await request("POST", `${path}/import/preview`, {
    cookie,
    headers: { "content-type": "text/plain" },
    rawBody: `${secretName}_IMPORTED=synthetic\n`,
  });
  const previewBody = await json(preview);
  expect(preview.status, `preview on ${label}`).toBe(200);
  return { secretName, operationId, previewId: previewBody.previewId as string };
}

async function sessionIdOf(request: TestApi["request"], cookie: string): Promise<string> {
  const answer = await request("GET", "/v1/auth/sessions", { cookie });
  const body = (await json(answer)) as { sessions?: { id: string; current: boolean }[] };
  const current = body.sessions?.find((session) => session.current);
  if (current === undefined) throw new Error("no current session");
  return current.id;
}

export async function createIsolationFixture(): Promise<IsolationFixture> {
  const f = await createCredentialsFixture();
  const { api, stack, tenants } = f;
  const cleanup: (() => Promise<void>)[] = [];
  try {
    // B is provisioned through the product, as A was.
    const provisioned = await provisionTestOrganization(api, stack, tenants.b.organizationId);
    const credentialsB = provisioned.credentials;
    const directory = mkdtempSync(join(tmpdir(), "mykey-isolation-"));
    cleanup.push(() => {
      rmSync(directory, { recursive: true, force: true });
      return Promise.resolve();
    });
    const secretsB = join(directory, "secrets");
    mkdirSync(secretsB);
    writeFileSync(join(secretsB, "organization-id"), tenants.b.organizationId);
    for (const identity of ["runtime", "issuer", "provisioner"] as const) {
      writeFileSync(join(secretsB, `${identity}-role-id`), credentialsB[identity].roleId);
      writeFileSync(join(secretsB, `${identity}-secret-id`), credentialsB[identity].secretId);
    }

    // B's environment goes through the real job, by B's own provisioner.
    const environmentB = tenants.b.env1a;
    const operationB = randomUUID() as OperationId;
    await api.superuser.query(
      "UPDATE app.environment SET state = 'pending', kv_ready = false WHERE id = $1",
      [environmentB],
    );
    await api.superuser.query(
      `INSERT INTO app.operation (id, organization_id, principal_kind, principal_id, action, target,
         idempotency_key, state)
       VALUES ($1, $2, 'system', 'test', 'environment.provision', $3, $3, 'accepted')`,
      [operationB, tenants.b.organizationId, environmentB],
    );
    const gatePath = join(directory, "gate.json");
    const binding = {
      hostInstanceId: randomUUID(),
      backendIncarnation: api.gate.backendIncarnation,
      releaseBuild: api.gate.releaseBuild,
    };
    writeFileSync(gatePath, gateText(binding, "open", 1));
    const sender = await createSender(api.pool);
    await sender.send("environment.provision", operationB);
    await sender.stop();
    const provisioner = await startProvisionerProcess(api.database.targets.provisioner_runtime, {
      openBao: { url: stack.bao.url, caCertPath: stack.bao.caCertPath },
      secretsDirectory: secretsB,
      gatePath,
      ...binding,
      stateFile: join(directory, "provisioner-state"),
    });
    try {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const row = await api.superuser.query<{ state: string }>(
          "SELECT state FROM app.environment WHERE id = $1",
          [environmentB],
        );
        if (row.rows[0]?.state === "active") break;
        if (Date.now() > deadline) throw new Error(`B's environment stayed ${row.rows[0]?.state}`);
        await sleep(250);
      }
    } finally {
      await provisioner.stop();
    }

    // B's API: the same database, keys and gate, B's identities.
    const processB: ApiProcess = await startApiProcess(api.database.targets.api_runtime, {
      keysDirectory: f.keysDirectory,
      api: {
        baseUrl: TEST_ORIGIN,
        build: api.gate.releaseBuild,
        gatePath: api.gate.gatePath,
        hostInstanceId: api.gate.hostInstanceId,
        backendIncarnation: api.gate.backendIncarnation,
        trustedProxy: null,
      },
      tls: { certPath: stack.api.certPath, keyPath: stack.api.keyPath },
      openBao: stack.bao,
      secretsDirectory: secretsB,
    });
    cleanup.push(() => processB.kill());
    const ca = readFileSync(stack.api.certAuthorityPath);
    const requestB: TestApi["request"] = (method: string, path: string, init?: RequestInit) =>
      requestTo({ port: processB.port, ca }, method, path, init);
    const requestA: TestApi["request"] = (method: string, path: string, init?: RequestInit) =>
      api.request(method, path, init);

    const envPath = (org: string, project: string, env: string) =>
      `/v1/organizations/${org}/projects/${project}/environments/${env}`;
    const nameOf = async (environmentId: string): Promise<string> =>
      (
        await api.superuser.query<{ name: string }>(
          "SELECT name FROM app.environment WHERE id = $1",
          [environmentId],
        )
      ).rows[0]?.name ?? "";

    const ownerA = await tenants.cookie("ownerA");
    const ownerB = await tenants.cookie("ownerB");
    const pathA = envPath(tenants.a.organizationId, tenants.a.project1, tenants.a.env1a);
    const pathB = envPath(tenants.b.organizationId, tenants.b.project1, environmentB);
    const seededA = await seedSide(requestA, ownerA, pathA, "A");
    const seededB = await seedSide(requestB, ownerB, pathB, "B");
    const issuedA = await issueFor(f, "env1a", { name: "iso-a" });
    await f.freshen();
    const issueB = await requestB("POST", `${pathB}/credentials`, {
      cookie: ownerB,
      headers: { "idempotency-key": randomUUID() },
      body: { name: "iso-b" },
    });
    const issuedB = await json(issueB);
    expect(issueB.status, "issue on B").toBe(201);

    const side = (
      name: "a" | "b",
      organizationId: string,
      request: TestApi["request"],
      owner: string,
      projectId: string,
      environmentId: string,
      environmentName: string,
      seeded: { secretName: string; operationId: string; previewId: string },
      credentialId: string,
      machineToken: string,
      sessionId: string,
      roles: Record<AppRoleIdentity, { roleId: string; secretId: string }>,
    ): Side => ({
      name,
      organizationId,
      request,
      owner,
      ids: { projectId, environmentId, environmentName, ...seeded, credentialId, sessionId },
      machineToken,
      appRole: (identity) => roles[identity],
    });
    const a = side(
      "a",
      tenants.a.organizationId,
      requestA,
      ownerA,
      tenants.a.project1,
      tenants.a.env1a,
      await nameOf(tenants.a.env1a),
      seededA,
      issuedA.credentialId,
      issuedA.token,
      await sessionIdOf(requestA, ownerA),
      f.fx.credentials,
    );
    const b = side(
      "b",
      tenants.b.organizationId,
      requestB,
      ownerB,
      tenants.b.project1,
      environmentB,
      await nameOf(environmentB),
      seededB,
      (issuedB.credential as { credentialId: string }).credentialId,
      issuedB.token as string,
      await sessionIdOf(requestB, ownerB),
      credentialsB,
    );
    return {
      a,
      b,
      stack,
      f,
      freshen: () => f.freshen(),
      async close() {
        for (const step of cleanup.reverse()) await step();
        await f.close();
      },
    };
  } catch (error) {
    for (const step of cleanup.reverse()) await step().catch(() => undefined);
    await f.close();
    throw error;
  }
}
