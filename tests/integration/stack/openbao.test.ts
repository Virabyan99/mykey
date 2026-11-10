import http from "node:http";
import { beforeAll, describe, expect, it } from "vitest";
import {
  baoFetch,
  freshNamespace,
  getSharedStack,
  mountKvV2,
  type Stack,
} from "../../harness/stack.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await getSharedStack();
});

interface KvRead {
  data: { data: { value: string }; metadata: { version: number } };
}

async function mountKv(namespace: string): Promise<void> {
  await mountKvV2(stack, namespace);
  const config = await baoFetch(stack, "/v1/kv/config", {
    method: "POST",
    namespace,
    body: { cas_required: true, max_versions: 20 },
  });
  expect(config.status).toBe(204);
  const readBack = await baoFetch(stack, "/v1/kv/config", { namespace });
  const body = (await readBack.json()) as { data: { cas_required: boolean; max_versions: number } };
  expect(body.data).toMatchObject({ cas_required: true, max_versions: 20 });
}

describe("local OpenBao", () => {
  it("status is initialised, unsealed, raft, static seal", async () => {
    const response = await baoFetch(stack, "/v1/sys/seal-status");
    expect(response.status).toBe(200);
    const status = (await response.json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      initialized: true,
      sealed: false,
      storage_type: "raft",
      type: "static",
    });
  });

  it("namespace + KV v2 round trip, and the same path in a second namespace is absent", async () => {
    const first = await freshNamespace(stack);
    const second = await freshNamespace(stack);
    try {
      await mountKv(first.path);
      await mountKv(second.path);

      const write = await baoFetch(stack, "/v1/kv/data/SMOKE", {
        method: "POST",
        namespace: first.path,
        body: { options: { cas: 0 }, data: { value: "synthetic-1" } },
      });
      expect(write.status).toBe(200);

      const read = await baoFetch(stack, "/v1/kv/data/SMOKE", { namespace: first.path });
      expect(read.status).toBe(200);
      const body = (await read.json()) as KvRead;
      expect(body.data.metadata.version).toBe(1);
      expect(body.data.data.value).toBe("synthetic-1");

      const elsewhere = await baoFetch(stack, "/v1/kv/data/SMOKE", { namespace: second.path });
      expect(elsewhere.status).toBe(404);

      const root = await baoFetch(stack, "/v1/kv/data/SMOKE");
      expect(root.status).toBe(404);
    } finally {
      await first.drop();
      await second.drop();
    }
  });

  it("a write without cas is rejected, and so is a write with a stale cas", async () => {
    const namespace = await freshNamespace(stack);
    try {
      await mountKv(namespace.path);
      const noCas = await baoFetch(stack, "/v1/kv/data/SMOKE", {
        method: "POST",
        namespace: namespace.path,
        body: { data: { value: "synthetic-2" } },
      });
      expect(noCas.status).toBe(400);

      const create = await baoFetch(stack, "/v1/kv/data/SMOKE", {
        method: "POST",
        namespace: namespace.path,
        body: { options: { cas: 0 }, data: { value: "synthetic-3" } },
      });
      expect(create.status).toBe(200);

      const stale = await baoFetch(stack, "/v1/kv/data/SMOKE", {
        method: "POST",
        namespace: namespace.path,
        body: { options: { cas: 0 }, data: { value: "synthetic-4" } },
      });
      expect(stale.status).toBe(400);

      const read = await baoFetch(stack, "/v1/kv/data/SMOKE", { namespace: namespace.path });
      expect(((await read.json()) as KvRead).data.data.value).toBe("synthetic-3");
    } finally {
      await namespace.drop();
    }
  });

  it("a dropped namespace is gone", async () => {
    const namespace = await freshNamespace(stack);
    await namespace.drop();
    const lookup = await baoFetch(stack, `/v1/sys/namespaces/${namespace.path}`);
    expect(lookup.status).toBe(404);
  });

  it("a request without a token is denied", async () => {
    const response = await baoFetch(stack, "/v1/sys/mounts", { token: "" });
    expect([400, 403]).toContain(response.status);
  });

  it("plain HTTP is refused", async () => {
    const url = new URL(stack.bao.url);
    const outcome = await new Promise<{ status?: number; body: string; error?: string }>(
      (resolve) => {
        const request = http.request(
          { host: url.hostname, port: url.port, path: "/v1/sys/seal-status", method: "GET" },
          (response) => {
            let body = "";
            response.on("data", (chunk: Buffer) => (body += chunk.toString()));
            response.on("end", () => {
              resolve({ status: response.statusCode ?? 0, body });
            });
          },
        );
        request.on("error", (error) => {
          resolve({ body: "", error: error.message });
        });
        request.end();
      },
    );
    // A TLS listener either drops a plaintext client or answers 400; it never serves the API.
    if (outcome.error === undefined) {
      expect(outcome.status).toBe(400);
      expect(outcome.body).toMatch(/HTTPS/i);
    }
    expect(outcome.body).not.toContain("initialized");
  });
});
