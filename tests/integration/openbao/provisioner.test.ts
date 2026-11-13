// Run 3.8 Task A (P-55, P-56, M14): what the provisioner identity can read for
// verification, AppRoles bound to addresses, and secret-id accessors that can
// be listed and destroyed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPROLE_TOKEN_TTL_SECONDS,
  appRoleLogin,
  machineTokenRole,
  renderMachinePolicy,
  renderPolicy,
} from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { ProvisionerClient } from "@mykey/openbao/provisioner";
import { LIMITS } from "@mykey/contracts";
import { createOrgFixture, type OrgFixture } from "../../harness/org-fixture.ts";
import { getSharedStack, readAuditLog, type Stack } from "../../harness/stack.ts";

let stack: Stack;
let org: OrgFixture;
let admin: OpenBaoAdmin;

beforeAll(async () => {
  stack = await getSharedStack();
  org = await createOrgFixture(stack);
  admin = new OpenBaoAdmin(stack.bao, stack.bao.rootToken);
});

afterAll(async () => {
  await (org as OrgFixture | undefined)?.drop();
});

async function provisionerCredential(): Promise<{ roleId: string; secretId: string }> {
  const { roleId } = await admin.readRoleId(org.namespace, "provisioner");
  const { secretId } = await admin.newSecretId(org.namespace, "provisioner");
  return { roleId, secretId };
}

describe("the provisioner identity reads what it verifies", () => {
  it("reads the three organization policies, sys/mounts/kv and kv/config", async () => {
    const client = new ProvisionerClient(stack.bao, org.namespace, await provisionerCredential());
    try {
      for (const name of ["runtime", "issuer", "provisioner"] as const) {
        expect(await client.readOrgPolicy(name)).toEqual({ ok: true, value: renderPolicy(name) });
      }
      const mount = await client.readKvMount();
      expect(mount.ok && mount.value?.type).toBe("kv");
      expect(mount.ok && (mount.value?.options as Record<string, unknown>).version).toBe("2");
      const config = await client.readKvConfig();
      expect(config.ok && config.value).toMatchObject({
        cas_required: true,
        max_versions: LIMITS.secret.versionsKept,
      });
    } finally {
      await client.close();
    }
  });

  it("reads and writes machine policies and token roles, and reads back what it wrote", async () => {
    const client = new ProvisionerClient(stack.bao, org.namespace, await provisionerCredential());
    try {
      const environment = org.environments[0]!;
      const hcl = renderMachinePolicy(org.projectId, environment.id);
      expect(await client.putMachinePolicy(environment.machineName, hcl)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await client.readMachinePolicy(environment.machineName)).toEqual({
        ok: true,
        value: hcl,
      });
      const role = machineTokenRole(environment.id);
      expect(await client.putMachineTokenRole(environment.machineName, role)).toEqual({
        ok: true,
        value: undefined,
      });
      const readable: Record<string, unknown> = { ...role };
      delete readable.token_num_uses;
      expect(await client.readMachineTokenRole(environment.machineName)).toEqual({
        ok: true,
        value: readable,
      });
    } finally {
      await client.close();
    }
  });

  it("a destroyed credential answers denied, an unreachable server unreachable", async () => {
    const credential = await provisionerCredential();
    for (const accessor of await admin.listSecretIdAccessors(org.namespace, "provisioner")) {
      await admin.destroySecretIdAccessor(org.namespace, "provisioner", accessor);
    }
    const denied = new ProvisionerClient(stack.bao, org.namespace, credential);
    expect(await denied.readOrgPolicy("runtime")).toEqual({ ok: false, cause: "denied" });
    const away = new ProvisionerClient(
      { url: "https://127.0.0.1:9", caCertPath: stack.bao.caCertPath },
      org.namespace,
      credential,
    );
    expect(await away.readKvConfig()).toEqual({ ok: false, cause: "unreachable" });
  });
});

describe("secret-id accessors (M14)", () => {
  it("after three newSecretId calls the list has three; after destroying them no login works", async () => {
    for (const accessor of await admin.listSecretIdAccessors(org.namespace, "issuer")) {
      await admin.destroySecretIdAccessor(org.namespace, "issuer", accessor);
    }
    const { roleId } = await admin.readRoleId(org.namespace, "issuer");
    const secrets = [
      await admin.newSecretId(org.namespace, "issuer"),
      await admin.newSecretId(org.namespace, "issuer"),
      await admin.newSecretId(org.namespace, "issuer"),
    ];
    const accessors = await admin.listSecretIdAccessors(org.namespace, "issuer");
    expect(accessors).toHaveLength(3);
    // Control: each logs in before.
    for (const { secretId } of secrets) {
      expect((await appRoleLogin(stack.bao, org.namespace, roleId, secretId)).ok).toBe(true);
    }
    for (const accessor of accessors) {
      await admin.destroySecretIdAccessor(org.namespace, "issuer", accessor);
    }
    expect(await admin.listSecretIdAccessors(org.namespace, "issuer")).toEqual([]);
    for (const { secretId } of secrets) {
      expect((await appRoleLogin(stack.bao, org.namespace, roleId, secretId)).ok).toBe(false);
    }
  });
});

describe("AppRoles bound to addresses (P-56)", () => {
  it("bound to 203.0.113.7/32 a login from the test host is refused; bound to the test host's address it is accepted", async () => {
    const ttl = APPROLE_TOKEN_TTL_SECONDS.runtime;
    await admin.putAppRole(org.namespace, "runtime", ttl, ["203.0.113.7/32"]);
    const role = await admin.readAppRole(org.namespace, "runtime");
    // Observed on 2.7.2: secret_id_bound_cidrs reads back as written, while
    // token_bound_cidrs reads a /32 back as the bare address.
    expect(role?.secret_id_bound_cidrs).toEqual(["203.0.113.7/32"]);
    expect(role?.token_bound_cidrs).toEqual(["203.0.113.7"]);
    const { roleId } = await admin.readRoleId(org.namespace, "runtime");
    const { secretId } = await admin.newSecretId(org.namespace, "runtime");
    const refused = await appRoleLogin(stack.bao, org.namespace, roleId, secretId);
    expect(refused.ok).toBe(false);

    // The address OpenBao sees for this host, from its own audit log.
    const entries = await readAuditLog(stack);
    const login = entries
      .filter(
        (entry) =>
          entry.type === "request" &&
          entry.path === "auth/approle/login" &&
          entry.namespacePath === `${org.namespace}/`,
      )
      .at(-1);
    const address = (JSON.parse(login!.raw) as { request: { remote_address: string } }).request
      .remote_address;
    expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

    await admin.putAppRole(org.namespace, "runtime", ttl, [`${address}/32`]);
    const bound = await admin.newSecretId(org.namespace, "runtime");
    const accepted = await appRoleLogin(stack.bao, org.namespace, roleId, bound.secretId);
    expect(accepted.ok).toBe(true);
    // Back to unbound for the rest of the suite's fixture use.
    await admin.putAppRole(org.namespace, "runtime", ttl);
  });
});
