// Audit evidence (Run 2.1 Task B): the file audit device records every request
// and response with the two correlation headers in clear, and never the value
// or the client token. Nothing read from the audit file is printed.
import { randomBytes, randomUUID } from "node:crypto";
import { OpenBaoClient, secretPath, type Correlation, type SecretEnvelope } from "@mykey/openbao";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrgFixture, type OrgFixture } from "../../harness/org-fixture.ts";
import {
  baoFetch,
  getSharedStack,
  readAuditLog,
  type AuditEntry,
  type Stack,
} from "../../harness/stack.ts";

let stack: Stack;
let org: OrgFixture;

beforeAll(async () => {
  stack = await getSharedStack();
  org = await createOrgFixture(stack);
});

afterAll(async () => {
  await (org as OrgFixture | undefined)?.drop();
});

function correlation(): Correlation {
  return { operationId: randomUUID(), dispatchId: randomUUID() };
}

/** Assembled at run time; never written literally in the repository. */
function canary(): string {
  return ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
}

function freshPath(environment = 0): string {
  const name = `A_${randomUUID().replace(/-/g, "").toUpperCase()}`;
  return secretPath(org.projectId, org.environments[environment]!.id, name);
}

function ofDispatch(entries: AuditEntry[], dispatchId: string): AuditEntry[] {
  return entries.filter((entry) => entry.headers["x-mykey-dispatch-id"]?.[0] === dispatchId);
}

/** A machine token of environment 0, minted with the root token (Run 2.2 owns issuance). */
async function machineToken(): Promise<string> {
  const name = org.environments[0]!.machineName;
  const created = await baoFetch(stack, `/v1/auth/token/create/${name}`, {
    method: "POST",
    namespace: org.namespace,
    body: { ttl: "300s", policies: [name], no_default_policy: true },
  });
  expect(created.status).toBe(200);
  return ((await created.json()) as { auth: { client_token: string } }).auth.client_token;
}

describe("OpenBao audit device", () => {
  it("records one request and one response per dispatch, with both headers in clear", async () => {
    const token = await org.login("runtime");
    const client = new OpenBaoClient(stack.bao, { namespace: org.namespace, token });
    const value = canary();
    const c = correlation();
    const path = freshPath();
    const envelope: SecretEnvelope = { value, operation_id: c.operationId, format: 1 };
    expect(await client.kvWrite(path, envelope, 0, c)).toMatchObject({ ok: true, status: 200 });

    const entries = await readAuditLog(stack);
    const mine = ofDispatch(entries, c.dispatchId);
    expect(mine.map((entry) => entry.type)).toEqual(["request", "response"]);
    for (const entry of mine) {
      expect(entry.namespacePath).toBe(`${org.namespace}/`);
      expect(entry.path).toBe(`kv/data/${path}`);
      expect(entry.headers["x-mykey-operation-id"]).toEqual([c.operationId]);
      expect(entry.headers["x-mykey-dispatch-id"]).toEqual([c.dispatchId]);
    }

    // The value and the token never reach the file: OpenBao stores HMACs.
    const raw = entries.map((entry) => entry.raw).join("\n");
    expect(raw.includes(value)).toBe(false);
    expect(raw.includes(token)).toBe(false);
    // Control: the search does find what the file does hold in clear.
    expect(raw.includes(c.dispatchId)).toBe(true);
    expect(raw.includes(org.namespace)).toBe(true);
  });

  it("records a denied request too", async () => {
    const token = await machineToken();
    const machine = new OpenBaoClient(stack.bao, { namespace: org.namespace, token });
    const c = correlation();
    const path = freshPath();
    const envelope: SecretEnvelope = { value: canary(), operation_id: c.operationId, format: 1 };
    expect(await machine.kvWrite(path, envelope, 0, c)).toEqual({
      ok: false,
      kind: "denied",
      status: 403,
    });

    const entries = await readAuditLog(stack);
    const mine = ofDispatch(entries, c.dispatchId);
    expect(mine.map((entry) => entry.type)).toEqual(["request", "response"]);
    expect(mine[1]!.raw).toContain("permission denied");
    expect(mine[0]!.headers["x-mykey-operation-id"]).toEqual([c.operationId]);
    expect(
      entries
        .map((entry) => entry.raw)
        .join("\n")
        .includes(token),
    ).toBe(false);

    // Control: the same write by the runtime identity is allowed and audited as such.
    const runtime = new OpenBaoClient(stack.bao, {
      namespace: org.namespace,
      token: await org.login("runtime"),
    });
    const allowed = correlation();
    expect(
      await runtime.kvWrite(path, { ...envelope, operation_id: allowed.operationId }, 0, allowed),
    ).toMatchObject({ ok: true, status: 200 });
    const control = ofDispatch(await readAuditLog(stack), allowed.dispatchId);
    expect(control.map((entry) => entry.type)).toEqual(["request", "response"]);
    expect(control[1]!.raw).not.toContain("permission denied");
  });

  it("a caller of the product client cannot set the correlation headers", async () => {
    const client = new OpenBaoClient(stack.bao, {
      namespace: org.namespace,
      token: await org.login("runtime"),
    });
    const path = freshPath();
    const c = correlation();
    const envelope: SecretEnvelope = { value: "synthetic-audit", operation_id: "evil", format: 1 };

    // A header smuggled through a correlation id is refused before any request.
    const smuggled: Correlation = {
      operationId: `${c.operationId}\r\nX-MyKey-Operation-Id: evil`,
      dispatchId: c.dispatchId,
    };
    await expect(client.kvWrite(path, envelope, 0, smuggled)).rejects.toThrow(
      "invalid correlation",
    );
    await expect(
      client.kvWrite(path, envelope, 0, { operationId: "evil", dispatchId: "a b" }),
    ).rejects.toThrow("invalid correlation");
    expect(ofDispatch(await readAuditLog(stack), c.dispatchId)).toEqual([]);

    // The headers the server records are exactly the Correlation passed, one value
    // each, whatever the envelope says.
    expect(await client.kvWrite(path, envelope, 0, c)).toMatchObject({ ok: true });
    const mine = ofDispatch(await readAuditLog(stack), c.dispatchId);
    expect(mine).toHaveLength(2);
    for (const entry of mine) {
      expect(entry.headers["x-mykey-operation-id"]).toEqual([c.operationId]);
      expect(entry.headers["x-mykey-dispatch-id"]).toEqual([c.dispatchId]);
    }
  });
});
