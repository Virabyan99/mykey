// Run 8.0 Task A (P-149): OpenBao's user lockout is switched off for AppRole.
// With the default (five failures, fifteen minutes) one credential mistake
// locks the role id out even for the right secret id, and every secret read of
// the organization stops (Run 6.9). The secret ids are random and OpenBao is
// reachable only from the product's own containers, so the lockout protects
// nothing here. The test stack reads the same `user_lockout` stanza as the
// host's template (tests/unit/hosts/openbao-config.test.ts checks the template).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baoFetch, freshNamespace, getSharedStack, type Stack } from "../../harness/stack.ts";

let stack: Stack;
let namespace: { path: string; drop(): Promise<void> };
let roleId: string;
let secretId: string;

beforeAll(async () => {
  stack = await getSharedStack();
  namespace = await freshNamespace(stack);
  const ns = namespace.path;
  const mounted = await baoFetch(stack, "/v1/sys/auth/approle", {
    method: "POST",
    namespace: ns,
    body: { type: "approle" },
  });
  expect(mounted.status).toBe(204);
  const role = await baoFetch(stack, "/v1/auth/approle/role/lockout-probe", {
    method: "POST",
    namespace: ns,
    body: { token_ttl: "1m", token_policies: ["default"] },
  });
  expect(role.status).toBe(204);
  const readRole = await baoFetch(stack, "/v1/auth/approle/role/lockout-probe/role-id", {
    namespace: ns,
  });
  roleId = ((await readRole.json()) as { data: { role_id: string } }).data.role_id;
  const issued = await baoFetch(stack, "/v1/auth/approle/role/lockout-probe/secret-id", {
    method: "POST",
    namespace: ns,
  });
  secretId = ((await issued.json()) as { data: { secret_id: string } }).data.secret_id;
});

afterAll(async () => {
  await (namespace as typeof namespace | undefined)?.drop();
});

function login(secret: string): Promise<Response> {
  return baoFetch(stack, "/v1/auth/approle/login", {
    method: "POST",
    token: "",
    namespace: namespace.path,
    body: { role_id: roleId, secret_id: secret },
  });
}

describe("the AppRole user lockout", () => {
  it("twenty wrong secret ids for a role, then the right one: the login succeeds at once", async () => {
    for (let i = 0; i < 20; i += 1) {
      const wrong = await login(randomBytes(16).toString("hex"));
      expect(wrong.status).toBeGreaterThanOrEqual(400);
      await wrong.body?.cancel();
    }
    const right = await login(secretId);
    expect(right.status).toBe(200);
    const body = (await right.json()) as { auth?: { client_token?: string } };
    expect(typeof body.auth?.client_token).toBe("string");
  });
});
