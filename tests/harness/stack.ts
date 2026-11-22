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
import type { DbTarget } from "@mykey/db";

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
  bao: {
    url: string;
    caCertPath: string;
    rootToken: string;
    /** Run 9.7: the recovery key of its init (absent in a stack.json written before). */
    recoveryKey?: string;
  };
  /**
   * A server certificate (names `api`, `localhost`, 127.0.0.1) signed by the
   * stack's CA, for an API that a test starts in its own process.
   */
  api: { certPath: string; keyPath: string; certAuthorityPath: string };
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

/** Run 6.1: a project's override files (infra/compose/dev/*.override.yml), kept beside its state. */
const overridesFile = (project: string): string =>
  join(stackDirectory(project), "compose-overrides.json");

function overridesOf(project: string): string[] {
  const file = overridesFile(project);
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, "utf8")) as string[]).map((name) =>
    join(REPOSITORY, "infra/compose/dev", name),
  );
}

function compose(
  project: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  maxBuffer?: number,
): Promise<string> {
  return run(
    "docker",
    [
      "compose",
      "-p",
      project,
      "-f",
      COMPOSE_FILE,
      ...overridesOf(project).flatMap((file) => ["-f", file]),
      ...args,
    ],
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
  // Bytes (a Raft snapshot) go as they are; anything else as JSON.
  const raw = init.body instanceof Uint8Array;
  const payload =
    init.body === undefined
      ? undefined
      : init.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : JSON.stringify(init.body);
  const headers: Record<string, string> = {};
  if (token !== "") headers["X-Vault-Token"] = token;
  if (init.namespace !== undefined) headers["X-Vault-Namespace"] = init.namespace;
  if (payload !== undefined) {
    headers["Content-Type"] = raw ? "application/octet-stream" : "application/json";
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
    const body = (await created.json()) as {
      root_token: string;
      recovery_keys_base64?: string[];
    };
    state.bao.rootToken = body.root_token;
    // Run 9.7 (R4-2): generate-root after a restore needs the source's recovery key.
    state.bao.recoveryKey = body.recovery_keys_base64?.[0] ?? "";
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
  /** Run 6.1: override files of infra/compose/dev (by file name), applied to every command. */
  overrides?: readonly string[];
}): Promise<Stack> {
  const project = opts?.project ?? `${TEST_PROJECT_PREFIX}${randomBytes(4).toString("hex")}`;
  const directory = stackDirectory(project);
  mkdirSync(directory, { recursive: true });
  if (opts?.overrides !== undefined && opts.overrides.length > 0) {
    writeFileSync(overridesFile(project), JSON.stringify(opts.overrides));
  }

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
      recoveryKey: previous?.bao.recoveryKey ?? "",
    },
    api: {
      certPath: join(directory, "api.crt"),
      keyPath: join(directory, "api.key"),
      certAuthorityPath: join(directory, "ca.crt"),
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
    await compose(project, ["cp", "postgres:/pki/api.crt", state.api.certPath]);
    await compose(project, ["cp", "postgres:/pki/api.key", state.api.keyPath]);
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
  await afterServiceStart(stack, service);
}

async function afterServiceStart(stack: Stack, service: "postgres" | "openbao"): Promise<void> {
  const state: StackState = {
    project: stack.project,
    pg: stack.pg,
    bao: stack.bao,
    api: stack.api,
  };
  await refreshPorts(state);
  if (service === "postgres") await waitForPostgres(stack);
  else {
    await waitForOpenBaoListener(stack);
    await waitForOpenBaoActive(stack);
  }
  writeState(state);
}

/** `docker compose stop`: the container is gone from the network until `startService`. */
export async function stopService(stack: Stack, service: "postgres" | "openbao"): Promise<void> {
  await compose(stack.project, ["stop", "--timeout", "10", service]);
}

/** `docker compose pause`: the processes are frozen; the kernel still accepts connections. */
export async function pauseService(stack: Stack, service: "postgres" | "openbao"): Promise<void> {
  await compose(stack.project, ["pause", service]);
}

/** `docker compose kill` (SIGKILL), also of a paused service. Start it again with startService. */
export async function killService(stack: Stack, service: "postgres" | "openbao"): Promise<void> {
  await compose(stack.project, ["kill", service]);
}

/** Run 6.1: runs a command inside a running service's container; answers its stdout. */
export function execInService(
  stack: Stack,
  service: "postgres" | "openbao",
  argv: readonly string[],
  opts: { user?: string } = {},
): Promise<string> {
  const user = opts.user === undefined ? [] : ["-u", opts.user];
  return compose(stack.project, ["exec", "-T", ...user, service, ...argv]);
}

/** Whether the service's container is running (not stopped, killed or paused). */
export async function serviceRunning(
  stack: Stack,
  service: "postgres" | "openbao",
): Promise<boolean> {
  const status = await stackStatus(stack.project);
  return status.services.some((entry) => entry.service === service && entry.state === "running");
}

/** Starts a stopped service and waits until it answers. Its published port may have changed. */
export async function startService(stack: Stack, service: "postgres" | "openbao"): Promise<void> {
  await compose(stack.project, ["start", service]);
  await afterServiceStart(stack, service);
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

/**
 * A plain-format `pg_dump` of one database, made inside the PostgreSQL
 * container. The superuser password travels in the environment of the docker
 * client, never in an argument. The dump is returned, never printed.
 */
export async function pgDump(stack: Stack, database: string): Promise<string> {
  return compose(
    stack.project,
    [
      "exec",
      "-T",
      "-e",
      "PGPASSWORD",
      "postgres",
      "pg_dump",
      "-U",
      stack.pg.superuser.user,
      "-d",
      database,
      "--no-owner",
    ],
    { PGPASSWORD: stack.pg.superuser.password },
    256 * 1024 * 1024,
  );
}

/** The PostgreSQL container's log since `since` (RFC 3339). Returned, never printed. */
/** Run 6.1: a service container's log (stdout and stderr) since `since`. */
export function serviceLog(
  stack: Stack,
  service: "postgres" | "openbao",
  since: string,
): Promise<string> {
  return compose(
    stack.project,
    ["logs", "--no-color", "--since", since, service],
    undefined,
    64 * 1024 * 1024,
  );
}

export async function postgresLog(stack: Stack, since: string): Promise<string> {
  return compose(
    stack.project,
    ["logs", "--no-color", "--since", since, "postgres"],
    undefined,
    64 * 1024 * 1024,
  );
}

/**
 * Copies database `from` into the existing database `to` with
 * `pg_dump --format=custom | pg_restore --exit-on-error`, inside the
 * PostgreSQL container, as the superuser. Throws when pg_restore fails.
 */
export async function copyDatabase(stack: Stack, from: string, to: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(from) || !/^[a-z0-9_]+$/.test(to))
    throw new Error("invalid database name");
  const user = stack.pg.superuser.user;
  await compose(
    stack.project,
    [
      "exec",
      "-T",
      "-e",
      "PGPASSWORD",
      "postgres",
      "sh",
      "-c",
      `pg_dump -U ${user} -d ${from} --format=custom | pg_restore -U ${user} -d ${to} --exit-on-error`,
    ],
    { PGPASSWORD: stack.pg.superuser.password },
  );
}

/** `pg_dump --format=custom` of one database into a local file (through the container). */
export async function pgDumpToFile(
  stack: Stack,
  database: string,
  localPath: string,
): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error("invalid database name");
  const inside = `/tmp/${database}.dump`;
  await compose(
    stack.project,
    [
      "exec",
      "-T",
      "-e",
      "PGPASSWORD",
      "postgres",
      "pg_dump",
      "-U",
      stack.pg.superuser.user,
      "-d",
      database,
      "--format=custom",
      "-f",
      inside,
    ],
    { PGPASSWORD: stack.pg.superuser.password },
  );
  await compose(stack.project, ["cp", `postgres:${inside}`, localPath]);
  await compose(stack.project, ["exec", "-T", "postgres", "rm", "-f", inside]);
}

/** `pg_dumpall --globals-only --no-role-passwords` into a local file. */
export async function pgGlobalsToFile(stack: Stack, localPath: string): Promise<void> {
  const inside = "/tmp/globals.sql";
  await compose(
    stack.project,
    [
      "exec",
      "-T",
      "-e",
      "PGPASSWORD",
      "postgres",
      "pg_dumpall",
      "-U",
      stack.pg.superuser.user,
      "--globals-only",
      "--no-role-passwords",
      "-f",
      inside,
    ],
    { PGPASSWORD: stack.pg.superuser.password },
  );
  await compose(stack.project, ["cp", `postgres:${inside}`, localPath]);
  await compose(stack.project, ["exec", "-T", "postgres", "rm", "-f", inside]);
}

/** `pg_restore --exit-on-error` of a local custom-format dump into an existing database. */
export async function pgRestoreFromFile(
  stack: Stack,
  localPath: string,
  database: string,
  /** Run 6.7: "postgres-scratch" (scratch-pg.override.yml) restores into the second cluster. */
  service: "postgres" | "postgres-scratch" = "postgres",
): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error("invalid database name");
  const inside = `/tmp/restore-${database}.dump`;
  await compose(stack.project, ["cp", localPath, `${service}:${inside}`]);
  try {
    await compose(
      stack.project,
      [
        "exec",
        "-T",
        "-e",
        "PGPASSWORD",
        service,
        "pg_restore",
        "-U",
        stack.pg.superuser.user,
        "-d",
        database,
        "--exit-on-error",
        inside,
      ],
      { PGPASSWORD: stack.pg.superuser.password },
    );
  } finally {
    await compose(stack.project, ["exec", "-T", "-u", "0", service, "rm", "-f", inside]);
  }
}

/**
 * Run 6.7 Task C: the second cluster of a stack started with
 * scratch-pg.override.yml, as its superuser (the stack's superuser password:
 * the same secret file). Waits until it accepts a connection.
 */
export async function scratchPg(stack: Stack): Promise<DbTarget> {
  const target: DbTarget = {
    host: HOST,
    port: await publishedPort(stack.project, "postgres-scratch", 5432),
    database: "postgres",
    user: stack.pg.superuser.user,
    password: stack.pg.superuser.password,
    caCertPath: stack.pg.caCertPath,
  };
  await waitFor("the scratch PostgreSQL", async () => {
    const client = new pg.Client({
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.user,
      password: target.password,
      ssl: { ca: readFileSync(target.caCertPath, "utf8"), rejectUnauthorized: true },
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return true;
    } catch {
      return false;
    } finally {
      await client.end().catch(() => undefined);
    }
  });
  return target;
}

/**
 * Run 6.5: the scratch OpenBao of a stack started with
 * `scratch-bao.override.yml` (the same pki volume: the same static seal key
 * and certificate). Initialised on first use. `restore` replaces its whole
 * state with a Raft snapshot of the stack's own OpenBao and waits until it is
 * active again; from then on the stack's root token is its root token.
 */
export interface ScratchBao {
  /** The scratch as a Stack whose `bao` is the scratch (for baoFetch and friends). */
  stack: Stack;
  /** Its own root token and recovery key, from its init (before any restore). */
  own: { rootToken: string; recoveryKey: string };
  /** snapshot-force with `token` (the instance's current root token by default). */
  restore(snapshot: Uint8Array, token?: string): Promise<void>;
}

export async function scratchBao(stack: Stack): Promise<ScratchBao> {
  const state = {
    ...stack,
    bao: {
      ...stack.bao,
      url: `https://${HOST}:${await publishedPort(stack.project, "openbao-scratch", 8200)}`,
      rootToken: "",
    },
  } as unknown as StackState;
  await waitForOpenBaoListener(state);
  await initialiseOpenBao(state);
  await waitForOpenBaoActive(state);
  const own = { rootToken: state.bao.rootToken, recoveryKey: state.bao.recoveryKey ?? "" };
  return {
    stack: state as unknown as Stack,
    own,
    async restore(snapshot, token) {
      const response = await baoRequest(state, "/v1/sys/storage/raft/snapshot-force", {
        method: "POST",
        body: snapshot,
        ...(token === undefined ? {} : { token }),
      });
      if (response.status !== 204 && response.status !== 200) {
        throw new Error(`snapshot-force returned HTTP ${String(response.status)}`);
      }
      state.bao.rootToken = stack.bao.rootToken;
      // The node reloads the restored state (its audit device included: the
      // override gives it a writable directory) and stays unsealed.
      await waitForOpenBaoActive(state);
    },
  };
}

/**
 * Run 6.7 Task C (P-124 step 4): a new scratch OpenBao — its container and
 * volume removed, started again and initialised anew on the same static seal.
 * A restore's snapshot then goes into an instance no earlier restore touched.
 */
export async function freshScratchBao(stack: Stack): Promise<ScratchBao> {
  await compose(stack.project, ["rm", "--stop", "--force", "openbao-scratch"]);
  await run("docker", ["volume", "rm", "--force", `${stack.project}_baoscratch`]);
  await compose(stack.project, ["up", "--detach", "openbao-scratch"]);
  return scratchBao(stack);
}
