// The API on the local stack, for integration tests (Run 3.1). Each call
// starts the real app in this process over HTTPS, on a fresh database with
// every migration and the job queues, with a gate file in a temporary
// directory outside the repository.
//
// `request` always sends `Origin: <origin>` and `Sec-Fetch-Site: same-origin`
// unless the caller overrides them: Run 3.7 turns the Origin check on, and no
// earlier test may break when it does.
import { randomBytes, randomUUID } from "node:crypto";
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
import {
  codeAt,
  createAuth,
  createThrottle,
  ephemeralKeys,
  stepAt,
  type Auth,
  type AuthKeys,
} from "@mykey/auth";
import { bootstrapOwner } from "@mykey/auth/operator";
import type { RouteDef } from "@mykey/contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import * as OTPAuth from "otpauth";
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
  /**
   * Routes without a handler answer 204 after every pipeline check and record
   * their id in `reached` (Run 3.4), instead of the terminal 404. `"all"`: every
   * contract route but health and version answers through the stub (P-80).
   */
  stubs?: boolean | "all";
  /** Runs inside the stub after the id is recorded; the stub answers when it settles (Run 3.7). */
  stubHook?: (routeId: string) => Promise<void> | void;
  /** Runs after freshness and before a real handler (Run 4.1): state changed after the pipeline. */
  beforeHandler?: (routeId: string) => Promise<void>;
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
  /** Better Auth as the API uses it, and the API's keys (fresh for each API). */
  auth: Auth;
  keys: AuthKeys;
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
  /** Route ids whose stub ran (with `stubs: true`). */
  reached: string[];
  /**
   * A new app and listener on the same database, keys and gate: what survives
   * is what the database holds. Answers this object, now on its new port.
   */
  restart(): Promise<TestApi>;
  setGate(state: GateState): void;
  request(method: string, path: string, init?: RequestInit): Promise<Response>;
  /** Closes everything; fails when a log entry `unlisted_error` was not consumed by its test. */
  close(): Promise<void>;
}

/** An empty header value means: send the request without that header (no Origin, Run 3.7). */
function withoutEmpty(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== ""));
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

    const pool = createPool(database.targets.api_runtime, { max: 10, queryTimeoutMs: 30_000 });
    cleanup.push(() => pool.end());
    const health = createHealthCheck(database.targets.api_runtime);
    cleanup.push(() => health.close());
    const logs: LogEntry[] = [];
    const keys = ephemeralKeys();
    const reached: string[] = [];
    const config: ApiConfig = {
      baseUrl: TEST_ORIGIN,
      build: "0000000",
      gatePath,
      hostInstanceId,
      trustedProxy: null,
      ...opts.config,
    };
    const build = () => {
      const auth = createAuth({ db: drizzle(pool), keys, baseURL: TEST_ORIGIN });
      const app = createApp({
        pool,
        config,
        health: () => health.check(),
        log: (entry) => logs.push(entry),
        auth: { auth, keys, throttle: createThrottle({ pool, ring: keys.rateLimit }) },
        test: {
          ...(opts.routes === undefined ? {} : { routes: opts.routes }),
          ...(opts.stubs === "all" ? { stubAll: true } : {}),
          ...(opts.beforeHandler === undefined ? {} : { beforeHandler: opts.beforeHandler }),
          ...(opts.stubs === true || opts.stubs === "all"
            ? {
                stubs: async (routeId: string) => {
                  reached.push(routeId);
                  await opts.stubHook?.(routeId);
                },
              }
            : {}),
          // TOTP codes are checked at the time a test sends (Run 3.4).
          clock: (headers: Headers) => {
            const value = headers.get("x-test-now");
            return value === null ? undefined : new Date(value);
          },
        },
      });
      return { auth, app };
    };
    let built = build();
    const tls = { certPath: database.stack.api.certPath, keyPath: database.stack.api.keyPath };
    let server: ApiServer = await listen(built.app, { hostname: "127.0.0.1", port: 0, tls });
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
          {
            host: "127.0.0.1",
            port: server.port,
            path,
            method,
            headers: withoutEmpty(headers),
            ca,
            agent: false,
          },
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

    const api: TestApi = {
      get auth() {
        return built.auth;
      },
      keys,
      get baseUrl() {
        return `https://127.0.0.1:${String(server.port)}`;
      },
      origin: TEST_ORIGIN,
      get port() {
        return server.port;
      },
      reached,
      async restart() {
        await server.close();
        built = build();
        server = await listen(built.app, { hostname: "127.0.0.1", port: 0, tls });
        return api;
      },
      database,
      pool,
      superuser: database.pool("superuser"),
      logs,
      get routes() {
        return built.app.routes
          .filter((route) => route.method !== "ALL")
          .map((route) => ({ method: route.method, path: route.path }));
      },
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
    return api;
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

export interface SeededOwner {
  userId: string;
  organizationId: string;
  email: string;
  password: string;
}

/**
 * The owner of a test API, made the way an operator makes one: through
 * `bootstrapOwner` as `maintenance` (Run 3.2). The password is synthetic.
 */
export async function seedOwner(api: TestApi, opts: { email?: string } = {}): Promise<SeededOwner> {
  const email = opts.email ?? `owner-${randomUUID().slice(0, 8)}@mykey.invalid`;
  const password = randomBytes(18).toString("base64url");
  const result = await bootstrapOwner(
    { auth: api.auth, pool: api.database.pool("maintenance") },
    { email, password },
  );
  if (result.outcome !== "created") throw new Error(`seedOwner: ${result.outcome}`);
  return { userId: result.userId, organizationId: result.organizationId, email, password };
}

/** The `name=value` pair of the session cookie a response set; throws when there is none. */
export function sessionCookieOf(response: Response): string {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0] ?? "";
    if (pair.startsWith("__Secure-better-auth.session_token=") && pair.length > 40) return pair;
  }
  throw new Error("the response set no session cookie");
}

export interface EnrolledOwner extends SeededOwner {
  /** The TOTP seed as the authenticator app holds it. */
  seed: Uint8Array;
  recoveryCodes: string[];
  /** The mfa_complete cookie that activation set. */
  cookie: string;
}

/**
 * Takes an `enrollment_pending` account through the HTTP routes: sign-in,
 * enroll, activate with a code of the current step. `source` is sent as
 * X-Forwarded-For (meaningful only where the harness's peer is the trusted edge).
 */
export async function enrollOwner(
  api: TestApi,
  owner: SeededOwner,
  opts: { source?: string } = {},
): Promise<EnrolledOwner> {
  const headers: Record<string, string> =
    opts.source === undefined ? {} : { "x-forwarded-for": opts.source };
  const signedIn = await api.request("POST", "/v1/auth/sign-in/email", {
    body: { email: owner.email, password: owner.password },
    headers,
  });
  if (signedIn.status !== 200) throw new Error(`sign-in answered ${String(signedIn.status)}`);
  const password = sessionCookieOf(signedIn);
  const enrolled = await api.request("POST", "/v1/auth/totp/enroll", {
    body: {},
    cookie: password,
    headers,
  });
  if (enrolled.status !== 200) throw new Error(`enroll answered ${String(enrolled.status)}`);
  const { secret } = (await enrolled.json()) as { secret: string };
  const seed = OTPAuth.Secret.fromBase32(secret).bytes;
  const activated = await api.request("POST", "/v1/auth/totp/activate", {
    body: { code: codeAt(seed, stepAt(new Date())) },
    cookie: password,
    headers,
  });
  if (activated.status !== 200) throw new Error(`activate answered ${String(activated.status)}`);
  const { recoveryCodes } = (await activated.json()) as { recoveryCodes: string[] };
  return { ...owner, seed, recoveryCodes, cookie: sessionCookieOf(activated) };
}

/** One HTTPS request to an API on 127.0.0.1:`port`, with the product's Origin (another process's API). */
export function requestTo(
  target: { port: number; ca: Buffer },
  method: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      origin: TEST_ORIGIN,
      "sec-fetch-site": "same-origin",
    };
    let payload: Buffer | undefined;
    if (init.body !== undefined) {
      payload = Buffer.from(JSON.stringify(init.body), "utf8");
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    if (init.cookie !== undefined) headers.cookie = init.cookie;
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      headers[name.toLowerCase()] = value;
    }
    const outgoing = https.request(
      {
        host: "127.0.0.1",
        port: target.port,
        path,
        method,
        headers: withoutEmpty(headers),
        ca: target.ca,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const answerHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const v of value) answerHeaders.append(name, v);
            else if (value !== undefined) answerHeaders.set(name, value);
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 0,
              headers: answerHeaders,
            }),
          );
        });
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

let completeSteps = 0;

/**
 * Signs in with password and TOTP and returns the mfa_complete cookie and the
 * session id. Each call verifies at a step of its own, far from the present,
 * so no two calls (or activation) ever share a step (Run 3.5).
 */
export async function signInComplete(
  api: TestApi,
  user: { email: string; password: string; seed: Uint8Array },
  opts: { source?: string } = {},
): Promise<{ cookie: string; sessionId: string }> {
  completeSteps += 1;
  const headers: Record<string, string> =
    opts.source === undefined ? {} : { "x-forwarded-for": opts.source };
  const signedIn = await api.request("POST", "/v1/auth/sign-in/email", {
    body: { email: user.email, password: user.password },
    headers,
  });
  if (signedIn.status !== 200) throw new Error(`sign-in answered ${String(signedIn.status)}`);
  const now = new Date(Date.now() + (1000 + completeSteps) * 90_000);
  const verified = await api.request("POST", "/v1/auth/totp/verify", {
    body: { code: codeAt(user.seed, stepAt(now)) },
    cookie: sessionCookieOf(signedIn),
    headers: { ...headers, "x-test-now": now.toISOString() },
  });
  if (verified.status !== 200) throw new Error(`verify answered ${String(verified.status)}`);
  const cookie = sessionCookieOf(verified);
  const session = await api.request("GET", "/v1/auth/get-session", { cookie, headers });
  const body = (await session.json()) as { session?: { id?: string } } | null;
  const sessionId = body?.session?.id;
  if (sessionId === undefined) throw new Error("get-session named no session");
  return { cookie, sessionId };
}
