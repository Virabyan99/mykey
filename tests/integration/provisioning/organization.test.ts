// Run 3.8 Task B (FR-1.08, FR-1.12, AC-1.06, P-54, P-55): the operator's
// organization provisioning — compare, then act, never overwrite; one
// operation id however often it runs; a read-only verification.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizationIdSchema, type OrganizationId } from "@mykey/contracts";
import {
  APPROLE_TOKEN_TTL_SECONDS,
  appRoleLogin,
  namespaceFor,
  renderPolicy,
  type AppRoleName,
} from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import {
  provisionOrganization,
  verifyOrganization,
  type ProvisionResult,
} from "@mykey/operations/operator";
import { errorOf, startTestApi, type TestApi } from "../../harness/api.ts";
import { baoFetch, getSharedStack, readAuditLog, type Stack } from "../../harness/stack.ts";
import { createTenants } from "../../harness/tenants.ts";
import { createOrgFixture } from "../../harness/org-fixture.ts";
import { runOps } from "@mykey/ops";
import { PassThrough } from "node:stream";

const ROLES: readonly AppRoleName[] = ["runtime", "issuer", "provisioner"];
const NO_CIDRS: Record<AppRoleName, readonly string[]> = {
  runtime: [],
  issuer: [],
  provisioner: [],
};

let api: TestApi;
let stack: Stack;
let admin: OpenBaoAdmin;
const namespaces: string[] = [];

beforeAll(async () => {
  api = await startTestApi();
  stack = await getSharedStack();
  admin = new OpenBaoAdmin(stack.bao, stack.bao.rootToken);
}, 300_000);

afterAll(async () => {
  for (const namespace of namespaces) {
    await baoFetch(stack, `/v1/sys/namespaces/${namespace}`, { method: "DELETE" });
  }
  await api.close();
});

/** An organization in `provisioning` with `owners` owner memberships (superuser inserts). */
async function seedOrganization(owners = 1): Promise<OrganizationId> {
  const organizationId = organizationIdSchema.parse(randomUUID());
  await api.superuser.query(
    "INSERT INTO app.organization (id, namespace, state) VALUES ($1, $2, 'provisioning')",
    [organizationId, namespaceFor(organizationId)],
  );
  namespaces.push(namespaceFor(organizationId));
  for (let index = 0; index < owners; index += 1) {
    const userId = randomUUID();
    await api.superuser.query(
      `INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, 'Owner', $2, true)`,
      [userId, `owner-${userId.slice(0, 8)}@mykey.invalid`],
    );
    await api.superuser.query(
      `INSERT INTO app.membership (id, organization_id, user_id, role, state)
       VALUES (gen_random_uuid(), $1, $2, 'owner', 'active')`,
      [organizationId, userId],
    );
  }
  return organizationId;
}

interface Delivered {
  name: AppRoleName;
  roleId: string;
  secretId: string;
}

function run(
  organizationId: OrganizationId,
  opts: { boundCidrs?: Record<AppRoleName, readonly string[]>; delivered?: Delivered[] } = {},
): Promise<ProvisionResult> {
  return provisionOrganization(
    {
      pool: api.database.pool("maintenance"),
      admin,
      deliver: (name, credential) => {
        opts.delivered?.push({ name, ...credential });
        return Promise.resolve();
      },
      boundCidrs: opts.boundCidrs ?? NO_CIDRS,
    },
    organizationId,
  );
}

async function organizationRow(organizationId: string) {
  const result = await api.superuser.query<{
    state: string;
    review_reason: string | null;
    config_digest: string | null;
    provisioning_operation_id: string | null;
  }>(
    "SELECT state, review_reason, config_digest, provisioning_operation_id FROM app.organization WHERE id = $1",
    [organizationId],
  );
  return result.rows[0]!;
}

async function operations(organizationId: string) {
  const result = await api.superuser.query<{ id: string; state: string }>(
    "SELECT id, state FROM app.operation WHERE action = 'organization.provision' AND target = $1",
    [organizationId],
  );
  return result.rows;
}

async function auditOutcomes(organizationId: string): Promise<string[]> {
  const result = await api.superuser.query<{ outcome: string }>(
    `SELECT details->>'outcome' AS outcome FROM audit.event
      WHERE action = 'operator.organization_provision' AND organization_id = $1 ORDER BY occurred_at, id`,
    [organizationId],
  );
  return result.rows.map((row) => row.outcome);
}

/** OpenBao requests in the namespace from audit-log entry `from` on that change something. */
async function writesSince(namespace: string, from: number) {
  const entries = (await readAuditLog(stack)).slice(from);
  return entries
    .filter(
      (entry) =>
        entry.type === "request" &&
        entry.namespacePath === `${namespace}/` &&
        ["create", "update", "delete"].includes(entry.operation),
    )
    .map((entry) => `${entry.operation} ${entry.path}`);
}

describe("organization provisioning", () => {
  it("a bootstrapped organization becomes active: every object equal to the plan, one accessor per role, one operation, one audit row", async () => {
    const organizationId = await seedOrganization();
    const delivered: Delivered[] = [];
    const result = await run(organizationId, { delivered });
    expect(result.outcome).toBe("active");
    const namespace = namespaceFor(organizationId);
    expect(await admin.readNamespace(namespace)).toBe(true);
    expect(await verifyOrganization({ admin, boundCidrs: NO_CIDRS }, organizationId)).toEqual({
      differs: [],
    });
    for (const name of ROLES) {
      expect(await admin.readPolicy(namespace, name)).toBe(renderPolicy(name));
      expect(await admin.listSecretIdAccessors(namespace, name)).toHaveLength(1);
    }
    const row = await organizationRow(organizationId);
    expect(row.state).toBe("active");
    expect(row.config_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.review_reason).toBeNull();
    const ops = await operations(organizationId);
    expect(ops).toEqual([{ id: row.provisioning_operation_id, state: "succeeded" }]);
    expect(await auditOutcomes(organizationId)).toEqual(["active"]);
    // Each delivered credential logs in.
    expect(delivered.map((d) => d.name).sort()).toEqual([...ROLES].sort());
    for (const credential of delivered) {
      const login = await appRoleLogin(
        stack.bao,
        namespace,
        credential.roleId,
        credential.secretId,
      );
      expect(login.ok, credential.name).toBe(true);
    }
  });

  it("a second run changes nothing in OpenBao but the secret ids, under the same operation id", async () => {
    const organizationId = await seedOrganization();
    const first = await run(organizationId);
    expect(first.outcome).toBe("active");
    const digest = (await organizationRow(organizationId)).config_digest;
    const from = (await readAuditLog(stack)).length;
    const second = await run(organizationId);
    expect(second).toMatchObject({
      outcome: "active",
      operationId: (first as { operationId: string }).operationId,
    });
    const writes = await writesSince(namespaceFor(organizationId), from);
    const other = writes.filter(
      (write) =>
        !/^update auth\/approle\/role\/[a-z]+\/secret-id(-accessor\/destroy)?$/.test(
          write.replace(/^create /, "update "),
        ) && !write.endsWith("auth/token/revoke-self"),
    );
    expect(other).toEqual([]);
    expect(writes.length).toBeGreaterThan(0);
    expect((await organizationRow(organizationId)).config_digest).toBe(digest);
    expect(await operations(organizationId)).toHaveLength(1);
    expect(await auditOutcomes(organizationId)).toEqual(["active"]);
  });

  const FOREIGN: [
    string,
    string,
    (namespace: string) => Promise<void>,
    (namespace: string) => Promise<void>,
    Record<AppRoleName, readonly string[]>?,
  ][] = [
    [
      "a policy with other text",
      "policy:issuer",
      async (namespace) => {
        await admin.putPolicy(namespace, "issuer", 'path "kv/*" { capabilities = ["read"] }\n');
      },
      async (namespace) => {
        await baoFetch(stack, "/v1/sys/policies/acl/issuer", { method: "DELETE", namespace });
      },
    ],
    [
      "kv/config with cas_required: false",
      "kv-mount",
      async (namespace) => {
        await admin.mountKvOnly(namespace);
        await admin.putKvConfig(namespace, {
          cas_required: false,
          max_versions: 20,
          delete_version_after: "0s",
        });
      },
      async (namespace) => {
        await baoFetch(stack, "/v1/sys/mounts/kv", { method: "DELETE", namespace });
      },
    ],
    [
      "an AppRole with a longer TTL",
      "approle:runtime",
      async (namespace) => {
        await admin.enableAppRole(namespace);
        await admin.putAppRole(namespace, "runtime", APPROLE_TOKEN_TTL_SECONDS.runtime + 60);
      },
      async (namespace) => {
        await baoFetch(stack, "/v1/auth/approle/role/runtime", { method: "DELETE", namespace });
      },
    ],
    [
      "an AppRole without its CIDRs",
      "approle:provisioner",
      async (namespace) => {
        await admin.enableAppRole(namespace);
        await admin.putAppRole(namespace, "provisioner", APPROLE_TOKEN_TTL_SECONDS.provisioner);
      },
      async (namespace) => {
        await baoFetch(stack, "/v1/auth/approle/role/provisioner", { method: "DELETE", namespace });
      },
      { runtime: [], issuer: [], provisioner: ["10.78.3.4/32"] },
    ],
  ];

  for (const [label, step, plant, remove, boundCidrs] of FOREIGN) {
    it(`each foreign object stops it: ${label}`, async () => {
      const organizationId = await seedOrganization();
      const namespace = namespaceFor(organizationId);
      await admin.createNamespace(namespace);
      await plant(namespace);
      // The planted object only: the run writes the objects of earlier steps.
      const snapshot = async () => {
        if (step === "policy:issuer") return admin.readPolicy(namespace, "issuer");
        if (step === "kv-mount") return JSON.stringify(await admin.readKvConfig(namespace));
        const name = step === "approle:runtime" ? "runtime" : "provisioner";
        return JSON.stringify(await admin.readAppRole(namespace, name));
      };
      const before = await snapshot();
      const result = await run(organizationId, boundCidrs === undefined ? {} : { boundCidrs });
      expect(result).toMatchObject({ outcome: "review", step });
      expect(await snapshot()).toBe(before);
      const row = await organizationRow(organizationId);
      expect(row.state).toBe("needs_review");
      expect(row.review_reason).toBe("backend_inconsistent");
      expect((await operations(organizationId))[0]?.state).toBe("awaiting_input");
      expect(await auditOutcomes(organizationId)).toEqual(["review"]);

      await remove(namespace);
      const again = await run(organizationId, boundCidrs === undefined ? {} : { boundCidrs });
      expect(again).toMatchObject({
        outcome: "active",
        operationId: (result as { operationId: string }).operationId,
      });
      const after = await organizationRow(organizationId);
      expect(after.state).toBe("active");
      expect(after.review_reason).toBeNull();
    });
  }

  it("verify-organization says equal after provisioning; after an AppRole's TTL changes it names approle:runtime and writes nothing", async () => {
    const organizationId = await seedOrganization();
    expect((await run(organizationId)).outcome).toBe("active");
    const verify = () => verifyOrganization({ admin, boundCidrs: NO_CIDRS }, organizationId);
    expect(await verify()).toEqual({ differs: [] });
    const namespace = namespaceFor(organizationId);
    const changed = await baoFetch(stack, "/v1/auth/approle/role/runtime", {
      method: "POST",
      namespace,
      body: {
        token_ttl: APPROLE_TOKEN_TTL_SECONDS.runtime + 60,
        token_max_ttl: APPROLE_TOKEN_TTL_SECONDS.runtime + 60,
      },
    });
    expect(changed.status).toBe(204);
    const from = (await readAuditLog(stack)).length;
    expect(await verify()).toEqual({ differs: ["approle:runtime"] });
    expect(await writesSince(namespace, from)).toEqual([]);
  });

  it("no owner, or two owners: refused before any OpenBao request", async () => {
    for (const owners of [0, 2]) {
      const organizationId = await seedOrganization(owners);
      const from = (await readAuditLog(stack)).length;
      const result = await run(organizationId);
      expect(result.outcome, String(owners)).toBe("refused");
      const touched = (await readAuditLog(stack))
        .slice(from)
        .filter((entry) => entry.raw.includes(namespaceFor(organizationId)));
      expect(touched, String(owners)).toEqual([]);
      expect(await admin.readNamespace(namespaceFor(organizationId))).toBe(false);
    }
  });

  it("two runs at once: one works, one reports already running; one namespace", async () => {
    const organizationId = await seedOrganization();
    const results = await Promise.all([run(organizationId), run(organizationId)]);
    const outcomes = results.map((result) => result.outcome).sort();
    expect(outcomes).toEqual(["active", "busy"]);
    expect(await admin.readNamespace(namespaceFor(organizationId))).toBe(true);
    expect(await operations(organizationId)).toHaveLength(1);
  });

  it("a late duplicate of each write is harmless", async () => {
    const organizationId = await seedOrganization();
    expect((await run(organizationId)).outcome).toBe("active");
    const digest = (await organizationRow(organizationId)).config_digest;
    const namespace = namespaceFor(organizationId);
    await admin.createNamespace(namespace).catch(() => undefined);
    await admin.mountKvOnly(namespace).catch(() => undefined);
    await admin.putKvConfig(namespace, {
      cas_required: true,
      max_versions: 20,
      delete_version_after: "0s",
    });
    await admin.enableAppRole(namespace).catch(() => undefined);
    for (const name of ROLES) {
      await admin.putPolicy(namespace, name, renderPolicy(name));
      await admin.putAppRole(namespace, name, APPROLE_TOKEN_TTL_SECONDS[name]);
    }
    expect(await verifyOrganization({ admin, boundCidrs: NO_CIDRS }, organizationId)).toEqual({
      differs: [],
    });
    const again = await run(organizationId);
    expect(again.outcome).toBe("active");
    expect((await organizationRow(organizationId)).config_digest).toBe(digest);
  });
});

describe("an organization that is not active is closed to its owner", () => {
  it("while provisioning: every organization route is 409 state_conflict; organizations.list shows provisioning", async () => {
    const tenants = await createTenants(api);
    await api.superuser.query("UPDATE app.organization SET state = 'provisioning' WHERE id = $1", [
      tenants.a.organizationId,
    ]);
    const cookie = await tenants.cookie("ownerA");
    const list = await api.request(
      "GET",
      `/v1/organizations/${tenants.a.organizationId}/projects`,
      {
        cookie,
      },
    );
    expect(list.status).toBe(409);
    expect((await errorOf(list)).code).toBe("state_conflict");
    const organizations = await api.request("GET", "/v1/organizations", { cookie });
    expect(await organizations.json()).toEqual({
      organizations: [
        { id: tenants.a.organizationId, role: "owner", state: "provisioning", reviewReason: null },
      ],
    });
  });
});

describe("the operator commands and the Session 2 fixture", () => {
  async function ops(argv: string[]) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    stdout.on("data", (chunk: Buffer) => (out += String(chunk)));
    stderr.on("data", (chunk: Buffer) => (out += String(chunk)));
    const code = await runOps(argv, {
      stdin: new PassThrough(),
      stdout,
      stderr,
      env: {
        database: api.database.targets.maintenance,
        openBao: { target: stack.bao, rootToken: stack.bao.rootToken },
        deliver: () => Promise.resolve(),
      },
    });
    return { code, out };
  }

  it("ops provision-organization ends active (exit 0); verify-organization says equal (exit 0), then names a difference (exit 3)", async () => {
    const organizationId = await seedOrganization();
    const provisioned = await ops(["provision-organization", "--organization", organizationId]);
    expect(provisioned.code).toBe(0);
    expect(provisioned.out).toMatch(/^active organization /);
    expect(await ops(["verify-organization", "--organization", organizationId])).toEqual({
      code: 0,
      out: "equal\n",
    });
    await baoFetch(stack, "/v1/sys/policies/acl/issuer", {
      method: "DELETE",
      namespace: namespaceFor(organizationId),
    });
    expect(await ops(["verify-organization", "--organization", organizationId])).toEqual({
      code: 3,
      out: "differs: policy:issuer\n",
    });
    // A second organization of no owner: refused, exit 2.
    const ownerless = await seedOrganization(0);
    expect(await ops(["provision-organization", "--organization", ownerless])).toEqual({
      code: 2,
      out: "refused: no_owner\n",
    });
    expect((await ops(["provision-organization", "--organization", "x"])).code).toBe(64);
  });

  it("the namespace createOrgFixture builds verifies equal to the plan", async () => {
    const fixture = await createOrgFixture(stack);
    try {
      expect(
        await verifyOrganization({ admin, boundCidrs: NO_CIDRS }, fixture.organizationId),
      ).toEqual({ differs: [] });
    } finally {
      await fixture.drop();
    }
  });
});
