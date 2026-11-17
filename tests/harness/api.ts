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
  createServiceGate,
  auditedBaoCall,
  createHealthCheck,
  issuerBaoFromDirectory,
  listen,
  runtimeBaoFromDirectory,
  startOutboxDispatcher,
  type ApiConfig,
  type AppDeps,
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
import type { OpenBaoTarget } from "@mykey/openbao";
import { ensureQueues, readCapacity, type IssuerBao, type RuntimeBao } from "@mykey/operations";
import type pg from "pg";
import { prepareDatabase, type TestDatabase } from "../integration/database/setup.ts";
import { getSharedStack, type Stack } from "./stack.ts";
import { testLimiter, type RateLimitsMode } from "./rate.ts";
import { TEST_BUILD, gateText, setIncarnation } from "./gate.ts";

/** Run 6.7: "verifying" is closed + verifying (the verification listener serves). */
export type GateState = "open" | "closed" | "verifying" | "missing" | { raw: string };

/** Run 6.3 (P-115): what the test host's capacity record says; "ok" by default. */
export type CapacityMode = "ok" | "low" | "missing" | "stale" | "invalid";

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
  /**
   * With `stubs: true`: these routes answer through the stub although they have
   * a handler — suites about the pipeline that use a route a later run filled in.
   */
  stubRoutes?: readonly string[];
  /** Runs inside the stub after the id is recorded; the stub answers when it settles (Run 3.7). */
  stubHook?: (routeId: string) => Promise<void> | void;
  /** Runs after freshness and before a real handler (Run 4.1): state changed after the pipeline. */
  beforeHandler?: (routeId: string, info: { handled: boolean }) => Promise<void>;
  /**
   * The API's OpenBao identity (Run 4.2): the runtime credential files in
   * `secretsDirectory`, OpenBao at `openBao()` (read on every call, so a test
   * can point the API elsewhere), and a lock pool of 8.
   */
  runtime?: { openBao: () => OpenBaoTarget; secretsDirectory: string };
  /**
   * Run 5.9: without `runtime`, the organization the process serves (service
   * scope, P-101); its RuntimeBao gives no OpenBao client. Read on every call.
   */
  processOrganization?: () => string | null;
  /** Run 6.7 (P-123): a second listener, the verification one, on the same deps and gate. */
  verifyListener?: boolean;
  /** The auth keys (default: fresh ephemeral ones); shared with a child API process. */
  keys?: AuthKeys;
  /** Fault hooks of the secret protocol (Run 4.2), read on every call. */
  faults?: () => FaultHook | undefined;
  /** An import's time budget per request (Run 4.7), read on every request. */
  importBudgetMs?: () => number | undefined;
  /** Run 6.3: the product's rate limits, or (default) limits that never refuse. */
  rateLimits?: RateLimitsMode;
}

export type FaultHook = (point: string, operationId: string) => void | Promise<void>;

/** A RuntimeBao whose OpenBao target is read on every call (one cached reader per target). */
function switchableRuntime(runtime: NonNullable<StartTestApiOptions["runtime"]>): RuntimeBao {
  const readers = new Map<string, RuntimeBao>();
  const reader = (): RuntimeBao => {
    const target = runtime.openBao();
    let found = readers.get(target.url);
    if (found === undefined) {
      found = runtimeBaoFromDirectory(target, runtime.secretsDirectory);
      readers.set(target.url, found);
    }
    return found;
  };
  return {
    clientFor: (organizationId) => reader().clientFor(organizationId),
    organizationId: () => reader().organizationId(),
    withToken: (organizationId, token) => reader().withToken(organizationId, token),
  };
}

/** Run 5.9: a RuntimeBao that names the process's organization and gives no OpenBao client. */
function organizationOnly(organization: () => string | null): RuntimeBao {
  return {
    clientFor: () => null,
    organizationId: () => organization() as ReturnType<RuntimeBao["organizationId"]>,
    withToken: () => null,
  };
}

/** Run 5.1: the issuer identity from the same directory, its OpenBao target read on every call. */
function switchableIssuer(runtime: NonNullable<StartTestApiOptions["runtime"]>): IssuerBao {
  const issuers = new Map<string, IssuerBao>();
  return {
    open(organizationId) {
      const target = runtime.openBao();
      let issuer = issuers.get(target.url);
      if (issuer === undefined) {
        issuer = issuerBaoFromDirectory(target, runtime.secretsDirectory);
        issuers.set(target.url, issuer);
      }
      return issuer.open(organizationId);
    },
  };
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
  /** The gate file and host binding the API reads (for a child process on the same gate). */
  gate: {
    gatePath: string;
    hostInstanceId: string;
    backendIncarnation: string;
    releaseBuild: string;
  };
  /** The lock pool of the runtime identity (Run 4.2); undefined without `runtime`. */
  lockPool: pg.Pool | undefined;
  /** The current app's boot id (a new one after restart()). */
  readonly bootId: string;
  /**
   * A new app and listener on the same database, keys and gate: what survives
   * is what the database holds. Answers this object, now on its new port.
   */
  restart(): Promise<TestApi>;
  setGate(state: GateState): void;
  /** Run 6.3 (P-115): the capacity record every process of this gate directory reads. */
  setCapacity(mode: CapacityMode): void;
  request(method: string, path: string, init?: RequestInit): Promise<Response>;
  /**
   * Run 6.7 (P-123): a request on the verification listener; only with
   * `verifyListener: true`.
   */
  verifyRequest(method: string, path: string, init?: RequestInit): Promise<Response>;
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
    // Run 6.7 (P-122): the incarnation this API, its gate record and its database share.
    const backendIncarnation = opts.config?.backendIncarnation ?? randomUUID();
    const releaseBuild = opts.config?.build ?? TEST_BUILD;
    await setIncarnation(database.pool("superuser"), backendIncarnation);
    let epoch = 0;
    const setGate = (state: GateState): void => {
      if (state === "missing") {
        rmSync(gatePath, { force: true });
        return;
      }
      const text =
        typeof state === "object"
          ? state.raw
          : gateText({ hostInstanceId, backendIncarnation, releaseBuild }, state, (epoch += 1));
      // Written beside and renamed, as `host.ts gate` does: never read half-written.
      writeFileSync(`${gatePath}.tmp`, text);
      renameSync(`${gatePath}.tmp`, gatePath);
    };
    setGate(opts.gate ?? "open");
    // Run 6.3 (P-115): the capacity record beside the gate, refreshed every
    // 30 s as the host's heartbeat refreshes it every minute.
    const capacityPath = join(gateDirectory, "capacity.json");
    let capacityMode: CapacityMode = "ok";
    const writeCapacity = (): void => {
      if (capacityMode === "missing") {
        rmSync(capacityPath, { force: true });
        return;
      }
      const text =
        capacityMode === "invalid"
          ? "{not json"
          : JSON.stringify({
              version: 1,
              observedAt: new Date(
                Date.now() - (capacityMode === "stale" ? 181_000 : 0),
              ).toISOString(),
              state: capacityMode === "low" ? "low" : "ok",
              volumes: { test: { freeBytes: 2 ** 40, sizeBytes: 2 ** 41, freeInodesPercent: 50 } },
            });
      writeFileSync(`${capacityPath}.tmp`, text);
      renameSync(`${capacityPath}.tmp`, capacityPath);
    };
    writeCapacity();
    const refresher = setInterval(writeCapacity, 30_000);
    refresher.unref();
    cleanup.push(() => {
      clearInterval(refresher);
    });
    const setCapacity = (mode: CapacityMode): void => {
      capacityMode = mode;
      writeCapacity();
    };

    const pool = createPool(database.targets.api_runtime, { max: 10, queryTimeoutMs: 30_000 });
    cleanup.push(() => pool.end());
    const lockPool =
      opts.runtime === undefined
        ? undefined
        : createPool(database.targets.api_runtime, { max: 8, queryTimeoutMs: 30_000 });
    if (lockPool !== undefined) cleanup.push(() => lockPool.end());
    const bao =
      opts.runtime !== undefined
        ? switchableRuntime(opts.runtime)
        : opts.processOrganization === undefined
          ? undefined
          : organizationOnly(opts.processOrganization);
    const issuer = opts.runtime === undefined ? undefined : switchableIssuer(opts.runtime);
    let bootId = randomUUID();
    // Run 6.4 (P-116): with a runtime identity, the audited OpenBao call as on a host.
    const health = createHealthCheck(database.targets.api_runtime, undefined, {
      ...(opts.runtime === undefined || bao === undefined
        ? {}
        : { auditedCall: auditedBaoCall(bao) }),
    });
    cleanup.push(() => health.close());
    const logs: LogEntry[] = [];
    const keys = opts.keys ?? ephemeralKeys();
    const reached: string[] = [];
    const config: ApiConfig = {
      baseUrl: TEST_ORIGIN,
      build: releaseBuild,
      gatePath,
      hostInstanceId,
      trustedProxy: null,
      ...opts.config,
      backendIncarnation,
    };
    // Run 6.7 (P-122): one gate for both listeners, as in startServer.
    const gate = createServiceGate(config, pool);
    const build = () => {
      const auth = createAuth({ db: drizzle(pool), keys, baseURL: TEST_ORIGIN });
      const deps: AppDeps = {
        gate,
        pool,
        ...(lockPool === undefined ? {} : { lockPool }),
        ...(bao === undefined ? {} : { bao }),
        ...(issuer === undefined ? {} : { issuer }),
        bootId,
        config,
        health: () => health.check(),
        log: (entry) => logs.push(entry),
        limiter: testLimiter(pool, keys.rateLimit, opts.rateLimits),
        capacity: { read: (nowMs) => readCapacity(capacityPath, nowMs) },
        auth: { auth, keys, throttle: createThrottle({ pool, ring: keys.rateLimit }) },
        test: {
          ...(opts.routes === undefined ? {} : { routes: opts.routes }),
          ...(opts.stubs === "all" ? { stubAll: true } : {}),
          ...(opts.stubRoutes === undefined ? {} : { stubRoutes: new Set(opts.stubRoutes) }),
          ...(opts.beforeHandler === undefined ? {} : { beforeHandler: opts.beforeHandler }),
          ...(opts.importBudgetMs === undefined ? {} : { importBudgetMs: opts.importBudgetMs }),
          ...(opts.faults === undefined
            ? {}
            : {
                faults: async (point: string, operationId: string) => {
                  await opts.faults?.()?.(point, operationId);
                },
              }),
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
      };
      const app = createApp({ ...deps, listener: "public" });
      const verifyApp =
        opts.verifyListener === true ? createApp({ ...deps, listener: "verify" }) : null;
      return { auth, app, verifyApp };
    };
    let built = build();
    const tls = { certPath: database.stack.api.certPath, keyPath: database.stack.api.keyPath };
    let server: ApiServer = await listen(built.app, { hostname: "127.0.0.1", port: 0, tls });
    cleanup.push(() => server.close());
    const verifyServer =
      built.verifyApp === null
        ? null
        : await listen(built.verifyApp, { hostname: "127.0.0.1", port: 0, tls });
    if (verifyServer !== null) cleanup.push(() => verifyServer.close());
    if (opts.dispatcher !== false) {
      const dispatcher = startOutboxDispatcher(pool, (entry) => logs.push(entry));
      cleanup.push(() => dispatcher.stop());
    }
    const ca = readFileSync(database.stack.api.certAuthorityPath);

    const requestOn =
      (port: () => number) =>
      (method: string, path: string, init: RequestInit = {}): Promise<Response> =>
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
              port: port(),
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
    const request = requestOn(() => server.port);
    const verifyRequest = requestOn(() => {
      if (verifyServer === null) throw new Error("startTestApi: no verifyListener");
      return verifyServer.port;
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
      gate: { gatePath, hostInstanceId, backendIncarnation, releaseBuild },
      lockPool,
      get bootId() {
        return bootId;
      },
      async restart() {
        await server.close();
        bootId = randomUUID();
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
      setCapacity,
      request,
      verifyRequest,
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
