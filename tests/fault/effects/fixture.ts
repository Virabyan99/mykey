// Shared set-up of the G-EFFECT suites (Run 2.4): a fresh database with the
// tenancy rows of an OpenBao organization fixture (ruling R2), clients for the
// runtime and an operator, the spike executor in this process or as a child
// process, and the three checks every scenario ends with.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { OpenBaoClient } from "@mykey/openbao";
import {
  SPIKE_ACTION,
  executeWrite,
  reconcile,
  spikeSecretPath,
  type RunnerJob,
  type SpikeDeps,
  type SpikeOutcome,
  type SpikeWrite,
} from "@mykey/operations/spike";
import { expect } from "vitest";
import { prepareDatabase, run, type TestDatabase } from "../../integration/database/setup.ts";
import { createOrgFixture, type OrgFixture } from "../../harness/org-fixture.ts";
import { readAuditLog, type Stack } from "../../harness/stack.ts";

const RUNNER = resolve(import.meta.dirname, "../../../packages/operations/src/spike/runner.ts");

export interface EffectsFixture {
  stack: Stack;
  db: TestDatabase;
  org: OrgFixture;
  /** Reads with the root token inside the organization's namespace. */
  operatorBao(): OpenBaoClient;
  runtimeToken: string;
  /** A runtime client, optionally through another URL (a relay) or with another deadline. */
  runtimeBao(opts?: { url?: string; deadlineMs?: number }): OpenBaoClient;
  deps(opts?: { url?: string; deadlineMs?: number; bootId?: string }): SpikeDeps;
  /** A write to a new secret of environment `environment`, expected version 0. */
  write(overrides?: Partial<SpikeWrite> & { environment?: number }): SpikeWrite;
  execute(input: SpikeWrite, opts?: { url?: string; deadlineMs?: number }): Promise<SpikeOutcome>;
  child(
    input: SpikeWrite,
    opts?: Partial<Omit<RunnerJob, "input">> & { url?: string },
  ): ExecutorChild;
  reconcile(operationId: string, executorsExcluded: boolean): ReturnType<typeof reconcile>;
  close(): Promise<void>;
}

export interface ExecutorChild {
  process: ChildProcessWithoutNullStreams;
  started: Promise<void>;
  outcome: Promise<SpikeOutcome | null>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): Promise<void>;
}

/**
 * `opts.db` replaces the fresh database (Run 2.9 on staging: the real one,
 * whose `drop()` only closes pools); `opts.environments` defaults to two.
 */
export async function effectsFixture(
  stack: Stack,
  opts: { db?: TestDatabase; environments?: number } = {},
): Promise<EffectsFixture> {
  const db = opts.db ?? (await prepareDatabase({ stack }));
  const org = await createOrgFixture(stack, { environments: opts.environments ?? 2 });
  const maintenance = db.pool("maintenance");
  await run(
    maintenance,
    "INSERT INTO app.organization (id, namespace, state) VALUES ($1, $2, 'active')",
    [org.organizationId, org.namespace],
  );
  await run(
    maintenance,
    "INSERT INTO app.project (id, organization_id, name, state) VALUES ($1, $2, 'spike', 'active')",
    [org.projectId, org.organizationId],
  );
  for (const [index, environment] of org.environments.entries()) {
    await run(
      maintenance,
      `INSERT INTO app.environment (id, organization_id, project_id, name, state, kv_ready)
       VALUES ($1, $2, $3, $4, 'active', true)`,
      [environment.id, org.organizationId, org.projectId, `env-${index}`],
    );
  }
  const runtimeToken = await org.login("runtime");
  // A new client per use: after a restart OpenBao is published on another port.
  const operatorBao = (): OpenBaoClient =>
    new OpenBaoClient(stack.bao, { namespace: org.namespace, token: stack.bao.rootToken });
  const runtimeBao: EffectsFixture["runtimeBao"] = (opts = {}) =>
    new OpenBaoClient(
      { url: opts.url ?? stack.bao.url, caCertPath: stack.bao.caCertPath },
      {
        namespace: org.namespace,
        token: runtimeToken,
        ...(opts.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs }),
      },
    );
  const deps: EffectsFixture["deps"] = (opts = {}) => ({
    runtimePool: db.pool("api_runtime"),
    lockTarget: db.targets.api_runtime,
    bao: runtimeBao(opts),
    bootId: opts.bootId ?? randomUUID(),
  });

  return {
    stack,
    db,
    org,
    operatorBao,
    runtimeToken,
    runtimeBao,
    deps,
    write: (overrides = {}) => {
      const { environment = 0, ...rest } = overrides;
      return {
        organizationId: org.organizationId,
        projectId: org.projectId,
        environmentId: org.environments[environment]!.id,
        name: `S_${randomUUID().replace(/-/g, "").toUpperCase()}`,
        value: `synthetic-${randomUUID()}`,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        ...rest,
      };
    },
    execute: (input, opts) => executeWrite(deps(opts), input),
    child: (input, opts = {}) => {
      const { url, ...job } = opts;
      return startChild({
        runtime: db.targets.api_runtime,
        lock: db.targets.api_runtime,
        bao: {
          url: url ?? stack.bao.url,
          caCertPath: stack.bao.caCertPath,
          namespace: org.namespace,
          token: runtimeToken,
        },
        ...job,
        input,
      });
    },
    reconcile: (operationId, executorsExcluded) =>
      reconcile({ maintenancePool: maintenance, operatorBao: operatorBao() }, operationId, {
        executorsExcluded,
      }),
    close: async () => {
      await org.drop();
      await db.drop();
    },
  };
}

function startChild(job: RunnerJob): ExecutorChild {
  const child = spawn(process.execPath, [RUNNER], { stdio: ["pipe", "pipe", "pipe"] });
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolveStarted) => {
    markStarted = resolveStarted;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) =>
      child.once("exit", (code, signal) => {
        resolveExit({ code, signal });
      }),
  );
  const outcome = new Promise<SpikeOutcome | null>((resolveOutcome) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as { started?: boolean; outcome?: SpikeOutcome };
      if (message.started === true) markStarted();
      if (message.outcome !== undefined) resolveOutcome(message.outcome);
    });
    void exited.then(() => {
      resolveOutcome(null);
    });
  });
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.stdin.end(JSON.stringify(job));
  return {
    process: child,
    started,
    outcome,
    exited,
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

// ----------------------------------------------------------------- checks

export interface OperationRow {
  state: string;
  dispatched_at: Date | null;
  executor_boot_id: string | null;
}

export async function operationOf(
  fixture: EffectsFixture,
  operationId: string,
): Promise<OperationRow> {
  const rows = await run<OperationRow>(
    fixture.db.pool("maintenance"),
    "SELECT state, dispatched_at, executor_boot_id FROM app.operation WHERE id = $1",
    [operationId],
  );
  if (rows[0] === undefined) throw new Error(`no operation ${operationId}`);
  return rows[0];
}

export async function operationFor(fixture: EffectsFixture, input: SpikeWrite): Promise<string> {
  const rows = await run<{ id: string }>(
    fixture.db.pool("maintenance"),
    "SELECT id FROM app.operation WHERE action = $1 AND idempotency_key = $2",
    [SPIKE_ACTION, input.idempotencyKey],
  );
  if (rows[0] === undefined) throw new Error("no operation for this write");
  return rows[0].id;
}

export async function slotHeld(fixture: EffectsFixture, environmentId: string): Promise<boolean> {
  const rows = await run(
    fixture.db.pool("maintenance"),
    "SELECT 1 FROM app.effect_slot WHERE scope_key = $1",
    [`env:${environmentId}`],
  );
  return rows.length === 1;
}

/** Versions of the secret in the backend, each with the operation id its envelope carries. */
export async function backendVersions(
  fixture: EffectsFixture,
  input: SpikeWrite,
): Promise<{ version: number; operationId: string }[]> {
  const path = spikeSecretPath(input.projectId, input.environmentId, input.name);
  const metadata = await fixture.operatorBao().kvMetadata(path);
  if (!metadata.ok) {
    if (metadata.kind === "not_found") return [];
    throw new Error(`backend metadata: ${metadata.kind}`);
  }
  const versions: { version: number; operationId: string }[] = [];
  for (const key of Object.keys(metadata.data.versions)) {
    const read = await fixture.operatorBao().kvRead(path, Number(key));
    if (read.ok)
      versions.push({ version: Number(key), operationId: read.data.envelope.operation_id });
  }
  return versions.sort((a, b) => a.version - b.version);
}

/** kv/data write requests the audit device recorded for an operation. */
export async function auditedWrites(fixture: EffectsFixture, operationId: string): Promise<number> {
  return (await readAuditLog(fixture.stack)).filter(
    (entry) =>
      entry.type === "request" &&
      entry.path.startsWith("kv/data/") &&
      entry.headers["x-mykey-operation-id"]?.[0] === operationId,
  ).length;
}

/**
 * The three checks every scenario ends with: no duplicate (at most `writes`
 * audited write requests), no false failure, and an index that tells the truth.
 */
export async function expectConsistent(
  fixture: EffectsFixture,
  input: SpikeWrite,
  operationId: string,
  writes: number,
): Promise<void> {
  expect(await auditedWrites(fixture, operationId), "audited kv/data writes").toBe(writes);
  const versions = await backendVersions(fixture, input);
  const operation = await operationOf(fixture, operationId);
  if (operation.state === "rejected") {
    expect(
      versions.map((entry) => entry.operationId),
      "a rejected operation has no version",
    ).not.toContain(operationId);
  }
  const index = await run<{ current_version: number | null; state: string }>(
    fixture.db.pool("maintenance"),
    "SELECT current_version, state FROM app.secret_index WHERE environment_id = $1 AND name = $2",
    [input.environmentId, input.name],
  );
  const backendCurrent = versions.at(-1)?.version ?? null;
  if (index[0] === undefined) expect(backendCurrent, "no index row: no backend version").toBeNull();
  else if (index[0].state !== "needs_review") expect(index[0].current_version).toBe(backendCurrent);
}
