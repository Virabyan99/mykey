// The generic tenant provisioner (Session 11, Run 11.5; spec §6 items 2 and
// 11). What a script that holds one automation credential does, written
// against the HTTP contract alone: nothing here imports MyKey's code, so the
// same steps can be written in any language from /v1/reference.
//
//   provision: a project, an environment, its secrets (create-only) and one
//              runtime credential for the server that will read them.
//   reissue:   after a restore, or a lost server: a new runtime credential for
//              every environment of every project the credential's chain manages.
//
// Rules it keeps:
//   - the automation secret comes from a file or stdin, never from an argument;
//   - one Idempotency-Key per step, kept across that step's retries;
//   - a 202 or an `outcome_unknown` is resolved by reading the operation,
//     never by sending the change again under a new key (Doc 10 §4.1 rule 3);
//   - `retry-after` is honoured on 429 and on 503 busy;
//   - it prints ids and timings only. A client secret is written to a file of
//     its own (mode 0600) or returned to the caller, never printed.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface ProvisionerApi {
  /** `https://host[:port]`, no path. */
  baseUrl: string;
  /** The CA of a test API; undefined where the host's certificate is public. */
  ca?: Buffer;
}

export interface Step {
  step: string;
  ms: number;
  /** HTTP requests the step sent (a retry or a poll is one more). */
  requests: number;
}

export interface Provisioned {
  projectId: string;
  environmentId: string;
  credentialId: string;
  /** For the server's secret store; never printed. */
  clientSecret: string;
  steps: Step[];
}

export interface Reissued {
  projects: number;
  issued: { projectId: string; environmentId: string; credentialId: string; clientSecret: string }[];
  steps: Step[];
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
  retryAfter: number | null;
}

/** A refusal the script does not retry: the step, the status and the error code. Never a secret. */
export class ProvisionerError extends Error {
  readonly step: string;
  readonly status: number;
  readonly code: string;
  constructor(step: string, status: number, code: string) {
    super(`${step}: ${String(status)} ${code}`);
    this.name = "ProvisionerError";
    this.step = step;
    this.status = status;
    this.code = code;
  }
}

function request(
  api: ProvisionerApi,
  secret: string,
  method: string,
  path: string,
  init: { key?: string; body?: unknown } = {},
): Promise<Answer> {
  const url = new URL(path, api.baseUrl);
  const payload = init.body === undefined ? undefined : Buffer.from(JSON.stringify(init.body));
  return new Promise((resolve, reject) => {
    const outgoing = https.request(
      {
        host: url.hostname,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        agent: false,
        ...(api.ca === undefined ? {} : { ca: api.ca }),
        headers: {
          authorization: `Bearer ${secret}`,
          ...(init.key === undefined ? {} : { "idempotency-key": init.key }),
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": String(payload.length) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          let body: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              body = parsed as Record<string, unknown>;
            }
          } catch {
            // An answer that is no JSON object has no code: the status decides.
          }
          const header = Number(response.headers["retry-after"]);
          resolve({
            status: response.statusCode ?? 0,
            body,
            retryAfter: Number.isFinite(header) && header > 0 ? header : null,
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (payload !== undefined) outgoing.write(payload);
    outgoing.end();
  });
}

const codeOf = (answer: Answer): string =>
  ((answer.body.error as { code?: string } | undefined)?.code ?? "") || "no_code";

/** How long one step keeps trying or polling before it gives up. */
const STEP_BUDGET_MS = 120_000;

class Run {
  readonly steps: Step[] = [];
  private readonly api: ProvisionerApi;
  private readonly secret: string;

  constructor(api: ProvisionerApi, secret: string) {
    this.api = api;
    this.secret = secret;
  }

  private async timed<T>(
    step: string,
    work: (count: () => void) => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    let requests = 0;
    try {
      return await work(() => {
        requests += 1;
      });
    } finally {
      this.steps.push({ step, ms: Math.round(performance.now() - started), requests });
    }
  }

  /** A read, retried while the service says to wait. */
  get(step: string, path: string): Promise<Record<string, unknown>> {
    return this.timed(step, (count) => this.read(step, path, count));
  }

  private async read(
    step: string,
    path: string,
    count: () => void,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + STEP_BUDGET_MS;
    for (;;) {
      count();
      const answer = await request(this.api, this.secret, "GET", path);
      if (answer.status === 200) return answer.body;
      if (!waits(answer) || Date.now() > deadline) {
        throw new ProvisionerError(step, answer.status, codeOf(answer));
      }
      await sleep((answer.retryAfter ?? 1) * 1000);
    }
  }

  /**
   * One change: one key for the whole step. A completed answer is returned; a
   * 202 or an unknown outcome is read from the operation until it is settled.
   */
  change(step: string, path: string, body: unknown): Promise<Record<string, unknown>> {
    return this.timed(step, async (count) => {
      const key = randomUUID();
      const deadline = Date.now() + STEP_BUDGET_MS;
      for (;;) {
        count();
        const answer = await request(this.api, this.secret, "POST", path, { key, body });
        if (answer.status === 200 || answer.status === 201) return answer.body;
        const code = codeOf(answer);
        const operationId =
          answer.status === 202
            ? (answer.body.operationId as string | undefined)
            : code === "outcome_unknown"
              ? (answer.body.error as { operationId?: string }).operationId
              : undefined;
        if (operationId !== undefined) return this.settle(step, operationId, count, deadline);
        if (!waits(answer) || Date.now() > deadline) {
          throw new ProvisionerError(step, answer.status, code);
        }
        // The same key: the service decides whether the first attempt happened.
        await sleep((answer.retryAfter ?? 1) * 1000);
      }
    });
  }

  /** The operation's end, read through automation.operations.get: never a second attempt. */
  private async settle(
    step: string,
    operationId: string,
    count: () => void,
    deadline: number,
  ): Promise<Record<string, unknown>> {
    for (;;) {
      const operation = await this.read(step, `/v1/automation/operations/${operationId}`, count);
      const state = operation.state as string;
      if (state === "succeeded") return operation;
      if (state === "rejected" || state === "uncertain" || state === "partial") {
        // `uncertain` is the owner's to settle: the script says so and stops.
        throw new ProvisionerError(step, 0, `operation_${state}`);
      }
      if (Date.now() > deadline) throw new ProvisionerError(step, 0, "operation_unfinished");
      await sleep(250);
    }
  }

  /** Until the environment is active and its store is ready (the provisioner builds it, D-32). */
  ready(step: string, projectId: string, environmentId: string): Promise<void> {
    return this.timed(step, async (count) => {
      const deadline = Date.now() + STEP_BUDGET_MS;
      for (;;) {
        const project = await this.read(step, `/v1/automation/projects/${projectId}`, count);
        const environments = project.environments as
          { id: string; state: string; kvReady: boolean }[];
        const found = environments.find((environment) => environment.id === environmentId);
        if (found?.state === "active" && found.kvReady) return;
        if (found !== undefined && found.state !== "pending") {
          throw new ProvisionerError(step, 0, `environment_${found.state}`);
        }
        if (Date.now() > deadline) throw new ProvisionerError(step, 0, "environment_not_ready");
        await sleep(250);
      }
    });
  }
}

/** 429, or 503 busy: the service asks the caller to come back. */
function waits(answer: Answer): boolean {
  return answer.status === 429 || (answer.status === 503 && codeOf(answer) === "busy");
}

const resultOf = (operation: Record<string, unknown>): Record<string, string> =>
  (operation.result ?? {}) as Record<string, string>;

/**
 * One tenant: a project named `tenant`, one environment, `secrets` written
 * create-only, and a runtime credential for its server.
 */
export async function provision(
  api: ProvisionerApi,
  secret: string,
  input: {
    tenant: string;
    secrets: Readonly<Record<string, string>>;
    /** The environment's name; default `production`. */
    environment?: string;
    /** The runtime credential's networks; default none. */
    cidrs?: readonly string[];
  },
): Promise<Provisioned> {
  const run = new Run(api, secret);
  const project = await run.change("project", "/v1/automation/projects", { name: input.tenant });
  const projectId = resultOf(project).projectId;
  if (projectId === undefined) throw new ProvisionerError("project", 0, "no_project_id");
  const base = `/v1/automation/projects/${projectId}`;
  const environment = await run.change("environment", `${base}/environments`, {
    name: input.environment ?? "production",
  });
  const environmentId = resultOf(environment).environmentId;
  if (environmentId === undefined) throw new ProvisionerError("environment", 0, "no_environment_id");
  await run.ready("ready", projectId, environmentId);
  const scope = `${base}/environments/${environmentId}`;
  for (const [name, value] of Object.entries(input.secrets)) {
    await run.change("secret", `${scope}/secrets`, { name, value });
  }
  const issued = await run.change("runtime-credential", `${scope}/runtime-credentials`, {
    name: `${input.tenant} server`.slice(0, 64),
    ...(input.cidrs === undefined ? {} : { cidrs: [...input.cidrs] }),
  });
  return {
    projectId,
    environmentId,
    credentialId: (issued.credential as { credentialId: string }).credentialId,
    clientSecret: issued.clientSecret as string,
    steps: run.steps,
  };
}

/** Every page of a list route. */
async function pages<T>(run: Run, step: string, path: string, key: string): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const page = await run.get(step, `${path}${query}`);
    rows.push(...(page[key] as T[]));
    cursor = (page.nextCursor as string | null | undefined) ?? null;
  } while (cursor !== null);
  return rows;
}

/**
 * A new runtime credential for every ready environment of every project the
 * credential's chain manages. What the old ones could do is not looked at:
 * after a restore they are revoked, and a lost server's is revoked by its owner.
 */
export async function reissue(api: ProvisionerApi, secret: string): Promise<Reissued> {
  const run = new Run(api, secret);
  const projects = await pages<{ id: string; name: string }>(
    run,
    "projects",
    "/v1/automation/projects",
    "projects",
  );
  const issued: Reissued["issued"] = [];
  for (const project of projects) {
    const detail = await run.get("project", `/v1/automation/projects/${project.id}`);
    const environments = detail.environments as { id: string; state: string; kvReady: boolean }[];
    for (const environment of environments) {
      if (environment.state !== "active" || !environment.kvReady) continue;
      const answer = await run.change(
        "runtime-credential",
        `/v1/automation/projects/${project.id}/environments/${environment.id}/runtime-credentials`,
        { name: `${project.name} server`.slice(0, 64) },
      );
      issued.push({
        projectId: project.id,
        environmentId: environment.id,
        credentialId: (answer.credential as { credentialId: string }).credentialId,
        clientSecret: answer.clientSecret as string,
      });
    }
  }
  return { projects: projects.length, issued, steps: run.steps };
}

/** The automation secret from a file, or from stdin when the path is `-`; never from an argument. */
export function readSecret(path: string): string {
  const text = readFileSync(path === "-" ? 0 : path, "utf8").trim();
  if (text === "") throw new Error("the automation secret is empty");
  return text;
}

/** Steps as a script may print them: names, milliseconds and request counts. */
export function timings(steps: readonly Step[]): Record<string, { count: number; ms: number }> {
  const totals: Record<string, { count: number; ms: number }> = {};
  for (const step of steps) {
    const total = (totals[step.step] ??= { count: 0, ms: 0 });
    total.count += 1;
    total.ms += step.ms;
  }
  return totals;
}

/**
 * As a command:
 *   node tenant-provisioner.ts provision <baseUrl> <secret-file|-> <out-dir> <tenant> <secrets.json>
 *   node tenant-provisioner.ts reissue   <baseUrl> <secret-file|-> <out-dir>
 * `secrets.json` is an object of names and synthetic values. Each client
 * secret is written to <out-dir>/<environmentId>.client-secret (mode 0600).
 */
async function main(args: readonly string[]): Promise<void> {
  const [command, baseUrl, secretPath, out, tenant, secretsPath] = args;
  if (baseUrl === undefined || secretPath === undefined || out === undefined) {
    throw new Error("usage: provision|reissue <baseUrl> <secret-file|-> <out-dir> [<tenant> <secrets.json>]");
  }
  const api: ProvisionerApi = { baseUrl };
  const secret = readSecret(secretPath);
  mkdirSync(out, { recursive: true });
  const keep = (environmentId: string, clientSecret: string): void => {
    writeFileSync(join(out, `${environmentId}.client-secret`), `${clientSecret}\n`, { mode: 0o600 });
  };
  if (command === "provision" && tenant !== undefined && secretsPath !== undefined) {
    const secrets = JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, string>;
    const made = await provision(api, secret, { tenant, secrets });
    keep(made.environmentId, made.clientSecret);
    console.log(
      JSON.stringify({
        projectId: made.projectId,
        environmentId: made.environmentId,
        credentialId: made.credentialId,
        timings: timings(made.steps),
      }),
    );
    return;
  }
  if (command === "reissue") {
    const made = await reissue(api, secret);
    for (const one of made.issued) keep(one.environmentId, one.clientSecret);
    console.log(
      JSON.stringify({
        projects: made.projects,
        issued: made.issued.map(({ projectId, environmentId, credentialId }) => ({
          projectId,
          environmentId,
          credentialId,
        })),
        timings: timings(made.steps),
      }),
    );
    return;
  }
  throw new Error("usage: provision|reissue <baseUrl> <secret-file|-> <out-dir> [<tenant> <secrets.json>]");
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // The message of a ProvisionerError holds a step, a status and a code.
    console.error(error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  });
}
