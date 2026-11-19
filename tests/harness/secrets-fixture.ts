// The fixture of the secret suites (Run 4.2): the tenants of Run 3.7 with
// organization A provisioned through the product and its environments made
// active by the real provisioner; an API holding A's runtime identity (inline
// AppRole, D-34) whose every OpenBao call passes a TLS relay; optionally a
// second API process on the same database, keys, gate and credential.
//
// Values never leave the helpers but as SHA-256 digests and lengths: a
// failing assertion can print a digest, never a value (Doc 10 §4.1 rule 2).
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { createLargeGate, readDeps, recheckOf, refusedOf, type Handler } from "@mykey/api";
import { appendAudit } from "@mykey/audit";
import { generateKeyFiles, loadAuthKeys } from "@mykey/auth";
import {
  LIMITS,
  ROUTES,
  type EnvironmentId,
  type ErrorCode,
  type ProjectId,
  type RouteDef,
} from "@mykey/contracts";
import type { EnvironmentScope } from "@mykey/db";
import { readEnvironment } from "@mykey/operations";
import { z } from "zod";
import { OpenBaoClient, environmentPrefix, secretPath, type OpenBaoTarget } from "@mykey/openbao";
import {
  createProvisioningFixture,
  type ProvisioningFixture,
} from "../integration/provisioning/fixture.ts";
import { TEST_ORIGIN, requestTo, type FaultHook, type TestApi } from "./api.ts";
import type { FaultAction } from "./api-process.ts";
import { startApiProcess, type ApiProcess } from "./api-worker.ts";
import { readAuditLog, type Stack } from "./stack.ts";
import type { FixtureUser, Tenants } from "./tenants.ts";
import { startTlsRelay, type TlsRelay } from "./tls-relay.ts";

export interface Answer {
  status: number;
  body: Record<string, unknown>;
  code: string | undefined;
  operationId: string | undefined;
  /** `error.details` of a refusal (allowlisted by code). */
  details: Record<string, unknown> | undefined;
  /** The raw body text (for searching it for a canary). */
  text: string;
  headers: Headers;
}

export type EnvName = "env1a" | "env1b" | "env2a";

export interface BackendVersion {
  version: number;
  deleted: boolean;
  destroyed: boolean;
  /** The envelope's operation id; null when the version cannot be read (deleted, destroyed). */
  operationId: string | null;
  /** SHA-256 hex of the value; null when unreadable. */
  digest: string | null;
  bytes: number | null;
}

export interface SecretsFixture {
  fx: ProvisioningFixture;
  api: TestApi;
  stack: Stack;
  tenants: Tenants;
  relay: TlsRelay;
  second: ApiProcess | null;
  /** Ids of an environment of A, with its project. */
  env(name: EnvName): { projectId: ProjectId; environmentId: EnvironmentId; path: string };
  /** In-process API faults (null clears). */
  setFaults(hook: FaultHook | null): void;
  /** Runs after the pipeline, before the handler (the admission recheck; null clears). */
  setBeforeHandler(
    hook: ((routeId: string, info: { handled: boolean }) => Promise<void>) | null,
  ): void;
  /** The in-process API's import budget per request in ms (null: the product's). */
  setImportBudget(ms: number | null): void;
  /** Where the in-process API reaches OpenBao: through the relay, or a closed port. */
  setBao(target: "relay" | "closed"): void;
  /**
   * Run 5.2: the relay's next connections go to a closed port (true) or to
   * OpenBao again (false): a call through it is never made (status 0), while a
   * client already logged in keeps its target.
   */
  setUpstreamClosed(closed: boolean): Promise<void>;
  /** Restarts the second process with a fault (or none). */
  restartSecond(
    fault?: { point: string; action: FaultAction },
    opts?: { archiveTick?: { intervalMs: number; staleSeconds: number } },
  ): Promise<ApiProcess>;
  send(
    method: string,
    path: string,
    opts?: {
      user?: FixtureUser;
      body?: unknown;
      /** A text/plain body (a dotenv file, Run 4.7) instead of JSON. */
      text?: string | Uint8Array;
      key?: string | null;
      to?: "first" | "second";
    },
  ): Promise<Answer>;
  create(
    env: EnvName,
    name: string,
    value: string,
    opts?: { user?: FixtureUser; key?: string; to?: "first" | "second" },
  ): Promise<Answer>;
  update(
    env: EnvName,
    name: string,
    value: string,
    expected: { version: number; stateTag: string },
    opts?: { user?: FixtureUser; key?: string; to?: "first" | "second" },
  ): Promise<Answer>;
  /**
   * delete, undelete or restore (Run 4.4) with the expected version and tag;
   * `confirmed` defaults to true (null leaves it out).
   */
  act(
    env: EnvName,
    name: string,
    kind: "delete" | "undelete" | "restore",
    expected: { version: number; stateTag: string },
    opts?: {
      user?: FixtureUser;
      key?: string;
      to?: "first" | "second";
      sourceVersion?: number;
      confirmed?: boolean | null;
    },
  ): Promise<Answer>;
  /** The operator's view of a secret (root token): metadata and per-version digests, never values. */
  backend(
    env: EnvName,
    name: string,
  ): Promise<{ currentVersion: number; versions: BackendVersion[] } | null>;
  /** Where the API's credential files are (runtime and issuer). */
  secretsDirectory: string;
  /** The auth key rings' directory (Run 6.7: a restored product uses the lost host's keys). */
  keysDirectory: string;
  /** The operator client of A's namespace (root token): for writing past the product. */
  operatorBao(): OpenBaoClient;
  /** Requests the audit device recorded that change KV and carry this operation id. */
  auditedChanges(operationId: string): Promise<number>;
  indexRow(env: EnvName, name: string): Promise<IndexRowView | null>;
  /**
   * Index rows only, through the superuser (Run 4.3): for cases that never
   * touch the backend. Version 1, no live bytes, counters unchanged.
   */
  seedIndex(
    env: EnvName,
    names: readonly string[],
    state?: "live" | "deleted" | "needs_review",
  ): Promise<void>;
  /** Removes rows seedIndex wrote. */
  unseedIndex(env: EnvName, names: readonly string[]): Promise<void>;
  /**
   * Run 4.8: `names` live keys of `bytesEach` bytes each, named SEED_0000 …:
   * values through the operator client, index rows and counters through the
   * superuser. The environment must hold none of these names.
   */
  seedEnvironment(env: EnvName, names: number, bytesEach: number): Promise<void>;
  close(): Promise<void>;
}

export interface IndexRowView {
  current_version: number | null;
  state_tag: string;
  state: string;
  live_value_bytes: number;
  last_operation_id: string | null;
}

export const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** A JSON object answer; anything else (empty, not JSON) is `{}`. */
function parseObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = text === "" ? {} : JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

export async function createSecretsFixture(
  opts: {
    private?: boolean;
    processes?: 1 | 2;
    /** Run 5.4: "broken" delivers a runtime secret id OpenBao refuses. */
    runtime?: "ok" | "broken";
    /** More test-only routes (Run 5.1). */
    routes?: readonly { def: RouteDef; handler: Handler }[];
    /** Run 6.1: override files of the private stack (with `private`). */
    stackOverrides?: readonly string[];
    /** Run 6.3: the product's rate limits in both processes (default: never refusing). */
    rateLimits?: "product";
    /** Run 7.3: the built workspace the in-process API serves (the browser project). */
    webDirectory?: string;
  } = {},
): Promise<SecretsFixture> {
  const directory = mkdtempSync(join(tmpdir(), "mykey-secrets-"));
  const secretsDirectory = join(directory, "secrets");
  mkdirSync(secretsDirectory);
  const keysDirectory = join(directory, "keys");
  mkdirSync(keysDirectory);
  generateKeyFiles(keysDirectory);
  let current: OpenBaoTarget | null = null;
  let faults: FaultHook | null = null;
  let beforeHandler: ((routeId: string, info: { handled: boolean }) => Promise<void>) | null = null;
  let importBudget: number | null = null;
  const fx = await createProvisioningFixture({
    shared: opts.private !== true,
    ...(opts.stackOverrides === undefined ? {} : { stackOverrides: opts.stackOverrides }),
    api: (stack) => {
      current = stack.bao;
      return {
        runtime: { openBao: () => current ?? stack.bao, secretsDirectory },
        keys: loadAuthKeys(keysDirectory),
        faults: () => faults ?? undefined,
        beforeHandler: async (routeId: string, info: { handled: boolean }) => {
          await beforeHandler?.(routeId, info);
        },
        importBudgetMs: () => importBudget ?? undefined,
        ...(opts.rateLimits === undefined ? {} : { rateLimits: opts.rateLimits }),
        ...(opts.webDirectory === undefined ? {} : { config: { webDirectory: opts.webDirectory } }),
        routes: [{ def: TEST_READ_ROUTE, handler: testReadHandler() }, ...(opts.routes ?? [])],
      };
    },
  });
  const { api, stack, tenants } = fx;
  // Asked per connection: OpenBao restarted by a fault test may come back on another port.
  let upstreamClosed: number | null = null;
  const relay = await startTlsRelay(() => {
    if (upstreamClosed !== null) return { host: "127.0.0.1", port: upstreamClosed };
    const baoUrl = new URL(stack.bao.url);
    return { host: baoUrl.hostname, port: Number(baoUrl.port) };
  }, "pass");
  const relayTarget: OpenBaoTarget = {
    url: `https://127.0.0.1:${String(relay.port)}`,
    caCertPath: stack.bao.caCertPath,
  };
  current = relayTarget;
  const closedTarget: OpenBaoTarget = {
    url: `https://127.0.0.1:${String(await closedPort())}`,
    caCertPath: stack.bao.caCertPath,
  };

  // The tenants' environments of A become active through the real job.
  const provisioner = await fx.start();
  try {
    for (const id of [tenants.a.env1a, tenants.a.env1b, tenants.a.env2a]) {
      await fx.waitFor(id, "active", 120_000);
    }
  } finally {
    await provisioner.stop();
  }
  // The runtime credential, delivered the way the host delivers it.
  writeFileSync(join(secretsDirectory, "organization-id"), tenants.a.organizationId);
  writeFileSync(join(secretsDirectory, "runtime-role-id"), fx.credentials.runtime.roleId);
  writeFileSync(
    join(secretsDirectory, "runtime-secret-id"),
    opts.runtime === "broken" ? randomUUID() : fx.credentials.runtime.secretId,
  );
  // Run 5.1 (P-85): the issuer credential beside it, as the host installs it.
  writeFileSync(join(secretsDirectory, "issuer-role-id"), fx.credentials.issuer.roleId);
  writeFileSync(join(secretsDirectory, "issuer-secret-id"), fx.credentials.issuer.secretId);

  const tls = { certPath: stack.api.certPath, keyPath: stack.api.keyPath };
  const ca = readFileSync(stack.api.certAuthorityPath);
  const startSecond = (
    fault?: { point: string; action: FaultAction },
    extra: { archiveTick?: { intervalMs: number; staleSeconds: number } } = {},
  ) =>
    startApiProcess(api.database.targets.api_runtime, {
      keysDirectory,
      api: {
        baseUrl: TEST_ORIGIN,
        build: api.gate.releaseBuild,
        gatePath: api.gate.gatePath,
        hostInstanceId: api.gate.hostInstanceId,
        backendIncarnation: api.gate.backendIncarnation,
        trustedProxy: null,
      },
      tls,
      openBao: relayTarget,
      secretsDirectory,
      ...(fault === undefined ? {} : { faults: fault }),
      ...(opts.rateLimits === undefined ? {} : { rateLimits: opts.rateLimits }),
      ...extra,
    });
  let second: ApiProcess | null = opts.processes === 2 ? await startSecond() : null;

  const ids = (name: EnvName) => {
    const projectId = (name === "env2a" ? tenants.a.project2 : tenants.a.project1) as ProjectId;
    const environmentId = tenants.a[name] as EnvironmentId;
    return {
      projectId,
      environmentId,
      path: `/v1/organizations/${tenants.a.organizationId}/projects/${projectId}/environments/${environmentId}`,
    };
  };
  const operator = () =>
    new OpenBaoClient(stack.bao, { namespace: fx.namespace, token: stack.bao.rootToken });

  const fixture: SecretsFixture = {
    fx,
    api,
    stack,
    tenants,
    relay,
    get second() {
      return second;
    },
    env: ids,
    secretsDirectory,
    keysDirectory,
    setBeforeHandler(hook) {
      beforeHandler = hook;
    },
    setFaults(hook) {
      faults = hook;
    },
    setImportBudget(ms) {
      importBudget = ms;
    },
    setBao(target) {
      current = target === "relay" ? relayTarget : closedTarget;
    },
    async setUpstreamClosed(closed) {
      upstreamClosed = closed ? await closedPort() : null;
    },
    async restartSecond(fault, extra) {
      await second?.kill();
      second = await startSecond(fault, extra);
      return second;
    },
    async send(method, path, init = {}) {
      const cookie = await tenants.cookie(init.user ?? "ownerA");
      const headers: Record<string, string> =
        init.key === null ? {} : { "idempotency-key": init.key ?? randomUUID() };
      if (init.text !== undefined) headers["content-type"] = "text/plain; charset=utf-8";
      const request = {
        cookie,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.text === undefined ? {} : { rawBody: init.text }),
      };
      let response: Response;
      if (init.to === "second") {
        if (second === null) throw new Error("no second API process");
        response = await requestTo({ port: second.port, ca }, method, path, request);
      } else {
        response = await api.request(method, path, request);
      }
      const text = await response.text();
      const body = parseObject(text);
      const error = body.error as
        { code?: string; operationId?: string; details?: Record<string, unknown> } | undefined;
      return {
        status: response.status,
        body,
        code: error?.code,
        operationId: error?.operationId ?? (body.operationId as string | undefined),
        details: error?.details,
        text,
        headers: response.headers,
      };
    },
    create(env, name, value, init = {}) {
      return fixture.send("POST", `${ids(env).path}/secrets`, {
        body: { name, value },
        ...init,
      });
    },
    update(env, name, value, expected, init = {}) {
      return fixture.send("PATCH", `${ids(env).path}/secrets/${name}`, {
        body: { value, expectedVersion: expected.version, expectedStateTag: expected.stateTag },
        ...init,
      });
    },
    act(env, name, kind, expected, init = {}) {
      const { sourceVersion, confirmed, ...opts } = init;
      return fixture.send("POST", `${ids(env).path}/secrets/${name}/${kind}`, {
        body: {
          expectedVersion: expected.version,
          expectedStateTag: expected.stateTag,
          ...(confirmed === undefined
            ? { confirmed: true }
            : confirmed === null
              ? {}
              : { confirmed }),
          ...(sourceVersion === undefined ? {} : { sourceVersion }),
        },
        ...opts,
      });
    },
    async backend(env, name) {
      const { projectId, environmentId } = ids(env);
      const path = secretPath(projectId, environmentId, name);
      const bao = operator();
      const metadata = await bao.kvMetadata(path);
      if (!metadata.ok) {
        if (metadata.kind === "not_found") return null;
        throw new Error(`backend metadata: ${metadata.kind}`);
      }
      const versions: BackendVersion[] = [];
      for (const [key, entry] of Object.entries(metadata.data.versions)) {
        const version = Number(key);
        const read = entry.deleted || entry.destroyed ? null : await bao.kvRead(path, version);
        versions.push({
          version,
          deleted: entry.deleted,
          destroyed: entry.destroyed,
          operationId: read?.ok === true ? read.data.envelope.operation_id : null,
          digest: read?.ok === true ? sha256(read.data.envelope.value) : null,
          bytes: read?.ok === true ? Buffer.byteLength(read.data.envelope.value, "utf8") : null,
        });
      }
      versions.sort((a, b) => a.version - b.version);
      return { currentVersion: metadata.data.currentVersion, versions };
    },
    operatorBao: operator,
    async auditedChanges(operationId) {
      return (await readAuditLog(stack)).filter(
        (entry) =>
          entry.type === "request" &&
          /^kv\/(data|delete|undelete)\//.test(entry.path) &&
          (entry.operation === "create" || entry.operation === "update") &&
          entry.headers["x-mykey-operation-id"]?.[0] === operationId,
      ).length;
    },
    async seedIndex(env, names, state = "live") {
      await api.superuser.query(
        `INSERT INTO app.secret_index (environment_id, name, organization_id, current_version,
           state_tag, state, live_value_bytes, last_changed_at)
         SELECT $1, n, $2, 1, md5(random()::text || n), $4, 0, now()
           FROM unnest($3::text[]) AS n`,
        [ids(env).environmentId, tenants.a.organizationId, names, state],
      );
    },
    async unseedIndex(env, names) {
      await api.superuser.query(
        "DELETE FROM app.secret_index WHERE environment_id = $1 AND name = ANY($2::text[])",
        [ids(env).environmentId, names],
      );
    },
    async seedEnvironment(env, names, bytesEach) {
      const { projectId, environmentId } = ids(env);
      const bao = operator();
      const all = Array.from(
        { length: names },
        (_, index) => `SEED_${String(index).padStart(4, "0")}`,
      );
      for (let start = 0; start < all.length; start += 16) {
        await Promise.all(
          all.slice(start, start + 16).map(async (name) => {
            const value = createHash("sha256")
              .update(`${name}-${randomUUID()}`)
              .digest("hex")
              .repeat(Math.ceil(bytesEach / 64))
              .slice(0, bytesEach);
            const written = await bao.kvWrite(
              secretPath(projectId, environmentId, name),
              { value, operation_id: randomUUID(), format: 1 },
              0,
              { operationId: randomUUID(), dispatchId: randomUUID() },
            );
            if (!written.ok) throw new Error(`seed write: ${written.kind}`);
          }),
        );
      }
      await api.superuser.query(
        `INSERT INTO app.secret_index (environment_id, name, organization_id, current_version,
           state_tag, state, live_value_bytes, last_changed_at)
         SELECT $1, n, $2, 1, md5(random()::text || n), 'live', $4, now()
           FROM unnest($3::text[]) AS n`,
        [environmentId, tenants.a.organizationId, all, bytesEach],
      );
      await api.superuser.query(
        `UPDATE app.environment SET live_value_bytes = live_value_bytes + $2,
                metadata_generation = metadata_generation + 1
          WHERE id = $1`,
        [environmentId, names * bytesEach],
      );
    },
    async indexRow(env, name) {
      const result = await api.superuser.query<IndexRowView>(
        `SELECT current_version, state_tag, state, live_value_bytes, last_operation_id
           FROM app.secret_index WHERE environment_id = $1 AND name = $2`,
        [ids(env).environmentId, name],
      );
      return result.rows[0] ?? null;
    },
    async close() {
      await second?.kill();
      await relay.close();
      await fx.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return fixture;
}

/**
 * The invariant every secret test ends with (plan, Global constraints): the
 * same names, versions and deleted flags in app.secret_index and in OpenBao;
 * each live row's byte count equal to its current value's length;
 * environment.live_value_bytes equal to the sum of the live rows; no effect
 * slot and no advisory lock left.
 */
/**
 * Run 4.8: a test-only route over the complete environment read. It answers
 * digests, never values, so a failing assertion prints none; its audit row is
 * `secret.export` with the number of names, as the export of Run 4.9 writes.
 */
export const TEST_READ_ROUTE: RouteDef = Object.freeze({
  id: "test.read",
  method: "GET",
  path: "/v1/organizations/:org/projects/:project/environments/:env/test-read",
  auth: "human",
  idempotent: false,
  ownerRun: "4.8",
  pending: false,
  request: {},
  responses: {
    200: z.strictObject({
      generation: z.string(),
      entries: z.array(
        z.strictObject({ name: z.string(), version: z.int().positive(), digest: z.string() }),
      ),
    }),
  },
  errors: [
    ...new Set<ErrorCode>([
      ...(ROUTES.find((route) => route.id === "secrets.reveal")?.errors ?? []),
      "environment_changed",
      "capacity_exceeded",
      "busy",
    ]),
  ],
  action: "secrets.read",
  scope: "environment",
});

/** The handler of TEST_READ_ROUTE, inside its own large-request gate of two. */
function testReadHandler(): Handler {
  const gate = createLargeGate(LIMITS.concurrency.largePerProcess);
  return (ctx, deps) =>
    gate.run(async () => {
      const scope = ctx.scope as EnvironmentScope | null;
      const principal = ctx.principal;
      if (scope === null || principal === null) throw new Error("test.read without a scope");
      const outcome = await readEnvironment(readDeps(deps), {
        scope,
        routeId: ctx.route.id,
        requestId: ctx.requestId,
        recheck: recheckOf(ctx, principal.userId, scope),
        audit: async (tx, read) => {
          await appendAudit(tx, {
            action: "secret.export",
            actor: { kind: "user", id: principal.userId },
            source: "api",
            organizationId: scope.organizationId,
            target: { kind: "environment", id: scope.environmentId },
            outcome: "success",
            requestId: ctx.requestId,
            operationId: null,
            details: { names: read.names },
          });
        },
      });
      if (outcome.kind === "refused") refusedOf(outcome);
      return {
        status: 200,
        body: {
          generation: outcome.read.generation.toString(),
          entries: outcome.read.entries.map((entry) => ({
            name: entry.name,
            version: entry.version,
            digest: sha256(entry.value),
          })),
        },
      };
    });
}

export async function expectIndexMatchesBackend(
  fixture: SecretsFixture,
  env: EnvName,
): Promise<void> {
  const { projectId, environmentId } = fixture.env(env);
  const db = fixture.api.superuser;
  const rows = (
    await db.query<{
      name: string;
      current_version: number | null;
      state: string;
      live_value_bytes: number;
    }>(
      `SELECT name, current_version, state, live_value_bytes FROM app.secret_index
        WHERE environment_id = $1 ORDER BY name COLLATE "C"`,
      [environmentId],
    )
  ).rows;
  const listed = await fixture.operatorBao().kvList(environmentPrefix(projectId, environmentId));
  const names = listed.ok ? [...listed.data.names].sort() : [];
  if (!listed.ok) expect(listed.kind, "kvList").toBe("not_found");
  expect(rows.map((row) => row.name).sort(), "names").toEqual(names);
  let live = 0;
  for (const row of rows) {
    const backend = await fixture.backend(env, row.name);
    expect(backend, row.name).not.toBeNull();
    const current = backend!.versions.find((v) => v.version === backend!.currentVersion);
    expect(row.current_version, `${row.name} version`).toBe(backend!.currentVersion);
    expect(row.state, `${row.name} state`).toBe(current?.deleted === true ? "deleted" : "live");
    if (row.state === "live") {
      expect(row.live_value_bytes, `${row.name} bytes`).toBe(current?.bytes);
      live += row.live_value_bytes;
    }
  }
  const counters = await db.query<{ live_value_bytes: string }>(
    "SELECT live_value_bytes FROM app.environment WHERE id = $1",
    [environmentId],
  );
  expect(Number(counters.rows[0]?.live_value_bytes), "environment live bytes").toBe(live);
  const slots = await db.query("SELECT 1 FROM app.effect_slot WHERE scope_key = $1", [
    `env:${environmentId}`,
  ]);
  expect(slots.rowCount, "effect slot").toBe(0);
  expect(await idleAdvisoryLocks(fixture), "advisory locks of idle connections").toBe(0);
}

/**
 * Advisory locks held by a connection that is idle (a lock that outlived its
 * request). Run 6.3 (D-49): a complete read leaves its environment's read
 * cool-down behind for 1.5 s on purpose; those must be gone within 3 s, and
 * only then is everything counted.
 */
export async function idleAdvisoryLocks(fixture: SecretsFixture): Promise<number> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const cooling = await fixture.api.superuser.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_locks
        WHERE locktype = 'advisory' AND objsubid = 2
          AND classid = (hashtext('mykey.read-cooldown')::bigint & 4294967295)::oid`,
    );
    if ((cooling.rows[0]?.count ?? 0) === 0) break;
    if (Date.now() > deadline) break; // counted below: a cool-down that outlived 3 s is a leak
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = await fixture.api.superuser.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a USING (pid)
      WHERE l.locktype = 'advisory' AND a.state = 'idle' AND a.datname = current_database()`,
  );
  return result.rows[0]?.count ?? 0;
}

export { LIMITS };
