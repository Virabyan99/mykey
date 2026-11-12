// The API on the local stack, for integration tests (Run 3.1). Each call
// starts the real app in this process over HTTPS, on a fresh database with
// every migration and the job queues, with a gate file in a temporary
// directory outside the repository.
//
// `request` always sends `Origin: <origin>` and `Sec-Fetch-Site: same-origin`
// unless the caller overrides them: Run 3.7 turns the Origin check on, and no
// earlier test may break when it does.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  createHealthCheck,
  listen,
  startOutboxDispatcher,
  type ApiConfig,
  type ApiServer,
  type Handler,
  type LogEntry,
} from "@mykey/api";
import type { RouteDef } from "@mykey/contracts";
import { createPool } from "@mykey/db";
import { ensureQueues } from "@mykey/operations";
import type pg from "pg";
import { prepareDatabase, type TestDatabase } from "../integration/database/setup.ts";
import { getSharedStack, type Stack } from "./stack.ts";

export type GateState = "open" | "closed" | "missing" | { raw: string };

export interface TestRoute {
  def: RouteDef;
  handler: Handler;
}

export interface StartTestApiOptions {
  gate?: "open" | "closed" | "missing";
  /** Test-only routes, mounted through `mountRoute` like contract routes. */
  routes?: readonly TestRoute[];
  /** Overrides of the API configuration. */
  config?: Partial<ApiConfig>;
  /** A stack the suite owns (default: the shared one). */
  stack?: Stack;
  /**
   * Every connection to PostgreSQL goes through a local relay on a fixed port,
   * which follows the container to its new published port after a restart.
   */
  relayDatabase?: boolean;
  /** Start the outbox dispatcher, as the API process does (default true). */
  dispatcher?: boolean;
}

/** A TCP relay to the stack's PostgreSQL, reading its current port for every connection. */
async function startRelay(stack: Stack): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const relay = net.createServer((client) => {
    const upstream = net.connect({ host: stack.pg.host, port: stack.pg.port });
    sockets.add(client);
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => sockets.delete(client));
    upstream.on("close", () => sockets.delete(upstream));
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  return {
    port: (relay.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        relay.close(() => {
          resolve();
        });
      }),
  };
}

export interface RequestInit {
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
  rawBody?: string | Uint8Array;
}

export interface TestApi {
  baseUrl: string;
  origin: string;
  port: number;
  database: TestDatabase;
  /** The API's own pool (api_runtime). */
  pool: pg.Pool;
  superuser: pg.Pool;
  logs: LogEntry[];
  /** Method and path of every route of the Hono app. */
  routes: { method: string; path: string }[];
  setGate(state: GateState): void;
  request(method: string, path: string, init?: RequestInit): Promise<Response>;
  /** Closes everything; fails when a log entry `unlisted_error` was not consumed by its test. */
  close(): Promise<void>;
}

/** The public origin the test API believes it serves. */
export const TEST_ORIGIN = "https://mykey.test";

export async function startTestApi(opts: StartTestApiOptions = {}): Promise<TestApi> {
  const cleanup: (() => Promise<void> | void)[] = [];
  const release = async () => {
    for (const step of cleanup.reverse()) await step();
  };
  let stack = opts.stack ?? (await getSharedStack());
  if (opts.relayDatabase === true) {
    const relay = await startRelay(stack);
    cleanup.push(() => relay.close());
    stack = { ...stack, pg: { ...stack.pg, host: "127.0.0.1", port: relay.port } };
  }
  const database = await prepareDatabase({ stack }).catch(async (error: unknown) => {
    await release();
    throw error;
  });
  cleanup.push(() => database.drop());
  try {
    await ensureQueues(database.pool("migration_owner"));
    const gateDirectory = mkdtempSync(join(tmpdir(), "mykey-gate-"));
    cleanup.push(() => {
      rmSync(gateDirectory, { recursive: true, force: true });
    });
    const gatePath = join(gateDirectory, "gate.json");
    const hostInstanceId = randomUUID();
    let epoch = 0;
    const setGate = (state: GateState): void => {
      if (state === "missing") {
        rmSync(gatePath, { force: true });
        return;
      }
      const text =
        typeof state === "object"
          ? state.raw
          : JSON.stringify({
              version: 1,
              state,
              gateEpoch: (epoch += 1),
              hostInstanceId,
              writtenAt: new Date().toISOString(),
            });
      // Written beside and renamed, as `host.ts gate` does: never read half-written.
      writeFileSync(`${gatePath}.tmp`, text);
      renameSync(`${gatePath}.tmp`, gatePath);
    };
    setGate(opts.gate ?? "open");

    const pool = createPool(database.targets.api_runtime, { max: 10 });
    cleanup.push(() => pool.end());
    const health = createHealthCheck(database.targets.api_runtime);
    cleanup.push(() => health.close());
    const logs: LogEntry[] = [];
    const config: ApiConfig = {
      baseUrl: TEST_ORIGIN,
      build: "0000000",
      gatePath,
      hostInstanceId,
      trustedProxy: null,
      ...opts.config,
    };
    const app = createApp({
      pool,
      config,
      health: () => health.check(),
      log: (entry) => logs.push(entry),
      ...(opts.routes === undefined ? {} : { test: { routes: opts.routes } }),
    });
    const server: ApiServer = await listen(app, {
      hostname: "127.0.0.1",
      port: 0,
      tls: { certPath: database.stack.api.certPath, keyPath: database.stack.api.keyPath },
    });
    cleanup.push(() => server.close());
    if (opts.dispatcher !== false) {
      const dispatcher = startOutboxDispatcher(pool, (entry) => logs.push(entry));
      cleanup.push(() => dispatcher.stop());
    }
    const ca = readFileSync(database.stack.api.certAuthorityPath);

    const request = (method: string, path: string, init: RequestInit = {}): Promise<Response> =>
      new Promise((resolve, reject) => {
        const headers: Record<string, string> = {
          origin: TEST_ORIGIN,
          "sec-fetch-site": "same-origin",
        };
        let payload: Buffer | undefined;
        if (init.rawBody !== undefined) {
          payload = Buffer.from(init.rawBody);
        } else if (init.body !== undefined) {
          payload = Buffer.from(JSON.stringify(init.body), "utf8");
          headers["content-type"] = "application/json";
        }
        if (payload !== undefined) headers["content-length"] = String(payload.length);
        if (init.cookie !== undefined) headers.cookie = init.cookie;
        for (const [name, value] of Object.entries(init.headers ?? {})) {
          headers[name.toLowerCase()] = value;
        }
        const outgoing = https.request(
          { host: "127.0.0.1", port: server.port, path, method, headers, ca, agent: false },
          (response) => {
            answered = true;
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => {
              const status = response.statusCode ?? 0;
              const answerHeaders = new Headers();
              for (const [name, value] of Object.entries(response.headers)) {
                if (Array.isArray(value)) for (const v of value) answerHeaders.append(name, v);
                else if (value !== undefined) answerHeaders.set(name, value);
              }
              const body = [101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
              resolve(new Response(body, { status, headers: answerHeaders }));
            });
            response.on("error", (error: NodeJS.ErrnoException) => {
              if (error.code === "ECONNRESET" && chunks.length > 0) return;
              reject(error);
            });
          },
        );
        // The API may answer (400 for an oversized body) while the client is
        // still uploading; the reset that follows does not undo that answer.
        let answered = false;
        outgoing.on("error", (error: NodeJS.ErrnoException) => {
          if (answered && (error.code === "ECONNRESET" || error.code === "EPIPE")) return;
          reject(error);
        });
        outgoing.end(payload);
      });

    return {
      baseUrl: `https://127.0.0.1:${String(server.port)}`,
      origin: TEST_ORIGIN,
      port: server.port,
      database,
      pool,
      superuser: database.pool("superuser"),
      logs,
      routes: app.routes
        .filter((route) => route.method !== "ALL")
        .map((route) => ({ method: route.method, path: route.path })),
      setGate,
      request,
      async close() {
        await release();
        const unlisted = logs.filter((entry) => entry.event === "unlisted_error");
        if (unlisted.length > 0) {
          throw new Error(
            `the API logged unlisted_error for: ${unlisted.map((entry) => ("routeId" in entry ? entry.routeId : "")).join(", ")}`,
          );
        }
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}

/** The parsed error envelope of a response. */
export async function errorOf(
  response: Response,
): Promise<{ code: string; message: string; requestId: string }> {
  const body = (await response.json()) as {
    error: { code: string; message: string; requestId: string };
  };
  return body.error;
}
