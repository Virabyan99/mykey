// Run 2.5 Task C: the API health stub against a real PostgreSQL over verified TLS.
//
// The suite owns its stack, because it stops PostgreSQL. The API runs in this
// process with the stack's certificates. It reaches the database through a
// small TCP relay on a fixed local port: Docker gives a restarted container a
// new published port, and a real API would keep its configured address.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { rootCertificates } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createApp,
  createHealthCheck,
  listen,
  type ApiConfig,
  type ApiServer,
  type LogEntry,
} from "@mykey/api";
import { createPool, type DbTarget as Target } from "@mykey/db";
import { ROUTES, errorEnvelopeSchema } from "@mykey/contracts";
import { ROLE_NAMES, applyRoles, type DbTarget, type RoleName } from "@mykey/db";
import type { z } from "zod";
import {
  baoFetch,
  restartService,
  startService,
  startStack,
  stopService,
  type Stack,
} from "../../harness/stack.ts";

/**
 * The API as startServer builds it, without the auth module: from Run 3.2 the
 * production entry refuses to start without throttling (Run 3.3), and this
 * suite is about /health only. Ledgered: back to startServer in Run 3.3.
 */
async function startServer(config: {
  hostname: string;
  port: number;
  tls: { certPath: string; keyPath: string };
  database: Target;
  openbao?: { url: string; caCertPath: string };
  api: ApiConfig;
  log: (entry: LogEntry) => void;
}): Promise<ApiServer> {
  const health = createHealthCheck(config.database, config.openbao);
  const pool = createPool(config.database, { max: 2 });
  const app = createApp({
    pool,
    config: config.api,
    health: () => health.check(),
    log: config.log,
  });
  const server = await listen(app, config);
  return {
    port: server.port,
    async close() {
      await server.close();
      await health.close();
      await pool.end();
    },
  };
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function request(
  stack: Stack,
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = https.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: init.headers,
        ca: readFileSync(stack.api.certAuthorityPath),
        timeout: 10_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text === "" ? null : (JSON.parse(text) as unknown),
          });
        });
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("API request timed out")));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

const healthRoute = ROUTES.find((route) => route.id === "health.get");
const healthBody = (status: 200 | 503): z.ZodType => {
  const schema = healthRoute?.responses[status];
  if (schema === undefined || typeof schema === "string") {
    throw new Error("the contract has no body schema for health.get");
  }
  return schema;
};

describe("API health stub", () => {
  let stack: Stack;
  let relay: net.Server;
  let relayPort: number;
  let api: ApiServer;
  let database: DbTarget;
  const log: LogEntry[] = [];
  const directory = mkdtempSync(join(tmpdir(), "mykey-api-"));
  // An open gate (Run 3.1): this suite is about health, not the gate.
  const hostInstanceId = randomUUID();
  const apiConfig: ApiConfig = {
    baseUrl: "https://mykey.test",
    build: "0000000",
    gatePath: join(directory, "gate.json"),
    hostInstanceId,
    trustedProxy: null,
  };
  writeFileSync(
    apiConfig.gatePath,
    JSON.stringify({
      version: 1,
      state: "open",
      gateEpoch: 1,
      hostInstanceId,
      writtenAt: new Date().toISOString(),
    }),
  );
  const cleanup: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    stack = await startStack();
    cleanup.push(() => stack.stop());
    const passwords = Object.fromEntries(
      ROLE_NAMES.map((role) => [role, randomBytes(24).toString("base64url")]),
    ) as Record<RoleName, string>;
    await applyRoles(
      {
        host: stack.pg.host,
        port: stack.pg.port,
        database: stack.pg.database,
        user: stack.pg.superuser.user,
        password: stack.pg.superuser.password,
        caCertPath: stack.pg.caCertPath,
      },
      passwords,
    );

    relay = net.createServer((client) => {
      const upstream = net.connect({ host: stack.pg.host, port: stack.pg.port });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    relayPort = (relay.address() as net.AddressInfo).port;
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          relay.close(() => {
            resolve();
          });
        }),
    );

    const passwordFile = join(directory, "api-runtime-password");
    writeFileSync(passwordFile, passwords.api_runtime, { mode: 0o600 });
    database = {
      host: "127.0.0.1",
      port: relayPort,
      database: stack.pg.database,
      user: "api_runtime",
      password: passwords.api_runtime,
      caCertPath: stack.pg.caCertPath,
    };
    api = await startServer({
      hostname: "127.0.0.1",
      port: 0,
      tls: { certPath: stack.api.certPath, keyPath: stack.api.keyPath },
      database,
      api: apiConfig,
      log: (entry) => log.push(entry),
    });
    cleanup.push(() => api.close());
  });

  afterAll(async () => {
    // In reverse order of creation; a failed beforeAll leaves only what it made.
    for (const release of cleanup.reverse()) await release();
    rmSync(directory, { recursive: true, force: true });
  });

  it("answers 200 up when a SELECT as api_runtime over verified TLS succeeds", async () => {
    const answer = await request(stack, api.port, "/health");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ status: "up" });
    expect(healthBody(200).safeParse(answer.body).success).toBe(true);
  });

  it("answers 404 with the not_found envelope and a request id for everything else", async () => {
    const cases = [
      { path: "/", method: "GET" },
      { path: "/health", method: "POST" },
      { path: "/v1/anything", method: "GET" },
    ];
    const ids = new Set<string>();
    for (const { path, method } of cases) {
      const answer = await request(stack, api.port, path, { method });
      expect(answer.status, `${method} ${path}`).toBe(404);
      const envelope = errorEnvelopeSchema.parse(answer.body);
      expect(envelope.error.code, `${method} ${path}`).toBe("not_found");
      ids.add(envelope.error.requestId);
    }
    expect(ids.size).toBe(cases.length);
  });

  it("sends no Server and no X-Powered-By header", async () => {
    for (const path of ["/health", "/missing"]) {
      const answer = await request(stack, api.port, path);
      expect(answer.headers.server, path).toBeUndefined();
      expect(answer.headers["x-powered-by"], path).toBeUndefined();
    }
  });

  it("writes one log line per request with the peer address and the forwarded values", async () => {
    const before = log.length;
    const answer = await request(stack, api.port, "/health", {
      headers: { "X-Forwarded-For": "203.0.113.9", "X-Forwarded-Proto": "http" },
    });
    expect(answer.status).toBe(200);
    const lines = log.slice(before).filter((entry) => entry.event === "request");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "request",
      method: "GET",
      path: "/health",
      status: 200,
      peer: "127.0.0.1",
      forwardedFor: "203.0.113.9",
      forwardedProto: "http",
    });
    expect(lines[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // The answer names its log line, so an outside test can find it (Run 2.5 Task D).
    expect(answer.headers["x-request-id"]).toBe(lines[0]?.requestId);
    // Nothing of the database target may reach a log line.
    expect(JSON.stringify(log)).not.toContain(database.password);
  });

  it("answers 503 down with a certificate cause when the CA did not sign the database certificate", async () => {
    // A real public root certificate that did not sign the stack's server certificate.
    const otherCa = join(directory, "other-ca.crt");
    writeFileSync(otherCa, rootCertificates[0]!);
    const lines: LogEntry[] = [];
    const distrusting = await startServer({
      hostname: "127.0.0.1",
      port: 0,
      tls: { certPath: stack.api.certPath, keyPath: stack.api.keyPath },
      database: { ...database, caCertPath: otherCa },
      api: apiConfig,
      log: (entry) => lines.push(entry),
    });
    try {
      const answer = await request(stack, distrusting.port, "/health");
      expect(answer.status).toBe(503);
      expect(answer.body).toEqual({ status: "down" });
      expect(healthBody(503).safeParse(answer.body).success).toBe(true);
      // The failure is named; there is no silent fallback to an unverified or plaintext connection.
      expect(lines.filter((entry) => entry.event === "health_down")).toEqual([
        expect.objectContaining({ event: "health_down", cause: "certificate" }),
      ]);
    } finally {
      await distrusting.close();
    }
  });

  it("answers 503 down within 3 s of PostgreSQL stopping, and 200 again after it starts", async () => {
    expect((await request(stack, api.port, "/health")).status).toBe(200);

    await stopService(stack, "postgres");
    const stoppedAt = Date.now();
    let down: Answer | undefined;
    while (Date.now() - stoppedAt < 3_000) {
      const answer = await request(stack, api.port, "/health");
      if (answer.status === 503) {
        down = answer;
        break;
      }
      await sleep(100);
    }
    expect(down, "no 503 within 3 s of the stop").toBeDefined();
    expect(down?.body).toEqual({ status: "down" });

    await startService(stack, "postgres");
    const startedAt = Date.now();
    let status = 0;
    while (Date.now() - startedAt < 30_000) {
      status = (await request(stack, api.port, "/health")).status;
      if (status === 200) break;
      await sleep(250);
    }
    expect(status).toBe(200);
  });

  describe("with OpenBao (Run 2.7)", () => {
    let withBao: ApiServer;
    let baoRelay: net.Server;
    // A restarted OpenBao is published on another port; the relay follows it,
    // the API keeps its configured address.
    let baoTarget = { host: "", port: 0 };
    const baoLog: LogEntry[] = [];

    const pointAtBao = (): void => {
      const url = new URL(stack.bao.url);
      baoTarget = { host: url.hostname, port: Number(url.port) };
    };

    beforeAll(async () => {
      pointAtBao();
      const open = new Set<net.Socket>();
      baoRelay = net.createServer((client) => {
        const upstream = net.connect(baoTarget);
        open.add(client).add(upstream);
        client.on("close", () => open.delete(client));
        upstream.on("close", () => open.delete(upstream));
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        client.pipe(upstream).pipe(client);
      });
      await new Promise<void>((resolve) => baoRelay.listen(0, "127.0.0.1", resolve));
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            // A connection to a stopped OpenBao may never end by itself.
            for (const socket of open) socket.destroy();
            baoRelay.close(() => {
              resolve();
            });
          }),
      );
      withBao = await startServer({
        hostname: "127.0.0.1",
        port: 0,
        tls: { certPath: stack.api.certPath, keyPath: stack.api.keyPath },
        database,
        openbao: {
          url: `https://127.0.0.1:${(baoRelay.address() as net.AddressInfo).port}`,
          caCertPath: stack.bao.caCertPath,
        },
        api: apiConfig,
        log: (entry) => baoLog.push(entry),
      });
      cleanup.push(() => withBao.close());
    });

    /** Polls /health until `status`, up to `ms`; returns the last answer. */
    const healthUntil = async (status: number, ms: number): Promise<Answer> => {
      const started = Date.now();
      let answer = await request(stack, withBao.port, "/health");
      while (answer.status !== status && Date.now() - started < ms) {
        await sleep(250);
        answer = await request(stack, withBao.port, "/health");
      }
      return answer;
    };
    const lastCause = (): string | undefined =>
      baoLog
        .filter((entry) => entry.event === "health_down")
        .map((entry) => entry.cause)
        .at(-1);

    it("answers 200 only when PostgreSQL and an unsealed OpenBao both answer (control)", async () => {
      expect((await healthUntil(200, 5_000)).status).toBe(200);
    });

    it("answers 503 while OpenBao is sealed, and 200 once it has unsealed", async () => {
      const sealed = await baoFetch(stack, "/v1/sys/seal", { method: "PUT" });
      expect(sealed.status).toBe(204);
      const down = await healthUntil(503, 5_000);
      expect(down.status).toBe(503);
      expect(down.body).toEqual({ status: "down" });
      expect(lastCause()).toBe("openbao_sealed");
      // The development seal unseals on start.
      await restartService(stack, "openbao");
      pointAtBao();
      expect((await healthUntil(200, 60_000)).status).toBe(200);
    });

    it("answers 503 while OpenBao is stopped: a refused connection counts as down", async () => {
      await stopService(stack, "openbao");
      const down = await healthUntil(503, 5_000);
      expect(down.status).toBe(503);
      expect(lastCause()).toBe("openbao_down");
      await startService(stack, "openbao");
      pointAtBao();
      expect((await healthUntil(200, 60_000)).status).toBe(200);
    });
  });
});
