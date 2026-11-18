// Run 4.2 Task A (P-62, D-17, D-34): the API's OpenBao identity is `runtime`
// with inline AppRole authentication on every request — no login token is
// ever stored. Also the metadata the protocol reads (version times, the
// oldest kept version) and two provider facts the plan took from the source:
// a write whose cas equals a soft-deleted current version succeeds, and cas 0
// fails for a path whose only version is deleted.
import { randomUUID } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issuerBaoFromDirectory, runtimeBaoFromDirectory } from "@mykey/api";
import type { OrganizationId } from "@mykey/contracts";
import { OpenBaoClient, secretPath, type Correlation, type SecretEnvelope } from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { createOrgFixture, type OrgFixture } from "../../harness/org-fixture.ts";
import { getSharedStack, type Stack } from "../../harness/stack.ts";

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

const correlation = (): Correlation => ({ operationId: randomUUID(), dispatchId: randomUUID() });
const envelope = (operationId: string): SecretEnvelope => ({
  value: `synthetic-${randomUUID()}`,
  operation_id: operationId,
  format: 1,
});

function freshPath(): string {
  const name = `S_${randomUUID().replace(/-/g, "").toUpperCase()}`;
  return secretPath(org.projectId, org.environments[0]!.id, name);
}

async function inlineClient(secretId?: string): Promise<OpenBaoClient> {
  const credential = await org.credential("runtime");
  return new OpenBaoClient(stack.bao, {
    namespace: org.namespace,
    auth: { inline: { roleId: credential.roleId, secretId: secretId ?? credential.secretId } },
  });
}

describe("inline AppRole authentication", () => {
  it("an inline client writes, reads, lists and soft-deletes", async () => {
    const client = await inlineClient();
    const path = freshPath();
    const c = correlation();
    const written = envelope(c.operationId);
    expect(await client.kvWrite(path, written, 0, c)).toMatchObject({
      ok: true,
      data: { version: 1 },
    });
    const read = await client.kvRead(path);
    expect(read.ok && read.data.envelope.operation_id === c.operationId).toBe(true);
    expect(read.ok && read.data.envelope.value === written.value).toBe(true);
    const listed = await client.kvList(`p/${org.projectId}/e/${org.environments[0]!.id}/`);
    expect(listed.ok && listed.data.names.includes(path.split("/").at(-1)!)).toBe(true);
    expect(await client.kvSoftDelete(path, 1, correlation())).toMatchObject({ ok: true });
    const metadata = await client.kvMetadata(path);
    expect(metadata.ok && metadata.data.versions["1"]?.deleted).toBe(true);
  });

  it("five inline calls add no accessor to the namespace", async () => {
    const client = await inlineClient();
    const path = freshPath();
    const before = new Set(await admin.listAccessors(org.namespace));
    await client.kvWrite(path, envelope(randomUUID()), 0, correlation());
    for (let i = 0; i < 4; i += 1) expect((await client.kvRead(path)).ok).toBe(true);
    const after = await admin.listAccessors(org.namespace);
    expect(after.filter((accessor) => !before.has(accessor))).toEqual([]);
  });

  // Observed on OpenBao 2.7.2 (Run 4.2): a failed inline login answers 400, not the
  // 403 the plan expected; the client maps it to `invalid` with that status.
  it("a wrong secret id is refused, 400 invalid; an inline client cannot lookup-self (403)", async () => {
    const wrong = await inlineClient(randomUUID());
    expect(await wrong.kvRead(freshPath())).toEqual({ ok: false, kind: "invalid", status: 400 });
    const client = await inlineClient();
    expect(await client.tokenLookupSelf()).toEqual({ ok: false, kind: "denied", status: 403 });
  });

  it("kvMetadata gives createdAt per version and oldestVersion", async () => {
    const client = await inlineClient();
    const path = freshPath();
    await client.kvWrite(path, envelope(randomUUID()), 0, correlation());
    await client.kvWrite(path, envelope(randomUUID()), 1, correlation());
    const metadata = await client.kvMetadata(path);
    expect(metadata.ok).toBe(true);
    if (!metadata.ok) return;
    expect(metadata.data.currentVersion).toBe(2);
    expect(metadata.data.oldestVersion).toBe(0);
    for (const version of ["1", "2"]) {
      expect(Number.isNaN(Date.parse(metadata.data.versions[version]!.createdAt))).toBe(false);
    }
  });

  it("after 21 writes oldestVersion is 2, twenty versions remain, and kvRead of version 1 is not_found", async () => {
    const client = await inlineClient();
    const path = freshPath();
    for (let cas = 0; cas < 21; cas += 1) {
      expect((await client.kvWrite(path, envelope(randomUUID()), cas, correlation())).ok).toBe(
        true,
      );
    }
    const metadata = await client.kvMetadata(path);
    expect(metadata.ok && metadata.data.oldestVersion).toBe(2);
    expect(metadata.ok && Object.keys(metadata.data.versions).length).toBe(20);
    expect(await client.kvRead(path, 1)).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("cas equal to a soft-deleted current version succeeds; cas 0 on a path whose only version is deleted is a cas_mismatch", async () => {
    const client = await inlineClient();
    const path = freshPath();
    await client.kvWrite(path, envelope(randomUUID()), 0, correlation());
    await client.kvSoftDelete(path, 1, correlation());
    expect(await client.kvWrite(path, envelope(randomUUID()), 0, correlation())).toEqual({
      ok: false,
      kind: "cas_mismatch",
      status: 400,
    });
    expect(await client.kvWrite(path, envelope(randomUUID()), 1, correlation())).toMatchObject({
      ok: true,
      data: { version: 2 },
    });
  });
});

describe("runtimeBaoFromDirectory", () => {
  it("answers null while a file is missing and a client once all three exist; another organization is null", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mykey-runtime-"));
    try {
      const runtime = runtimeBaoFromDirectory(stack.bao, directory);
      expect(runtime.clientFor(org.organizationId)).toBeNull();
      const credential = await org.credential("runtime");
      writeFileSync(join(directory, "organization-id"), org.organizationId);
      writeFileSync(join(directory, "runtime-role-id"), credential.roleId);
      expect(runtime.clientFor(org.organizationId)).toBeNull();
      writeFileSync(join(directory, "runtime-secret-id"), credential.secretId);
      const client = runtime.clientFor(org.organizationId);
      expect(client).not.toBeNull();
      const path = freshPath();
      expect((await client!.kvWrite(path, envelope(randomUUID()), 0, correlation())).ok).toBe(true);
      expect(runtime.clientFor(randomUUID() as OrganizationId)).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// Run 6.9 (staging): provision-organization rotates every secret id — the new
// one delivered first, then the others destroyed — so that a running process
// always holds a working one. The API kept the first one it read, failed with
// it after the rotation, and its failed logins locked the runtime role out.
describe("a rotated secret id (Run 6.9)", () => {
  /** As the host delivers: a new file renamed over the old one. */
  function deliver(directory: string, name: string, value: string): void {
    writeFileSync(join(directory, `.${name}.tmp`), value);
    renameSync(join(directory, `.${name}.tmp`), join(directory, name));
  }

  /** As the reconcile does: a new secret id delivered, then every other destroyed. */
  async function rotate(directory: string, identity: "runtime" | "issuer"): Promise<void> {
    const fresh = await admin.newSecretId(org.namespace, identity);
    deliver(directory, `${identity}-secret-id`, fresh.secretId);
    for (const accessor of await admin.listSecretIdAccessors(org.namespace, identity)) {
      if (accessor !== fresh.accessor) {
        await admin.destroySecretIdAccessor(org.namespace, identity, accessor);
      }
    }
  }

  it("the next runtime call and the next issuer session use the delivered one, without a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mykey-rotate-"));
    try {
      deliver(directory, "organization-id", org.organizationId);
      for (const identity of ["runtime", "issuer"] as const) {
        const credential = await org.credential(identity);
        deliver(directory, `${identity}-role-id`, credential.roleId);
        deliver(directory, `${identity}-secret-id`, credential.secretId);
      }
      const runtime = runtimeBaoFromDirectory(stack.bao, directory);
      const issuer = issuerBaoFromDirectory(stack.bao, directory);
      const path = freshPath();
      expect(
        (
          await runtime
            .clientFor(org.organizationId)!
            .kvWrite(path, envelope(randomUUID()), 0, correlation())
        ).ok,
      ).toBe(true);
      const first = await issuer.open(org.organizationId);
      expect(first?.ok).toBe(true);
      if (first?.ok === true) await first.data.close();

      await rotate(directory, "runtime");
      await rotate(directory, "issuer");

      const read = await runtime.clientFor(org.organizationId)!.kvRead(path);
      expect(read.ok, read.ok ? "" : `runtime after rotation: ${read.kind}`).toBe(true);
      const second = await issuer.open(org.organizationId);
      expect(second?.ok, "issuer after rotation").toBe(true);
      if (second?.ok === true) await second.data.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
