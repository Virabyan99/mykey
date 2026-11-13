import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import {
  OpenBaoClient,
  machineTokenRole,
  renderMachinePolicy,
  renderPolicy,
  secretPath,
  type Correlation,
  type SecretEnvelope,
} from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrgFixture, type OrgFixture } from "../../harness/org-fixture.ts";
import { baoFetch, getSharedStack, readAuditLog, type Stack } from "../../harness/stack.ts";

let stack: Stack;
let org: OrgFixture;
let admin: OpenBaoAdmin;

beforeAll(async () => {
  stack = await getSharedStack();
  org = await createOrgFixture(stack);
  admin = new OpenBaoAdmin(stack.bao, stack.bao.rootToken);
});

afterAll(async () => {
  // `org` is unset when beforeAll failed; that failure is the one to report.
  await (org as OrgFixture | undefined)?.drop();
});

function correlation(): Correlation {
  return { operationId: randomUUID(), dispatchId: randomUUID() };
}

function envelope(value: string, operationId: string): SecretEnvelope {
  return { value, operation_id: operationId, format: 1 };
}

async function runtimeClient(opts: { deadlineMs?: number } = {}): Promise<OpenBaoClient> {
  return new OpenBaoClient(stack.bao, {
    namespace: org.namespace,
    token: await org.login("runtime"),
    ...opts,
  });
}

/** A path no other test in this file uses. */
function freshPath(environment = 0): string {
  const name = `S_${randomUUID().replace(/-/g, "").toUpperCase()}`;
  return secretPath(org.projectId, org.environments[environment]!.id, name);
}

describe("OpenBao client against the real server", () => {
  it("fixture reads back what it wrote", async () => {
    for (const kind of ["runtime", "issuer", "provisioner"] as const) {
      expect(await admin.readPolicy(org.namespace, kind), kind).toBe(renderPolicy(kind));
    }
    expect(org.environments).toHaveLength(2);
    for (const environment of org.environments) {
      expect(await admin.readPolicy(org.namespace, environment.machineName)).toBe(
        renderMachinePolicy(org.projectId, environment.id),
      );
      // OpenBao 2.7.2 applies token_num_uses but leaves a 0 out of a role read …
      const { token_num_uses: numUses, ...readable } = machineTokenRole(environment.id);
      expect(await admin.readTokenRole(org.namespace, environment.machineName)).toEqual(readable);
      // … so its effect is checked instead: a token minted from the role has that many uses.
      const created = await baoFetch(stack, `/v1/auth/token/create/${environment.machineName}`, {
        method: "POST",
        namespace: org.namespace,
        body: { ttl: "60s", policies: [environment.machineName], no_default_policy: true },
      });
      expect(created.status).toBe(200);
      const { accessor } = ((await created.json()) as { auth: { accessor: string } }).auth;
      const lookup = await baoFetch(stack, "/v1/auth/token/lookup-accessor", {
        method: "POST",
        namespace: org.namespace,
        body: { accessor },
      });
      expect(((await lookup.json()) as { data: { num_uses: number } }).data.num_uses).toBe(numUses);
      const revoked = await baoFetch(stack, "/v1/auth/token/revoke-accessor", {
        method: "POST",
        namespace: org.namespace,
        body: { accessor },
      });
      expect(revoked.status).toBe(204);
    }
    // Control for the two reads above: a name that was never written reads as null.
    expect(await admin.readPolicy(org.namespace, "machine-env-absent")).toBeNull();
    expect(await admin.readTokenRole(org.namespace, "machine-env-absent")).toBeNull();

    const config = await baoFetch(stack, "/v1/kv/config", { namespace: org.namespace });
    expect(config.status).toBe(200);
    const body = (await config.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ cas_required: true, max_versions: 20 });
  });

  it("runtime writes and reads an envelope", async () => {
    const client = await runtimeClient();
    const path = freshPath();
    const c = correlation();
    const written = envelope("synthetic-1", c.operationId);

    expect(await client.kvWrite(path, written, 0, c)).toEqual({
      ok: true,
      status: 200,
      data: { version: 1 },
    });
    expect(await client.kvRead(path)).toEqual({
      ok: true,
      status: 200,
      data: { envelope: written, version: 1 },
    });
  });

  it("a stale cas is a cas_mismatch, not an error", async () => {
    const client = await runtimeClient();
    const path = freshPath();
    const first = correlation();
    const firstWrite = await client.kvWrite(
      path,
      envelope("synthetic-2", first.operationId),
      0,
      first,
    );
    expect(firstWrite).toMatchObject({ ok: true, data: { version: 1 } });

    const second = correlation();
    expect(
      await client.kvWrite(path, envelope("synthetic-3", second.operationId), 0, second),
    ).toEqual({ ok: false, kind: "cas_mismatch", status: 400 });
    // Control: the same write with the current version succeeds.
    expect(
      await client.kvWrite(path, envelope("synthetic-3", second.operationId), 1, second),
    ).toEqual({ ok: true, status: 200, data: { version: 2 } });
  });

  it("soft delete and undelete name their version", async () => {
    const client = await runtimeClient();
    const path = freshPath();
    const c = correlation();
    const written = envelope("synthetic-4", c.operationId);
    expect(await client.kvWrite(path, written, 0, c)).toMatchObject({ ok: true });

    expect(await client.kvSoftDelete(path, 1, correlation())).toEqual({
      ok: true,
      status: 204,
      data: null,
    });
    expect(await client.kvRead(path)).toEqual({ ok: false, kind: "not_found", status: 404 });
    const deleted = await client.kvMetadata(path);
    expect(deleted).toMatchObject({
      ok: true,
      data: { currentVersion: 1, versions: { "1": { deleted: true, destroyed: false } } },
    });

    expect(await client.kvUndelete(path, 1, correlation())).toEqual({
      ok: true,
      status: 204,
      data: null,
    });
    expect(await client.kvRead(path, 1)).toEqual({
      ok: true,
      status: 200,
      data: { envelope: written, version: 1 },
    });
    expect(await client.kvMetadata(path)).toMatchObject({
      ok: true,
      data: { currentVersion: 1, versions: { "1": { deleted: false, destroyed: false } } },
    });
  });

  it("a soft delete of an already deleted version and an undelete of a live one answer ok (Run 4.4)", async () => {
    const client = await runtimeClient();
    const path = freshPath();
    const c = correlation();
    expect(await client.kvWrite(path, envelope("synthetic-4b", c.operationId), 0, c)).toMatchObject(
      {
        ok: true,
      },
    );
    // An undelete of a live version changes nothing and is not an error.
    expect(await client.kvUndelete(path, 1, correlation())).toMatchObject({
      ok: true,
      status: 204,
    });
    expect(await client.kvSoftDelete(path, 1, correlation())).toMatchObject({
      ok: true,
      status: 204,
    });
    // A second soft delete of the same version: also ok — the backend cannot tell who deleted it.
    expect(await client.kvSoftDelete(path, 1, correlation())).toMatchObject({
      ok: true,
      status: 204,
    });
    expect(await client.kvMetadata(path)).toMatchObject({
      ok: true,
      data: { currentVersion: 1, versions: { "1": { deleted: true, destroyed: false } } },
    });
  });

  it("kvList names what an environment holds", async () => {
    const client = await runtimeClient();
    const path = freshPath(1);
    const c = correlation();
    expect(await client.kvWrite(path, envelope("synthetic-5", c.operationId), 0, c)).toMatchObject({
      ok: true,
    });
    const listed = await client.kvList(path.slice(0, path.lastIndexOf("/") + 1));
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data.names).toContain(path.slice(path.lastIndexOf("/") + 1));
  });

  it("a deadline is unknown, never a failure", async () => {
    const client = await runtimeClient({ deadlineMs: 1 });
    const c = correlation();
    expect(await client.kvWrite(freshPath(), envelope("synthetic-6", c.operationId), 0, c)).toEqual(
      {
        ok: false,
        kind: "unknown",
        cause: "timeout",
      },
    );
    expect(await client.kvRead(freshPath())).toEqual({
      ok: false,
      kind: "unknown",
      cause: "timeout",
    });
  });

  it("a refused connection and an unknown certificate authority are invalid, status 0", async () => {
    const token = await org.login("runtime");
    const closed = new OpenBaoClient(
      { url: "https://127.0.0.1:1", caCertPath: stack.bao.caCertPath },
      { namespace: org.namespace, token },
    );
    expect(await closed.kvRead(freshPath())).toEqual({ ok: false, kind: "invalid", status: 0 });

    // A real public root certificate that did not sign the stack's server certificate.
    const directory = mkdtempSync(join(tmpdir(), "mykey-ca-"));
    try {
      const otherCa = join(directory, "other-ca.crt");
      writeFileSync(otherCa, rootCertificates[0]!);
      const wrongCa = new OpenBaoClient(
        { url: stack.bao.url, caCertPath: otherCa },
        { namespace: org.namespace, token },
      );
      expect(await wrongCa.kvRead(freshPath())).toEqual({ ok: false, kind: "invalid", status: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    // Control: the same read through the stack's CA reaches the server.
    const control = new OpenBaoClient(stack.bao, { namespace: org.namespace, token });
    expect(await control.kvRead(freshPath())).toEqual({
      ok: false,
      kind: "not_found",
      status: 404,
    });
  });

  it("no automatic retry", async () => {
    const client = await runtimeClient();
    const c = correlation();
    const path = freshPath();
    expect(await client.kvWrite(path, envelope("synthetic-7", c.operationId), 0, c)).toMatchObject({
      ok: true,
    });
    const entries = (await readAuditLog(stack)).filter(
      (entry) => entry.headers["x-mykey-dispatch-id"]?.[0] === c.dispatchId,
    );
    const requests = entries.filter((entry) => entry.type === "request");
    expect(requests).toHaveLength(1);
    // A write to a path that does not exist yet is recorded as `create`.
    expect(requests[0]).toMatchObject({
      namespacePath: `${org.namespace}/`,
      path: `kv/data/${path}`,
      operation: "create",
    });
    // Control: the filter sees the entries of this dispatch (one request, one response).
    expect(entries.map((entry) => entry.type)).toEqual(["request", "response"]);
  });

  it("a token without the capability is denied, 403", async () => {
    const name = org.environments[0]!.machineName;
    const created = await baoFetch(stack, `/v1/auth/token/create/${name}`, {
      method: "POST",
      namespace: org.namespace,
      body: { ttl: "120s", policies: [name], no_default_policy: true },
    });
    expect(created.status).toBe(200);
    const { client_token: token } = ((await created.json()) as { auth: { client_token: string } })
      .auth;
    const machine = new OpenBaoClient(stack.bao, { namespace: org.namespace, token });
    const path = freshPath();
    const c = correlation();
    expect(await machine.kvWrite(path, envelope("synthetic-9", c.operationId), 0, c)).toEqual({
      ok: false,
      kind: "denied",
      status: 403,
    });
    // Control: the runtime token's same call succeeds.
    const runtime = await runtimeClient();
    expect(await runtime.kvWrite(path, envelope("synthetic-9", c.operationId), 0, c)).toEqual({
      ok: true,
      status: 200,
      data: { version: 1 },
    });
  });

  it("a token role's token_num_uses reaches the token it mints", async () => {
    // A test-only role (not a machine-env role). A role read returns
    // token_num_uses only when it is not 0 (the machine roles hold 0, so their
    // read omits it); the minted token carries the value either way.
    const role = `test-num-uses-${randomUUID().slice(0, 8)}`;
    const policy = org.environments[0]!.machineName;
    const written = await baoFetch(stack, `/v1/auth/token/roles/${role}`, {
      method: "POST",
      namespace: org.namespace,
      body: {
        allowed_policies: [policy],
        orphan: true,
        token_no_default_policy: true,
        token_num_uses: 5,
      },
    });
    expect(written.status).toBe(204);
    try {
      const read = await baoFetch(stack, `/v1/auth/token/roles/${role}`, {
        namespace: org.namespace,
      });
      expect(read.status).toBe(200);
      const { data } = (await read.json()) as { data: Record<string, unknown> };
      expect(data.token_num_uses).toBe(5);
      const created = await baoFetch(stack, `/v1/auth/token/create/${role}`, {
        method: "POST",
        namespace: org.namespace,
        body: { ttl: "60s", policies: [policy], no_default_policy: true },
      });
      expect(created.status).toBe(200);
      const { accessor } = ((await created.json()) as { auth: { accessor: string } }).auth;
      const lookup = await baoFetch(stack, "/v1/auth/token/lookup-accessor", {
        method: "POST",
        namespace: org.namespace,
        body: { accessor },
      });
      expect(((await lookup.json()) as { data: { num_uses: number } }).data.num_uses).toBe(5);
      await baoFetch(stack, "/v1/auth/token/revoke-accessor", {
        method: "POST",
        namespace: org.namespace,
        body: { accessor },
      });
    } finally {
      const removed = await baoFetch(stack, `/v1/auth/token/roles/${role}`, {
        method: "DELETE",
        namespace: org.namespace,
      });
      expect(removed.status).toBe(204);
    }
    const gone = await baoFetch(stack, `/v1/auth/token/roles/${role}`, {
      namespace: org.namespace,
    });
    expect(gone.status).toBe(404);
  });

  it("AppRole tokens carry only their policy", async () => {
    const client = await runtimeClient();
    const self = await client.tokenLookupSelf();
    expect(self.ok).toBe(true);
    if (!self.ok) return;
    expect(self.data.policies).toEqual(["runtime"]);
    expect(self.data.policies).not.toContain("default");
    expect(self.data.ttlSeconds).toBeGreaterThan(0);
    expect(self.data.ttlSeconds).toBeLessThanOrEqual(900);
    expect(self.data.type).toBe("service");
    expect(self.data.namespacePath).toBe(`${org.namespace}/`);
  });

  it("a path or namespace that paths.ts did not build is refused before any request", async () => {
    const client = await runtimeClient();
    const c = correlation();
    const good = freshPath();
    for (const bad of [`${good}/../X`, "sys/policies/acl/runtime", `${good}?version=1`, ""]) {
      await expect(client.kvRead(bad), bad).rejects.toThrow("invalid secret path");
      await expect(
        client.kvWrite(bad, envelope("synthetic-8", c.operationId), 0, c),
        bad,
      ).rejects.toThrow("invalid secret path");
    }
    await expect(client.kvList("p/")).rejects.toThrow("invalid environment prefix");
    await expect(client.tokenCreateFromRole("runtime", 60, c)).rejects.toThrow(
      "invalid machine name",
    );
    expect(() => new OpenBaoClient(stack.bao, { namespace: "", token: "x" })).toThrow(
      "invalid namespace",
    );
    // Control: the path built by paths.ts is sent and answered.
    expect(await client.kvRead(good)).toEqual({ ok: false, kind: "not_found", status: 404 });
  });
});
