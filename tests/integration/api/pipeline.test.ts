// Run 3.1 Task C: the outer frame of the request pipeline — request id,
// no-store, body limits and parsing, strict validation, error mapping, output
// validation and the logger — through the real app over HTTPS.
import { randomBytes, randomUUID } from "node:crypto";
import https from "node:https";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAudit } from "@mykey/audit";
import { ApiError, type Handler } from "@mykey/api";
import { LIMITS, type RouteDef } from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import { z } from "zod";
import { errorOf, startTestApi, type TestApi } from "../../harness/api.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const echoBody = z.strictObject({
  mode: z.enum(["ok", "throw", "unlisted", "bad_output", "audit"]).optional(),
  text: z.string().optional(),
  nested: z.unknown().optional(),
  small: z.int().max(10).optional(),
});

const ECHO: RouteDef = {
  id: "test.echo",
  method: "POST",
  path: "/v1/_test/echo",
  auth: "public",
  idempotent: false,
  ownerRun: "test",
  pending: false,
  request: { body: echoBody },
  responses: { 200: z.strictObject({ ok: z.literal(true) }) },
  errors: ["malformed_request", "validation_failed", "audit_unavailable", "quarantined"],
  action: null,
  scope: "none",
};

let reached = 0;
const echo: Handler = async (ctx, deps) => {
  reached += 1;
  const body = ctx.body as z.infer<typeof echoBody>;
  switch (body.mode) {
    case "throw":
      throw new Error(body.text ?? "boom");
    case "unlisted":
      throw new ApiError("version_conflict");
    case "bad_output":
      return { status: 200, body: { ok: true, leaked: body.text } };
    case "audit": {
      const id = body.text ?? randomUUID();
      await withTransaction(deps.pool, async (tx) => {
        // An effect the API may write (since migration 0010 it creates no organization).
        await tx.query(
          "INSERT INTO app.rate_limit (scope, key_digest, window_start, count) VALUES ('test:audit', sha256(convert_to($1, 'UTF8')), now(), 1)",
          [id],
        );
        await appendAudit(tx, {
          // Run 6.1 (P-106): a global action, written without an organization.
          action: "operator.operations_expire",
          actor: { kind: "system", id: null },
          source: "system",
          organizationId: null,
          target: null,
          outcome: "success",
          requestId: ctx.requestId,
          operationId: null,
          details: { expired: 0 },
        });
      });
      return { status: 200, body: { ok: true } };
    }
    default:
      return { status: 200, body: { ok: true } };
  }
};

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi({ routes: [{ def: ECHO, handler: echo }] });
});

afterAll(async () => {
  await api.close();
});

/** A JSON text of exactly `size` bytes: {"text":"xxx…"}. */
function bodyOfSize(size: number): string {
  const frame = '{"text":""}';
  return `{"text":"${"x".repeat(size - frame.length)}"}`;
}

function nestedOfDepth(depth: number): string {
  // depth counts containers: {"nested": [[…]]} has depth 1 + (depth - 1) arrays.
  return `{"nested":${"[".repeat(depth - 1)}${"]".repeat(depth - 1)}}`;
}

const json = { "content-type": "application/json" };

async function refused(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  expect((await errorOf(response)).code).toBe("malformed_request");
}

describe("every response", () => {
  it("carries no-store and a fresh request id, the error's own id on errors", async () => {
    const requests: [string, string, Parameters<TestApi["request"]>[2]][] = [
      ["GET", "/health", {}],
      ["GET", "/v1/version", {}],
      ["GET", "/v1/version?", {}],
      ["POST", "/v1/_test/echo", { body: {} }],
      ["GET", "/", {}],
      ["GET", "/v1/nothing-here", {}],
      ["POST", "/health", {}],
      ["GET", `/v1/organizations/${randomUUID()}/projects`, {}],
      ["POST", "/v1/_test/echo", { rawBody: "{", headers: json }],
      ["POST", "/v1/_test/echo", { body: { unknown: 1 } }],
      ["POST", "/v1/_test/echo", { body: { mode: "throw" } }],
      [
        "GET",
        "/v1/version",
        { headers: { "x-request-id": "11111111-1111-4111-8111-111111111111" } },
      ],
    ];
    const seen = new Set<string>();
    const statuses = new Set<number>();
    for (const [method, path, init] of requests) {
      const response = await api.request(method, path, init);
      const label = `${method} ${path} → ${String(response.status)}`;
      statuses.add(response.status);
      expect(response.headers.get("cache-control"), label).toBe("no-store");
      const id = response.headers.get("x-request-id") ?? "";
      expect(id, label).toMatch(UUID);
      expect(id, label).not.toBe("11111111-1111-4111-8111-111111111111");
      expect(seen.has(id), label).toBe(false);
      seen.add(id);
      if (response.status >= 400) expect((await errorOf(response)).requestId, label).toBe(id);
    }
    // 401: a product route without a session (Run 3.4).
    expect([...statuses].sort()).toEqual([200, 400, 401, 404, 503]);
  });
});

describe("body rules", () => {
  it("accepts 524,288 bytes and refuses 524,289 before the handler", async () => {
    const limit = LIMITS.body.jsonMaxBytes;
    expect(limit).toBe(524_288);
    const before = reached;
    const ok = await api.request("POST", "/v1/_test/echo", {
      rawBody: bodyOfSize(limit),
      headers: json,
    });
    expect(ok.status).toBe(200);
    expect(reached).toBe(before + 1);
    await refused(
      await api.request("POST", "/v1/_test/echo", {
        rawBody: bodyOfSize(limit + 1),
        headers: json,
      }),
    );
    expect(reached).toBe(before + 1);
  });

  it("accepts depth 16 and refuses depth 17", async () => {
    expect(LIMITS.body.jsonMaxDepth).toBe(16);
    const ok = await api.request("POST", "/v1/_test/echo", {
      rawBody: nestedOfDepth(16),
      headers: json,
    });
    expect(ok.status).toBe(200);
    const before = reached;
    await refused(
      await api.request("POST", "/v1/_test/echo", { rawBody: nestedOfDepth(17), headers: json }),
    );
    expect(reached).toBe(before);
  });

  it.each([
    ["a duplicate key", '{"text":"a","text":"b"}', json],
    ["a duplicate key inside a nested object", '{"nested":{"a":1,"a":2}}', json],
    ["an unknown field", '{"other":1}', json],
    ["a field of the wrong type", '{"text":1}', json],
    ["text/plain", '{"text":"a"}', { "content-type": "text/plain" }],
    ["no content type", '{"text":"a"}', {}],
    ["invalid JSON", '{"text":', json],
    ["an empty body", "", json],
    ["a JSON array", "[]", json],
  ])("refuses %s before the handler", async (_name, rawBody, headers) => {
    const before = reached;
    await refused(await api.request("POST", "/v1/_test/echo", { rawBody, headers }));
    expect(reached).toBe(before);
  });

  it("refuses invalid UTF-8 before the handler", async () => {
    const before = reached;
    const bytes = Buffer.concat([
      Buffer.from('{"text":"', "utf8"),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}', "utf8"),
    ]);
    await refused(await api.request("POST", "/v1/_test/echo", { rawBody: bytes, headers: json }));
    expect(reached).toBe(before);
  });

  it("refuses a body on a GET", async () => {
    await refused(await api.request("GET", "/v1/version", { rawBody: "{}", headers: json }));
  });

  it("refuses headers over the limit", async () => {
    const response = await api.request("GET", "/v1/version", {
      headers: { "x-padding": "p".repeat(LIMITS.body.headersMaxBytes) },
    });
    await refused(response);
  });

  it("answers 422 validation_failed for a value of the right type that breaks its rule", async () => {
    const before = reached;
    const response = await api.request("POST", "/v1/_test/echo", { body: { small: 11 } });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("validation_failed");
    expect(reached).toBe(before);
  });

  it("refuses a chunked body over the limit after reading at most limit + 64 KiB", async () => {
    const limit = LIMITS.body.jsonMaxBytes;
    const ca = readFileSync(api.database.stack.api.certAuthorityPath);
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = https.request(
        {
          host: "127.0.0.1",
          port: api.port,
          path: "/v1/_test/echo",
          method: "POST",
          ca,
          agent: false,
          headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.on("error", (error: NodeJS.ErrnoException) => {
        // The server may close the connection while the client is still writing.
        if (error.code === "ECONNRESET" || error.code === "EPIPE") return;
        reject(error);
      });
      const chunk = Buffer.alloc(16 * 1024, 0x20);
      let sent = 0;
      const pump = (): void => {
        while (sent < 4 * limit) {
          sent += chunk.length;
          if (!outgoing.write(chunk)) {
            outgoing.once("drain", pump);
            return;
          }
        }
        outgoing.end();
      };
      outgoing.write("{");
      pump();
    });
    expect(status).toBe(400);
    const line = api.logs.findLast(
      (entry) => entry.event === "request" && entry.path === "/v1/_test/echo",
    );
    expect(line).toBeDefined();
    if (line?.event !== "request") throw new Error("no request line");
    expect(line.status).toBe(400);
    expect(line.bodyBytesRead).toBeGreaterThan(limit);
    expect(line.bodyBytesRead).toBeLessThanOrEqual(limit + 64 * 1024);
  });
});

describe("handler failures", () => {
  it("a handler that throws answers 503 and leaks nothing", async () => {
    const canary = `canary-${randomBytes(16).toString("hex")}`;
    const before = api.logs.length;
    const response = await api.request("POST", "/v1/_test/echo", {
      body: { mode: "throw", text: canary },
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text.includes(canary)).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ error: { code: "dependency_unavailable" } });
    const lines = api.logs.slice(before);
    expect(JSON.stringify(lines).includes(canary)).toBe(false);
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "unhandled", routeId: "test.echo", errorClass: "Error" }),
    );
  });

  it("a handler that returns an unlisted code answers 503 and logs unlisted_error", async () => {
    const response = await api.request("POST", "/v1/_test/echo", { body: { mode: "unlisted" } });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe("dependency_unavailable");
    const index = api.logs.findIndex(
      (entry) =>
        entry.event === "unlisted_error" &&
        entry.routeId === "test.echo" &&
        entry.code === "version_conflict",
    );
    expect(index).toBeGreaterThanOrEqual(0);
    // Consumed here: any other unlisted_error fails the suite at close().
    api.logs.splice(index, 1);
  });

  it("output that fails the response schema is not sent", async () => {
    const canary = `canary-${randomBytes(16).toString("hex")}`;
    const response = await api.request("POST", "/v1/_test/echo", {
      body: { mode: "bad_output", text: canary },
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text.includes(canary)).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ error: { code: "dependency_unavailable" } });
    expect(api.logs).toContainEqual(
      expect.objectContaining({ event: "output_invalid", routeId: "test.echo", status: 200 }),
    );
  });

  it("a failing audit append answers 503 audit_unavailable and the effect did not happen", async () => {
    const id = randomUUID();
    await api.superuser.query("REVOKE INSERT ON audit.event FROM api_runtime");
    try {
      const response = await api.request("POST", "/v1/_test/echo", {
        body: { mode: "audit", text: id },
      });
      expect(response.status).toBe(503);
      expect((await errorOf(response)).code).toBe("audit_unavailable");
    } finally {
      await api.superuser.query("GRANT INSERT ON audit.event TO api_runtime");
    }
    const rows = await api.superuser.query(
      "SELECT 1 FROM app.rate_limit WHERE scope = 'test:audit' AND key_digest = sha256(convert_to($1, 'UTF8'))",
      [id],
    );
    expect(rows.rowCount).toBe(0);
    // Control: with the grant back, the same request has its effect.
    const ok = await api.request("POST", "/v1/_test/echo", { body: { mode: "audit", text: id } });
    expect(ok.status).toBe(200);
    const after = await api.superuser.query(
      "SELECT 1 FROM app.rate_limit WHERE scope = 'test:audit' AND key_digest = sha256(convert_to($1, 'UTF8'))",
      [id],
    );
    expect(after.rowCount).toBe(1);
  });
});

describe("the request log", () => {
  it("names the route pattern, never the URL or its query", async () => {
    const canary = `canary${randomBytes(8).toString("hex")}`;
    const organization = randomUUID();
    const response = await api.request(
      "GET",
      `/v1/organizations/${organization}/projects?x=${canary}`,
    );
    const requestId = response.headers.get("x-request-id");
    const line = api.logs.find(
      (entry) => entry.event === "request" && entry.requestId === requestId,
    );
    expect(line).toMatchObject({ event: "request", path: "/v1/organizations/:org/projects" });
    expect(JSON.stringify(api.logs).includes(canary)).toBe(false);
    expect(JSON.stringify(api.logs).includes(organization)).toBe(false);
  });
});
