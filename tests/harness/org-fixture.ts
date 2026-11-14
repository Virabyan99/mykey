// One organization bootstrapped in OpenBao with the root token, the way the
// provisioner will do it from Run 3.8 on: namespace → KV → AppRole → the three
// policies → the three AppRole roles → per environment a machine policy and a
// token role → every object read back and compared.
//
// Login tokens and secret ids stay in memory; nothing here is printed.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  LIMITS,
  environmentIdSchema,
  organizationIdSchema,
  projectIdSchema,
  type EnvironmentId,
  type OrganizationId,
  type ProjectId,
} from "@mykey/contracts";
import {
  APPROLE_TOKEN_TTL_SECONDS,
  appRoleLogin,
  machineName,
  machineTokenRole,
  namespaceFor,
  renderMachinePolicy,
  renderPolicy,
  type AppRoleName,
  type MachineTokenRole,
} from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { baoFetch, type Stack } from "./stack.ts";

export interface OrgFixture {
  organizationId: OrganizationId;
  namespace: string;
  projectId: ProjectId;
  environments: { id: EnvironmentId; machineName: string }[];
  /** A fresh AppRole login token (new secret id, then login inside the namespace). */
  login(identity: AppRoleName): Promise<string>;
  /** The role id and a new secret id of an AppRole, for inline authentication (Run 4.2). */
  credential(identity: AppRoleName): Promise<{ roleId: string; secretId: string }>;
  /** Deletes the namespace and waits until it is gone. */
  drop(): Promise<void>;
}

const APPROLES: readonly AppRoleName[] = ["runtime", "issuer", "provisioner"];
const DROP_TIMEOUT_MS = 60_000;

function mismatch(what: string): Error {
  return new Error(`org fixture: ${what} does not read back as written`);
}

/** Throws naming the first field of `expected` that `actual` does not hold. None of them is secret. */
function compareFields(
  what: string,
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(actual[key], value)) {
      throw mismatch(`${what} field ${key} (${JSON.stringify(actual[key])})`);
    }
  }
}

async function dropNamespace(stack: Stack, namespace: string): Promise<void> {
  const removed = await baoFetch(stack, `/v1/sys/namespaces/${namespace}`, { method: "DELETE" });
  if (![200, 202, 204, 404].includes(removed.status)) {
    throw new Error(`namespace delete returned HTTP ${removed.status}`);
  }
  const deadline = Date.now() + DROP_TIMEOUT_MS;
  while ((await baoFetch(stack, `/v1/sys/namespaces/${namespace}`)).status !== 404) {
    if (Date.now() > deadline) throw new Error("timed out waiting for namespace deletion");
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

async function readAppRole(
  stack: Stack,
  namespace: string,
  name: AppRoleName,
): Promise<Record<string, unknown>> {
  const response = await baoFetch(stack, `/v1/auth/approle/role/${name}`, { namespace });
  if (response.status !== 200) throw mismatch(`AppRole ${name}`);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

export async function createOrgFixture(
  stack: Stack,
  opts: { environments?: number } = {},
): Promise<OrgFixture> {
  const organizationId = organizationIdSchema.parse(randomUUID());
  const projectId = projectIdSchema.parse(randomUUID());
  const environments = Array.from({ length: opts.environments ?? 2 }, () => {
    const id = environmentIdSchema.parse(randomUUID());
    return { id, machineName: machineName(id) };
  });
  const namespace = namespaceFor(organizationId);
  const admin = new OpenBaoAdmin(stack.bao, stack.bao.rootToken);

  await admin.createNamespace(namespace);
  try {
    await admin.mountKv(namespace);
    await admin.enableAppRole(namespace);
    for (const name of APPROLES) await admin.putPolicy(namespace, name, renderPolicy(name));
    const roleIds = new Map<AppRoleName, string>();
    for (const name of APPROLES) {
      const { roleId } = await admin.putAppRole(namespace, name, APPROLE_TOKEN_TTL_SECONDS[name]);
      roleIds.set(name, roleId);
    }
    for (const environment of environments) {
      await admin.putPolicy(
        namespace,
        environment.machineName,
        renderMachinePolicy(projectId, environment.id),
      );
      await admin.putTokenRole(
        namespace,
        environment.machineName,
        machineTokenRole(environment.id),
      );
    }

    // Read every object back.
    for (const name of APPROLES) {
      if ((await admin.readPolicy(namespace, name)) !== renderPolicy(name)) {
        throw mismatch(`policy ${name}`);
      }
      const role = await readAppRole(stack, namespace, name);
      const ttl = APPROLE_TOKEN_TTL_SECONDS[name];
      const expected = {
        token_policies: [name],
        token_no_default_policy: true,
        token_type: "service",
        token_ttl: ttl,
        token_max_ttl: ttl,
        secret_id_num_uses: 0,
      };
      compareFields(`AppRole ${name}`, role, expected);
    }
    for (const environment of environments) {
      const policy = await admin.readPolicy(namespace, environment.machineName);
      if (policy !== renderMachinePolicy(projectId, environment.id)) {
        throw mismatch("machine policy");
      }
      const role = await admin.readTokenRole(namespace, environment.machineName);
      if (role === null) throw mismatch("machine token role");
      // token_num_uses (0) is applied but a read omits a 0 (see readTokenRole).
      const readable: Partial<MachineTokenRole> = machineTokenRole(environment.id);
      delete readable.token_num_uses;
      compareFields("machine token role", { ...role }, readable);
    }
    const kvConfig = await baoFetch(stack, "/v1/kv/config", { namespace });
    const config = ((await kvConfig.json()) as { data?: Record<string, unknown> }).data ?? {};
    compareFields("kv/config", config, {
      cas_required: true,
      max_versions: LIMITS.secret.versionsKept,
      delete_version_after: "0s",
    });

    return {
      organizationId,
      namespace,
      projectId,
      environments,
      login: async (identity) => {
        const roleId = roleIds.get(identity);
        if (roleId === undefined) throw new Error("unknown AppRole");
        const { secretId } = await admin.newSecretId(namespace, identity);
        const result = await appRoleLogin(stack.bao, namespace, roleId, secretId);
        if (!result.ok) {
          throw new Error(
            `AppRole login failed: ${"status" in result ? `HTTP ${result.status}` : result.cause}`,
          );
        }
        return result.data.token;
      },
      credential: async (identity) => {
        const roleId = roleIds.get(identity);
        if (roleId === undefined) throw new Error("unknown AppRole");
        const { secretId } = await admin.newSecretId(namespace, identity);
        return { roleId, secretId };
      },
      drop: () => dropNamespace(stack, namespace),
    };
  } catch (error) {
    await dropNamespace(stack, namespace).catch(() => undefined);
    throw error;
  }
}

/**
 * Provisions `organizationId` (a row of the test API's database with one
 * owner) through the product's `provisionOrganization`, with the stack's root
 * token and no bound addresses; answers the credentials it delivered (Run 3.8).
 */
export async function provisionTestOrganization(
  api: { database: { pool(role: "maintenance"): import("pg").Pool } },
  stack: Stack,
  organizationId: string,
): Promise<{ credentials: Record<AppRoleName, { roleId: string; secretId: string }> }> {
  const { provisionOrganization } = await import("@mykey/operations/operator");
  const credentials = {} as Record<AppRoleName, { roleId: string; secretId: string }>;
  const result = await provisionOrganization(
    {
      pool: api.database.pool("maintenance"),
      admin: new OpenBaoAdmin(stack.bao, stack.bao.rootToken),
      deliver: (name, credential) => {
        credentials[name] = credential;
        return Promise.resolve();
      },
      boundCidrs: { runtime: [], issuer: [], provisioner: [] },
    },
    organizationIdSchema.parse(organizationId),
  );
  if (result.outcome !== "active") throw new Error(`provisioning ended ${result.outcome}`);
  return { credentials };
}
