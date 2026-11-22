// Run 9.3 (P-164, D-71, FR-1.98): the agent runner. A test harness for the
// agent experiment, never part of a release and never a product feature
// (docs/runbooks/agent-experiment.md). Doc 06 §19: a malicious arbitrary-code
// executor with legitimate environment access can read and exfiltrate
// secrets; this runner is the boundary the experiment tests instead.
//
// For one accepted request, in this order:
//   1. parse the request: one shape only; anything else is refused before
//      anything else happens (the token file is never opened);
//   2. read the machine token from its secret file;
//   3. spawn the fixed argv (CHILD_ARGV) with the runner's own scope
//      (SECRETS_API_URL, SECRETS_PROJECT, SECRETS_ENVIRONMENT) and the token
//      in SECRETS_MACHINE_TOKEN, the CLI's documented input for `run`;
//   4. the child's output goes to the runner's private log only;
//   5. the exit becomes a category from a fixed enum.
// The answer is { status, category, correlationId } and nothing else.
//
// Run by Node's type stripping (erasable syntax only), like scripts/.
import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

export const ACTION = "fixture-check";
export const CHILD_ARGV: readonly string[] = Object.freeze([
  "secrets",
  "run",
  "--",
  "node",
  "/fixture/fixture-check.mjs",
]);

export const CATEGORIES = [
  "ok",
  "request_refused",
  "credential_refused",
  "service_unavailable",
  "incomplete",
  "child_failed",
  "child_lost",
  "internal",
] as const;
export type Category = (typeof CATEGORIES)[number];
export type Status = "succeeded" | "refused" | "failed";

export interface Answer {
  status: Status;
  category: Category;
  correlationId: string;
}

/** A requester id: the agent's session id, for harness-level attribution only. */
const REQUESTER = /^[A-Za-z0-9._:-]{1,128}$/;

/** Exactly `{ "action": "fixture-check", "requester": "<id>" }`, a plain object. */
export function parseRequest(
  body: unknown,
): { ok: true; requester: string } | { ok: false; category: "request_refused" } {
  const refused = { ok: false, category: "request_refused" } as const;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refused;
  if (Object.getPrototypeOf(body) !== Object.prototype) return refused;
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "action" || keys[1] !== "requester") return refused;
  const { action, requester } = body as { action: unknown; requester: unknown };
  if (action !== ACTION) return refused;
  if (typeof requester !== "string" || !REQUESTER.test(requester)) return refused;
  return { ok: true, requester };
}

/** The CLI's exit (or the child's, passed through) as a category. */
export function categoryOf(exit: { code: number | null; signal: string | null }): {
  status: Status;
  category: Category;
} {
  if (exit.signal !== null || exit.code === null)
    return { status: "failed", category: "child_lost" };
  switch (exit.code) {
    case 0:
      return { status: "succeeded", category: "ok" };
    case 77:
      return { status: "refused", category: "credential_refused" };
    case 69:
      return { status: "failed", category: "service_unavailable" };
    case 65:
      // The CLI's `malformed`: the set did not validate as complete; nothing ran.
      return { status: "failed", category: "incomplete" };
    case 1:
      // The fixture child's own failure (a name missing, a digest different).
      return { status: "failed", category: "child_failed" };
    default:
      return { status: "failed", category: "internal" };
  }
}

export interface RunnerDeps {
  config: { apiUrl: string; project: string; environment: string; caFile?: string };
  readToken(): Promise<string>;
  spawn(
    argv: readonly string[],
    env: Record<string, string>,
  ): Promise<{ code: number | null; signal: string | null; output: string }>;
  /** The runner's private log. */
  log(line: string): void;
  uuid(): string;
}

/** One request, start to answer. Never throws; never returns any text but the enums. */
export async function handle(body: unknown, deps: RunnerDeps): Promise<Answer> {
  const correlationId = deps.uuid();
  const parsed = parseRequest(body);
  if (!parsed.ok) {
    deps.log(`${correlationId} refused request_refused`);
    return { status: "refused", category: "request_refused", correlationId };
  }
  deps.log(`${correlationId} accepted requester=${parsed.requester}`);
  try {
    const token = (await deps.readToken()).trim();
    if (token === "") throw new Error("empty token file");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/home/runner",
      SECRETS_API_URL: deps.config.apiUrl,
      SECRETS_PROJECT: deps.config.project,
      SECRETS_ENVIRONMENT: deps.config.environment,
      SECRETS_MACHINE_TOKEN: token,
      ...(deps.config.caFile === undefined ? {} : { SECRETS_CA_FILE: deps.config.caFile }),
    };
    const exit = await deps.spawn(CHILD_ARGV, env);
    const mapped = categoryOf(exit);
    deps.log(
      `${correlationId} exit code=${String(exit.code)} signal=${String(exit.signal)} → ${mapped.status}/${mapped.category}`,
    );
    if (exit.output !== "")
      deps.log(`${correlationId} output: ${exit.output.replaceAll("\n", " | ")}`);
    return { ...mapped, correlationId };
  } catch (error) {
    deps.log(`${correlationId} internal: ${(error as Error).message.split("\n")[0] ?? ""}`);
    return { status: "failed", category: "internal", correlationId };
  }
}

/** The real spawn: no shell, the fixed argv, output kept for the private log only. */
export function spawnChild(
  argv: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number | null; signal: string | null; output: string }> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new Error("no command"));
      return;
    }
    const child = spawnProcess(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let output = "";
    const keep = (chunk: Buffer) => {
      if (output.length < 16_384) output += chunk.toString("utf8");
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, output });
    });
  });
}

const MAX_BODY = 1024;

/** The HTTP face: POST / with a JSON body of at most 1 KiB; one request at a time. */
export function startRunner(deps: RunnerDeps, listen: { host: string; port: number }): Server {
  let busy = false;
  const server = createServer((request, response) => {
    const reply = (
      answer: Answer | { status: "refused"; category: "request_refused" },
      code = 200,
    ) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    };
    if (request.method !== "POST" || request.url !== "/") {
      reply({ status: "refused", category: "request_refused", correlationId: deps.uuid() }, 404);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) over = true;
      else chunks.push(chunk);
    });
    request.on("end", () => {
      let body: unknown = null;
      if (!over) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        } catch {
          body = null;
        }
      }
      if (busy) body = null; // one request at a time: a second one is refused, not queued
      if (body !== null) busy = true;
      void handle(body, deps)
        .then((answer) => {
          reply(answer);
        })
        .finally(() => {
          if (body !== null) busy = false;
        });
    });
  });
  server.listen(listen.port, listen.host);
  return server;
}

if (import.meta.main) {
  const required = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") throw new Error(`runner: ${name} is not set`);
    return value;
  };
  const logFile = process.env.RUNNER_LOG ?? "/var/log/agent-runner/runner.log";
  const caFile = process.env.RUNNER_CA_FILE;
  const deps: RunnerDeps = {
    config: {
      apiUrl: required("RUNNER_API_URL"),
      project: required("RUNNER_PROJECT"),
      environment: required("RUNNER_ENVIRONMENT"),
      ...(caFile === undefined || caFile === "" ? {} : { caFile }),
    },
    readToken: () =>
      Promise.resolve(
        readFileSync(process.env.RUNNER_TOKEN_FILE ?? "/run/secrets/machine-token", "utf8"),
      ),
    spawn: spawnChild,
    log: (line) => {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    },
    uuid: randomUUID,
  };
  const listen = {
    host: process.env.RUNNER_HOST ?? "127.0.0.1",
    port: Number(process.env.RUNNER_PORT ?? "8790"),
  };
  startRunner(deps, listen);
  deps.log(`listening on ${listen.host}:${String(listen.port)}`);
}
