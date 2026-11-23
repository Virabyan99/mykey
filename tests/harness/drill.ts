// Run 6.8 (P-125, D-56): the clean-host restore drill's harness. The drill is
// one staging test file run step by step; a real multi-hour run can stop, so
// every step records itself (with its timing) in a state file under ~/.mykey
// (it holds machine tokens and session cookies: never in the repository), and
// a rerun skips the steps already done. The fence: from "declared lost" until
// the drill host's gate is open, MYKEY_FENCED_HOSTS=staging makes every SSH
// connection to staging fail, in this process and in host.ts's children.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expectSuccess, loadHosts, registerSecret, sshExec, type HostEntry } from "./staging.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
export const DRILL_DIR = join(homedir(), ".mykey", "drill");

/**
 * Run 10.2 (D-77): MYKEY_DRILL_TARGET=staging is the re-drill of staging onto
 * its own reinstalled server, with a state file of its own; else Run 6.8's.
 */
export function drillStateFile(): string {
  return join(
    DRILL_DIR,
    process.env.MYKEY_DRILL_TARGET === "staging" ? "redrill-state.json" : "state.json",
  );
}

export interface StepTiming {
  name: string;
  startedAt: string;
  seconds: number;
}

export interface DrillState {
  done: string[];
  steps: StepTiming[];
  /** Everything else a later step reads (ids, digests, tokens, cookies). */
  data: Record<string, unknown>;
}

export function readState(): DrillState {
  if (!existsSync(drillStateFile())) return { done: [], steps: [], data: {} };
  const state = JSON.parse(readFileSync(drillStateFile(), "utf8")) as DrillState;
  for (const value of secretsOf(state.data)) registerSecret(value);
  return state;
}

export function writeState(state: DrillState): void {
  mkdirSync(DRILL_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(drillStateFile(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Values under keys named token, cookie or password are registered for redaction. */
function secretsOf(value: unknown, key = ""): string[] {
  if (typeof value === "string") return /token|cookie|password|secret/i.test(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => secretsOf(item, key));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => secretsOf(v, k));
  }
  return [];
}

/**
 * Runs `work` once: a step already done is skipped; a step that throws stays
 * not done (the file is run again from there). Timed when `timed`.
 */
export async function step(
  name: string,
  work: (state: DrillState) => Promise<void>,
  opts: { timed?: boolean } = {},
): Promise<"done" | "skipped"> {
  const state = readState();
  if (state.done.includes(name)) return "skipped";
  const startedAt = new Date();
  await work(state);
  const seconds = Math.round((Date.now() - startedAt.getTime()) / 100) / 10;
  if (opts.timed === true) {
    state.steps = state.steps.filter((s) => s.name !== name);
    state.steps.push({ name, startedAt: startedAt.toISOString(), seconds });
  }
  state.done.push(name);
  writeState(state);
  return "done";
}

export function fence(on: boolean): void {
  if (on) process.env.MYKEY_FENCED_HOSTS = "staging";
  else delete process.env.MYKEY_FENCED_HOSTS;
}

/**
 * The host a drill restores onto: staging itself for the re-drill
 * (MYKEY_DRILL_TARGET=staging, R4-10's case), else Run 6.8's `drill` host.
 */
export function drillTarget(): HostEntry {
  return process.env.MYKEY_DRILL_TARGET === "staging" ? loadHosts().staging : drillHost();
}

/** A restore's own root token lasts this long from step 4 (RR-2, known-limits.md). */
export const RESTORE_WINDOW_MINUTES = 120;

/** The minutes left of the restore's window, from `state.data.step4At`; null before step 4. */
export function restoreClock(
  state: DrillState,
  now: Date = new Date(),
): { step4At: string | null; minutesLeft: number | null } {
  const step4At = typeof state.data.step4At === "string" ? state.data.step4At : null;
  if (step4At === null) return { step4At: null, minutesLeft: null };
  const elapsed = (now.getTime() - new Date(step4At).getTime()) / 60_000;
  return { step4At, minutesLeft: Math.floor(RESTORE_WINDOW_MINUTES - elapsed) };
}

export function drillHost(): HostEntry {
  const drill = loadHosts().drill;
  if (drill === undefined) throw new Error("hosts.json has no drill entry");
  return drill;
}

/** `node scripts/host.ts <args>` with the fence of this process; output kept (redacted by host.ts). */
export function hostTs(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["scripts/host.ts", ...args], {
      cwd: ROOT,
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (output += c.toString("utf8")));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 3_600_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}

/** `hostTs` that must exit 0; the error carries the tail of the output. */
export async function hostTsOk(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  const run = await hostTs(args, opts);
  if (run.code !== 0) {
    throw new Error(
      `host.ts ${args.slice(0, 2).join(" ")} exited ${String(run.code)}: ${run.output.slice(-1_500)}`,
    );
  }
  return run.output;
}

/** One SQL statement as the superuser inside a host's PostgreSQL container; rows as `|`-separated lines. */
export async function hostSql(host: HostEntry, sql: string): Promise<string[]> {
  const command = `docker exec -i mykey-postgres-1 sh -c 'PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" psql -U postgres -d postgres -Atq -v ON_ERROR_STOP=1 -f -'`;
  const out = expectSuccess(
    await sshExec(host, command, { sudo: true, stdin: sql, timeoutMs: 120_000 }),
    "psql",
  ).stdout.trim();
  return out === "" ? [] : out.split("\n");
}

export interface Answer {
  status: number;
  body: string;
  cookies: string[];
}

/** One request to a public name with that name's Origin (state changes need it). */
export async function requestAt(
  origin: string,
  method: string,
  path: string,
  init: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {
    origin,
    "sec-fetch-site": "same-origin",
    ...init.headers,
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  return {
    status: response.status,
    body: await response.text(),
    cookies: response.headers.getSetCookie(),
  };
}

/** The session cookie pair an answer sets. */
export function sessionOf(answer: Answer): string {
  for (const cookie of answer.cookies) {
    const pair = cookie.split(";")[0] ?? "";
    if (pair.startsWith("__Secure-better-auth.session_token=") && pair.length > 40) {
      registerSecret(pair);
      return pair;
    }
  }
  throw new Error(`no session cookie (HTTP ${String(answer.status)})`);
}

export const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** The drill's evidence file: no secret, no token, no value. */
export function writeEvidence(file: string, evidence: unknown): void {
  writeFileSync(join(ROOT, file), `${JSON.stringify(evidence, null, 2)}\n`);
}
