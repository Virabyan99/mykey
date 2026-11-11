// Run 2.4 (carried from Run 2.1, ruling R8): how the client reports answers
// that do not say whether a change was applied. Doc 10 §4.1 rule 3: a
// possibly-applied effect is never reported as a failure.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { OpenBaoClient, secretPath, type Correlation, type SecretEnvelope } from "@mykey/openbao";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrgFixture, type OrgFixture } from "../../harness/org-fixture.ts";
import { getSharedStack, type Stack } from "../../harness/stack.ts";
import { startTlsRelay } from "../../harness/tls-relay.ts";

let stack: Stack;
let org: OrgFixture;

beforeAll(async () => {
  stack = await getSharedStack();
  org = await createOrgFixture(stack);
});

afterAll(async () => {
  await (org as OrgFixture | undefined)?.drop();
});

const correlation = (): Correlation => ({ operationId: randomUUID(), dispatchId: randomUUID() });
const envelope = (value: string, operationId: string): SecretEnvelope => ({
  value,
  operation_id: operationId,
  format: 1,
});
const freshPath = (): string =>
  secretPath(
    org.projectId,
    org.environments[0]!.id,
    `S_${randomUUID().replace(/-/g, "").toUpperCase()}`,
  );

async function runtimeClient(url = stack.bao.url, deadlineMs?: number): Promise<OpenBaoClient> {
  return new OpenBaoClient(
    { url, caCertPath: stack.bao.caCertPath },
    {
      namespace: org.namespace,
      token: await org.login("runtime"),
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    },
  );
}

describe("after the handshake", () => {
  it("a connection that breaks once the request has left is unknown/connection_lost — and it was applied", async () => {
    const bao = new URL(stack.bao.url);
    const relay = await startTlsRelay({ host: bao.hostname, port: Number(bao.port) }, "drop");
    try {
      const client = await runtimeClient(`https://127.0.0.1:${relay.port}`);
      const c = correlation();
      const path = freshPath();
      const result = await client.kvWrite(path, envelope("synthetic-lost", c.operationId), 0, c);
      expect(result).toEqual({ ok: false, kind: "unknown", cause: "connection_lost" });
      await relay.requestForwarded;
      // Why it must not be called a failure: the server did apply it.
      const read = await (await runtimeClient()).kvRead(path);
      expect(read).toMatchObject({ ok: true, data: { version: 1 } });
      if (read.ok) expect(read.data.envelope.operation_id).toBe(c.operationId);
    } finally {
      await relay.close();
    }
  });

  it("a deadline that expires after the handshake is unknown/timeout", async () => {
    const bao = new URL(stack.bao.url);
    const relay = await startTlsRelay({ host: bao.hostname, port: Number(bao.port) }, "hold");
    try {
      const client = await runtimeClient(`https://127.0.0.1:${relay.port}`, 1_500);
      const c = correlation();
      const started = Date.now();
      const result = await client.kvWrite(
        freshPath(),
        envelope("synthetic-held", c.operationId),
        0,
        c,
      );
      expect(result).toEqual({ ok: false, kind: "unknown", cause: "timeout" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
      // The request had passed the handshake before the deadline.
      await relay.requestForwarded;
    } finally {
      await relay.close();
    }
  });
});

describe("concurrent changes on the real server", () => {
  it("thirty writes to one new key: one is applied, the rest are a definite cas_mismatch", async () => {
    // Run 2.1 saw 500 "transaction commit failed" for concurrent writes of
    // `kv/config`. The data path does not answer 500: check-and-set decides
    // (observed in Run 2.4, also for concurrent soft deletes and undeletes).
    const client = await runtimeClient();
    const path = freshPath();
    const attempts = Array.from({ length: 30 }, () => correlation());
    const results = await Promise.all(
      attempts.map((c, index) =>
        client.kvWrite(path, envelope(`synthetic-${index}`, c.operationId), 0, c),
      ),
    );
    const kinds = results.map((result) =>
      result.ok ? "ok" : result.kind === "unknown" ? `unknown/${result.cause}` : result.kind,
    );
    expect(kinds.filter((kind) => kind === "ok")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "cas_mismatch")).toHaveLength(29);
    // The version that exists belongs to the one write answered `ok`.
    const read = await client.kvRead(path);
    expect(read.ok).toBe(true);
    const winner = attempts[results.findIndex((result) => result.ok)];
    if (read.ok) {
      expect(read.data.version).toBe(1);
      expect(read.data.envelope.operation_id).toBe(winner?.operationId);
    }
  });
});

describe("answers the server cannot be made to give", () => {
  // A TLS server with the stack's certificate. It stands in for OpenBao only to
  // send an answer the real server does not send on demand; no store is involved.
  let status = 200;
  let body = "";
  let server: https.Server;
  let url = "";

  beforeAll(async () => {
    server = https.createServer(
      { cert: readFileSync(stack.api.certPath), key: readFileSync(stack.api.keyPath) },
      (request, response) => {
        request.resume();
        request.on("end", () => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(body);
        });
      },
    );
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  const answering = (nextStatus: number, nextBody: string): OpenBaoClient => {
    status = nextStatus;
    body = nextBody;
    return new OpenBaoClient(
      { url, caCertPath: stack.api.certAuthorityPath },
      { namespace: org.namespace, token: "synthetic-token" },
    );
  };
  const unclear = { ok: false, kind: "unknown", cause: "unclear_answer" };

  it("a 2xx whose body cannot be read is unclear for a change and invalid for a read", async () => {
    const c = correlation();
    const client = answering(200, "{not json");
    expect(await client.kvWrite(freshPath(), envelope("x-synthetic", c.operationId), 0, c)).toEqual(
      unclear,
    );
    expect(await client.tokenCreateFromRole(org.environments[0]!.machineName, 60, c)).toEqual(
      unclear,
    );
    expect(await client.kvRead(freshPath())).toEqual({ ok: false, kind: "invalid", status: 200 });
  });

  it("a 5xx other than 503 is unclear for every change and invalid for a read", async () => {
    const c = correlation();
    for (const code of [500, 502, 504]) {
      const client = answering(code, '{"errors":["synthetic"]}');
      expect(await client.kvSoftDelete(freshPath(), 1, c), String(code)).toEqual(unclear);
      expect(await client.kvUndelete(freshPath(), 1, c), String(code)).toEqual(unclear);
      expect(await client.tokenRevokeAccessor("synthetic-accessor", c), String(code)).toEqual(
        unclear,
      );
      expect(await client.kvRead(freshPath()), String(code)).toEqual({
        ok: false,
        kind: "invalid",
        status: code,
      });
    }
  });

  it("a 503 stays sealed, and a definite refusal stays definite (controls)", async () => {
    const c = correlation();
    let client = answering(503, '{"errors":["Vault is sealed"]}');
    expect(await client.kvWrite(freshPath(), envelope("x-synthetic", c.operationId), 0, c)).toEqual(
      {
        ok: false,
        kind: "sealed",
        status: 503,
      },
    );
    client = answering(
      400,
      '{"errors":["check-and-set parameter did not match the current version"]}',
    );
    expect(await client.kvWrite(freshPath(), envelope("x-synthetic", c.operationId), 0, c)).toEqual(
      {
        ok: false,
        kind: "cas_mismatch",
        status: 400,
      },
    );
    client = answering(403, '{"errors":["permission denied"]}');
    expect(await client.kvSoftDelete(freshPath(), 1, c)).toEqual({
      ok: false,
      kind: "denied",
      status: 403,
    });
  });
});
