// Run 3.8: the API's start-up self-check logs in with the delivered runtime
// credential and revokes the token; it reports absent, refused or unreachable
// otherwise and never fails the start.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimeSelfCheck } from "@mykey/api";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { createOrgFixture, type OrgFixture } from "../../harness/org-fixture.ts";
import { getSharedStack, type Stack } from "../../harness/stack.ts";

let stack: Stack;
let org: OrgFixture;
let directory: string;

beforeAll(async () => {
  stack = await getSharedStack();
  org = await createOrgFixture(stack);
  directory = mkdtempSync(join(tmpdir(), "mykey-selfcheck-"));
});

afterAll(async () => {
  rmSync(directory, { recursive: true, force: true });
  await (org as OrgFixture | undefined)?.drop();
});

async function deliver(secretId?: string): Promise<void> {
  const admin = new OpenBaoAdmin(stack.bao, stack.bao.rootToken);
  const { roleId } = await admin.readRoleId(org.namespace, "runtime");
  writeFileSync(join(directory, "organization-id"), org.organizationId);
  writeFileSync(join(directory, "runtime-role-id"), roleId);
  writeFileSync(
    join(directory, "runtime-secret-id"),
    secretId ?? (await admin.newSecretId(org.namespace, "runtime")).secretId,
  );
}

describe("runtime self-check", () => {
  it("no credential files: absent; no OpenBao configured: absent", async () => {
    expect(await runtimeSelfCheck(stack.bao, directory)).toBe("absent");
    expect(await runtimeSelfCheck(undefined, directory)).toBe("absent");
  });

  it("the delivered credential: ok", async () => {
    await deliver();
    expect(await runtimeSelfCheck(stack.bao, directory)).toBe("ok");
  });

  it("a wrong secret id: refused; OpenBao away: unreachable", async () => {
    await deliver("00000000-0000-4000-8000-000000000000");
    expect(await runtimeSelfCheck(stack.bao, directory)).toBe("refused");
    expect(
      await runtimeSelfCheck(
        { url: "https://127.0.0.1:9", caCertPath: stack.bao.caCertPath },
        directory,
      ),
    ).toBe("unreachable");
  });
});
