// Run 6.7 Task B (P-124, D-55): the OpenBao admin methods a restore uses,
// against the local OpenBao. Accessors are revoked only inside a fresh
// organization namespace here: the root namespace of the shared stack holds
// other tests' tokens.
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrgFixture, type OrgFixture } from "../../harness/org-fixture.ts";
import { baoFetch, getSharedStack, type Stack } from "../../harness/stack.ts";

let stack: Stack;
let org: OrgFixture;
let admin: OpenBaoAdmin;

beforeAll(async () => {
  stack = await getSharedStack();
  org = await createOrgFixture(stack);
  admin = new OpenBaoAdmin(stack.bao, stack.bao.rootToken);
}, 300_000);

afterAll(async () => {
  await org.drop();
});

const selfStatus = async (token: string, namespace: string): Promise<number> =>
  (await baoFetch(stack, "/v1/auth/token/lookup-self", { token, namespace })).status;

const loginStatus = async (credential: { roleId: string; secretId: string }): Promise<number> =>
  (
    await baoFetch(stack, "/v1/auth/approle/login", {
      method: "POST",
      token: "",
      namespace: org.namespace,
      body: { role_id: credential.roleId, secret_id: credential.secretId },
    })
  ).status;

describe("OpenBaoAdmin for a restore (P-124)", () => {
  it("lists the namespaces, without their trailing slash", async () => {
    expect(await admin.listNamespaces()).toContain(org.namespace);
  });

  it("a root token minted by a root token works, names its accessor and revokes itself", async () => {
    const minted = await admin.createRootToken();
    const second = new OpenBaoAdmin(stack.bao, minted.token);
    const self = await second.lookupSelf();
    expect(self.accessor).toBe(minted.accessor);
    expect(self.policies).toContain("root");
    expect(await admin.listAccessors("")).toContain(minted.accessor);
    await second.revokeSelf();
    expect(await selfStatus(minted.token, "")).toBe(403);
  });

  it("an accessor in a namespace is looked up, revoked, and its token is refused", async () => {
    const token = await org.login("runtime");
    const lookup = await baoFetch(stack, "/v1/auth/token/lookup-self", {
      token,
      namespace: org.namespace,
    });
    const accessor = ((await lookup.json()) as { data: { accessor: string } }).data.accessor;
    expect(await admin.listAccessors(org.namespace)).toContain(accessor);
    expect((await admin.lookupAccessor(org.namespace, accessor))?.policies).toContain("runtime");
    await admin.revokeAccessor(org.namespace, accessor);
    expect(await selfStatus(token, org.namespace)).toBe(403);
    expect(await admin.listAccessors(org.namespace)).not.toContain(accessor);
    expect(await admin.lookupAccessor(org.namespace, accessor)).toBeNull();
  });

  it("rotateSecretId leaves one new secret id; the old one no longer logs in", async () => {
    const before = Date.now();
    const old = await org.credential("issuer");
    expect(await loginStatus(old)).toBe(200);
    const rotated = await admin.rotateSecretId(org.namespace, "issuer");
    expect(rotated.roleId).toBe(old.roleId);
    expect(await loginStatus(old)).toBe(400);
    expect(await loginStatus(rotated)).toBe(200);
    const accessors = await admin.listSecretIdAccessors(org.namespace, "issuer");
    expect(accessors).toHaveLength(1);
    const created = await admin.secretIdCreatedAt(org.namespace, "issuer", accessors[0] ?? "");
    expect(created?.getTime()).toBeGreaterThanOrEqual(before - 2_000);
  });
});
