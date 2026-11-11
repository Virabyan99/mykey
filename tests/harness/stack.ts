// Test harness for the local stack: real PostgreSQL 18 and real OpenBao in
// Docker, started from infra/compose/dev.compose.yml. Used by every
// integration and fault test, by `pnpm run stack:*`, and by CI.
//
// Everything this file handles is synthetic, development-only material. It is
// still never printed: no password or token goes to a log or an error message.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import pg from "pg";

export interface Stack {
  /** Compose project name, unique per stack. */
  project: string;
  pg: {
    host: string;
    port: number;
    database: string;
    superuser: { user: string; password: string };
    caCertPath: string;
  };
  bao: { url: string; caCertPath: string; rootToken: string };
  /** `docker compose down -v` and removal of `.stack/<project>`. */
  stop(): Promise<void>;
}

type StackState = Omit<Stack, "stop">;

const REPOSITORY = resolve(import.meta.dirname, "../..");
const COMPOSE_FILE = join(REPOSITORY, "infra/compose/dev.compose.yml");
const STACK_ROOT = join(REPOSITORY, ".stack");
const SHARED_STACK_VARIABLE = "MYKEY_SHARED_STACK";
export const DEV_PROJECT = "mykey-dev";
export const TEST_PROJECT_PREFIX = "mykey-t-";
const DEV_PORTS = { postgres: 54320, openbao: 8200 };
const HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 180_000;

export function stackDirectory(project: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project)) {
    throw new Error("invalid stack project name");
  }
  return join(STACK_ROOT, project);
}

function run(
  file: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  maxBuffer = 16 * 1024 * 1024,
): Promise<string> {
  return new Promise((resolveRun, reject) => {
    execFile(
      file,
      args,
      { env: { ...process.env, ...env }, maxBuffer, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) resolveRun(stdout);
        else reject(new Error(`${file} ${args.slice(0, 6).join(" ")} failed: ${stderr.trim()}`));
      },
    );
  });
}

function compose(
  project: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  maxBuffer?: number,
): Promise<string> {
  return run(
    "docker",
    ["compose", "-p", project, "-f", COMPOSE_FILE, ...args],
    // The Compose file needs the state directory even for commands that do not start anything.
    { MYKEY_STACK_DIR: stackDirectory(project), ...env },
    maxBuffer,
  );
}

async function publishedPort(project: string, service: string, port: number): Promise<number> {
  const output = await compose(project, ["port", service, String(port)]);
  const match = /:(\d+)\s*$/.exec(output.trim());
  if (match?.[1] === undefined) throw new Error(`no published port for ${service}`);
  return Number(match[1]);
}

function superuserClient(state: StackState, database: string): pg.Client {
  return new pg.Client({
    host: state.pg.host,
    port: state.pg.port,
    database,
    user: state.pg.superuser.user,
    password: state.pg.superuser.password,
    ssl: { ca: readFileSync(state.pg.caCertPath, "utf8"), rejectUnauthorized: true },
    connectionTimeoutMillis: 5_000,
  });
}

async function waitFor(what: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      if (await probe()) return;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function waitForPostgres(state: StackState): Promise<void> {
  await waitFor("PostgreSQL", async () => {
    const client = superuserClient(state, state.pg.database);
    // A failed attempt can emit a late socket error; it must not crash the process.
    client.on("error", () => undefined);
    try {
      await client.connect();
      await client.query("SELECT 1");
      return true;
    } finally {
      await client.end().catch(() => undefined);
    }
  });
}

interface BaoRequest {
  method?: string;
  body?: unknown;
  namespace?: string;
  token?: string;
  /** Extra request headers; a `content-type` here replaces `application/json`. */
  headers?: Record<string, string>;
}

function baoRequest(
  state: { bao: { url: string; caCertPath: string; rootToken: string } },
  path: string,
  init: BaoRequest = {},
): Promise<Response> {
  const url = new URL(path, state.bao.url);
  const token = init.token ?? state.bao.rootToken;
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  const headers: Record<string, string> = {};
  if (token !== "") headers["X-Vault-Token"] = token;
  if (init.namespace !== undefined) headers["X-Vault-Namespace"] = init.namespace;
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (name.toLowerCase() === "content-type") delete headers["Content-Type"];
    headers[name] = value;
  }
  return new Promise((resolveRequest, reject) => {
    const request = https.request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers,
        ca: readFileSync(state.bao.caCertPath),
        timeout: 15_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const body = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === "string") responseHeaders.set(name, value);
          }
          const noBody = status === 204 || status === 304 || body.length === 0;
          resolveRequest(
            new Response(noBody ? null : new Uint8Array(body), {
              status,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("OpenBao request timed out")));
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

/** One HTTPS request to OpenBao with CA verification. Defaults to the root token. */
export function baoFetch(stack: Stack, path: string, init?: BaoRequest): Promise<Response> {
  return baoRequest(stack, path, init);
}

async function waitForOpenBaoListener(state: StackState): Promise<void> {
  await waitFor("the OpenBao listener", async () => {
    const response = await baoRequest(state, "/v1/sys/seal-status", { token: "" });
    return response.status === 200;
  });
}

async function waitForOpenBaoActive(state: StackState): Promise<void> {
  await waitFor("OpenBao to unseal and become active", async () => {
    const response = await baoRequest(state, "/v1/sys/health", { token: "" });
    return response.status === 200;
  });
}

async function initialiseOpenBao(state: StackState): Promise<void> {
  const init = await baoRequest(state, "/v1/sys/init", { token: "" });
  const { initialized } = (await init.json()) as { initialized: boolean };
  if (!initialized) {
    const created = await baoRequest(state, "/v1/sys/init", {
      method: "PUT",
      token: "",
      body: { recovery_shares: 1, recovery_threshold: 1 },
    });
    if (created.status !== 200) throw new Error(`OpenBao init returned HTTP ${created.status}`);
    const body = (await created.json()) as { root_token: string };
    state.bao.rootToken = body.root_token;
  } else if (state.bao.rootToken === "") {
    throw new Error("OpenBao is initialised but its root token is not in stack.json; reset it");
  }
}

function writeState(state: StackState): void {
  writeFileSync(join(stackDirectory(state.project), "stack.json"), JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

function readState(project: string): StackState | undefined {
  const file = join(stackDirectory(project), "stack.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as StackState;
}

async function refreshPorts(state: StackState): Promise<void> {
  state.pg.port = await publishedPort(state.project, "postgres", 5432);
  state.bao.url = `https://${HOST}:${await publishedPort(state.project, "openbao", 8200)}`;
}

async function removeStack(project: string): Promise<void> {
  const directory = stackDirectory(project);
  mkdirSync(directory, { recursive: true });
  await compose(project, ["down", "-v", "--remove-orphans", "--timeout", "5"]);
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function attach(state: StackState): Stack {
  return { ...state, stop: () => removeStack(state.project) };
}

/**
 * Starts a stack. Without options: a new project `mykey-t-<8 hex>` on
 * ephemeral host ports. `pnpm run stack:up` uses `{ project: "mykey-dev",
 * fixedPorts: true }`. Starting a project that is already up is safe.
 */
export async function startStack(opts?: {
  project?: string;
  fixedPorts?: boolean;
}): Promise<Stack> {
  const project = opts?.project ?? `${TEST_PROJECT_PREFIX}${randomBytes(4).toString("hex")}`;
  const directory = stackDirectory(project);
  mkdirSync(directory, { recursive: true });

  const passwordFile = join(directory, "pg-superuser-password");
  if (!existsSync(passwordFile)) {
    writeFileSync(passwordFile, randomBytes(24).toString("base64url"), { mode: 0o600 });
  }
  const previous = readState(project);
  const state: StackState = {
    project,
    pg: {
      host: HOST,
      port: 0,
      database: "postgres",
      superuser: { user: "postgres", password: readFileSync(passwordFile, "utf8") },
      caCertPath: join(directory, "ca.crt"),
    },
    bao: {
      url: "",
      caCertPath: join(directory, "ca.crt"),
      rootToken: previous?.bao.rootToken ?? "",
    },
  };

  const fixed = opts?.fixedPorts === true;
  try {
    await compose(project, ["up", "-d", "--quiet-pull"], {
      MYKEY_PG_PORT: fixed ? String(DEV_PORTS.postgres) : "0",
      MYKEY_BAO_PORT: fixed ? String(DEV_PORTS.openbao) : "0",
    });
    await refreshPorts(state);
    await compose(project, ["cp", "postgres:/pki/ca.crt", state.pg.caCertPath]);
    await waitForPostgres(state);
    await waitForOpenBaoListener(state);
    await initialiseOpenBao(state);
    await waitForOpenBaoActive(state);
    // The audit device is declared in openbao.hcl; the correlation headers can only
    // be registered through the API. Idempotent, so it runs on every start.
    await new OpenBaoAdmin(state.bao, state.bao.rootToken).registerAuditHeaders();
    writeState(state);
  } catch (error) {
    if (previous === undefined) await removeStack(project).catch(() => undefined);
    throw error;
  }
  return attach(state);
}

/** The stack started by tests/harness/global-setup.ts for this test run. */
export function getSharedStack(): Promise<Stack> {
  const project = process.env[SHARED_STACK_VARIABLE];
  if (project === undefined || project === "") {
    return Promise.reject(
      new Error("no shared stack: integration tests must run through `pnpm run test:integration`"),
    );
  }
  const state = readState(project);
  if (state === undefined) return Promise.reject(new Error("shared stack state is missing"));
  return Promise.resolve(attach(state));
}

export function announceSharedStack(stack: Stack): void {
  process.env[SHARED_STACK_VARIABLE] = stack.project;
}

/** A new empty database in the stack's PostgreSQL; `drop()` removes it, even with open sessions. */
export async function freshDatabase(
  stack: Stack,
): Promise<{ database: string; drop(): Promise<void> }> {
  const database = `t_${randomBytes(6).toString("hex")}`;
  const withAdmin = async (sql: string): Promise<void> => {
    const client = superuserClient(stack, stack.pg.database);
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  // The name is generated above from hex characters only, so it is safe to inline.
  await withAdmin(`CREATE DATABASE ${database}`);
  return { database, drop: () => withAdmin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`) };
}

/** A new OpenBao namespace; `drop()` deletes it and waits until it is gone. */
export async function freshNamespace(
  stack: Stack,
): Promise<{ path: string; drop(): Promise<void> }> {
  const path = `t-${randomBytes(6).toString("hex")}`;
  const created = await baoFetch(stack, `/v1/sys/namespaces/${path}`, { method: "POST" });
  if (created.status !== 200) throw new Error(`namespace create returned HTTP ${created.status}`);
  return {
    path,
    drop: async () => {
      const removed = await baoFetch(stack, `/v1/sys/namespaces/${path}`, { method: "DELETE" });
      if (![200, 202, 204, 404].includes(removed.status)) {
        throw new Error(`namespace delete returned HTTP ${removed.status}`);
      }
      await waitFor("namespace deletion", async () => {
        const lookup = await baoFetch(stack, `/v1/sys/namespaces/${path}`);
        return lookup.status === 404;
      });
    },
  };
}

/**
 * Mounts a KV v2 engine and waits until it serves. A new KV v2 mount answers
 * HTTP 400 ("Upgrading from non-versioned to versioned data") for a moment
 * after it is created; anything that configures or writes straight away must
 * wait for that to pass.
 */
export async function mountKvV2(stack: Stack, namespace: string, mount = "kv"): Promise<void> {
  const created = await baoFetch(stack, `/v1/sys/mounts/${mount}`, {
    method: "POST",
    namespace,
    body: { type: "kv", options: { version: "2" } },
  });
  if (created.status !== 204) throw new Error(`KV mount returned HTTP ${created.status}`);
  await waitFor("the KV v2 mount to finish its upgrade", async () => {
    const config = await baoFetch(stack, `/v1/${mount}/config`, { namespace });
    return config.status === 200;
  });
}

/** Restarts one service and waits until it serves again. Ports may change; `stack` is updated. */
export async function restartService(stack: Stack, service: "postgres" | "openbao"): Promise<void> {
  await compose(stack.project, ["restart", "--timeout", "10", service]);
  // stack.pg and stack.bao are shared by reference, so the new ports land on `stack`.
  const state: StackState = { project: stack.project, pg: stack.pg, bao: stack.bao };
  await refreshPorts(state);
  if (service === "postgres") await waitForPostgres(stack);
  else {
    await waitForOpenBaoListener(stack);
    await waitForOpenBaoActive(stack);
  }
  writeState(state);
}

export interface AuditEntry {
  type: "request" | "response";
  /** e.g. "org-<uuid>/"; "" for the root namespace. */
  namespacePath: string;
  path: string;
  operation: string;
  /** Audited request headers (lower-case names), as OpenBao recorded them. */
  headers: Record<string, string[]>;
  /** The JSON line exactly as written. */
  raw: string;
}

const AUDIT_FILE = "/openbao/audit/audit.log";

/**
 * Every request and response entry of the stack's file audit device, in order.
 * The file holds HMACs of tokens, not tokens; it is still never printed.
 */
export async function readAuditLog(stack: Stack): Promise<AuditEntry[]> {
  const output = await compose(
    stack.project,
    ["exec", "-T", "openbao", "cat", AUDIT_FILE],
    undefined,
    512 * 1024 * 1024,
  );
  const entries: AuditEntry[] = [];
  const lines = output.split("\n");
  // Suites share one stack and run in parallel: OpenBao may be writing the last
  // line right now. A final segment without its newline is not an entry yet.
  lines.pop();
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    const line = JSON.parse(raw) as {
      type?: string;
      request?: {
        path?: string;
        operation?: string;
        namespace?: { path?: string };
        headers?: Record<string, string[]>;
      };
    };
    if (line.type !== "request" && line.type !== "response") continue;
    entries.push({
      type: line.type,
      namespacePath: line.request?.namespace?.path ?? "",
      path: line.request?.path ?? "",
      operation: line.request?.operation ?? "",
      headers: line.request?.headers ?? {},
      raw,
    });
  }
  return entries;
}

export interface StackStatus {
  project: string;
  services: { service: string; state: string; health: string }[];
}

export async function stackStatus(project: string): Promise<StackStatus> {
  mkdirSync(stackDirectory(project), { recursive: true });
  const output = await compose(project, ["ps", "--all", "--format", "json"]);
  const rows = output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => JSON.parse(line) as ComposePsRow | ComposePsRow[]);
  return {
    project,
    services: rows.map((row) => ({
      service: row.Service,
      state: row.State,
      health: row.Health === "" ? "-" : row.Health,
    })),
  };
}

interface ComposePsRow {
  Service: string;
  State: string;
  Health: string;
}

/** Every Compose project this harness may have created: `mykey-dev` and `mykey-t-*`. */
export async function listStackProjects(): Promise<string[]> {
  const output = await run("docker", ["compose", "ls", "--all", "--format", "json"]);
  const fromDocker = (JSON.parse(output) as { Name: string }[]).map((row) => row.Name);
  return fromDocker.filter((name) => name === DEV_PROJECT || name.startsWith(TEST_PROJECT_PREFIX));
}

export async function stopStack(project: string): Promise<void> {
  await removeStack(project);
}
