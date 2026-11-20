// `secrets run [--override] -- <command> [args…]` (FR-1.48, FR-1.49, D-43).
// In order: resolve and validate the complete set (client.ts) → build the
// child's environment → check that it fits the platform → install the signal
// handlers → spawn without a shell, stdio inherited → drop the references to
// the entries and the token → wait. Nothing is written to disk; there is no
// cache and no second request. A signal before the spawn starts nothing.
import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:os";
import { checkSecretName } from "@mykey/contracts";
import type { ApiClient, Selector } from "./client.ts";
import { CliError } from "./errors.ts";

/** The parent's environment without SECRETS_*, plus the secrets. */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  entries: readonly { name: string; value: string }[],
  override: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (!name.startsWith("SECRETS_") && value !== undefined) env[name] = value;
  }
  for (const entry of entries) {
    if (!checkSecretName(entry.name).ok) {
      throw new CliError("malformed", "the answer holds a name a secret may not have");
    }
    if (entry.value.includes("\u0000")) {
      throw new CliError("malformed", "the answer holds a value no environment can carry");
    }
    if (env[entry.name] !== undefined && !override) {
      throw new CliError(
        "usage",
        "a secret has the name of a variable already set; give --override to let the secret win",
      );
    }
    env[entry.name] = entry.value;
  }
  return env;
}

/** Linux's MAX_ARG_STRLEN: one argument or NAME=value string, its NUL included. */
const LINUX_STRING_MAX = 128 * 1024;

/**
 * R5-4 (Run 8.6): getconf by its absolute path and with an empty environment,
 * so nothing found through PATH runs and nothing it runs sees the token.
 */
function argMaxOf(): number {
  try {
    const value = Number(
      execFileSync("/usr/bin/getconf", ["ARG_MAX"], { encoding: "utf8", env: {} }).trim(),
    );
    return Number.isFinite(value) && value > 0 ? value : 256 * 1024;
  } catch {
    return 256 * 1024;
  }
}

/** Refuses, before the spawn, what the platform cannot pass to a new process. */
export function checkSize(
  env: NodeJS.ProcessEnv,
  command: string,
  args: readonly string[],
  platform: string,
  argMax: number = argMaxOf(),
): void {
  const strings = [
    ...Object.entries(env).map(([name, value]) => `${name}=${value ?? ""}`),
    command,
    ...args,
  ];
  let total = 0;
  for (const text of strings) {
    const bytes = Buffer.byteLength(text, "utf8") + 1;
    if (platform === "linux" && bytes > LINUX_STRING_MAX) {
      throw new CliError("capacity", "one variable or argument is too large for this platform");
    }
    // The string and its pointer in the vector.
    total += bytes + 8;
  }
  if (total > (argMax * 3) / 4) {
    throw new CliError("capacity", "the environment and arguments are too large for this platform");
  }
}

// R5-3 (Run 8.6): SIGUSR2 (a supervisor's reload or log reopening) is the
// child's too. SIGUSR1 must never open the inspector of a process that holds
// the token: the launcher starts Node with --disable-sigusr1, and Node then
// keeps SIGUSR1 blocked, so under the launcher it is neither handled here nor
// passed on (a stated limit). Started without that flag, this handler takes
// SIGUSR1 once it is registered and passes it on.
const FORWARDED = ["SIGTERM", "SIGINT", "SIGQUIT", "SIGHUP", "SIGUSR1", "SIGUSR2"] as const;
type Forwarded = (typeof FORWARDED)[number];
/** Signals no terminal sends: always the CLI's to pass on. */
const NEVER_FROM_A_TERMINAL: readonly Forwarded[] = ["SIGTERM", "SIGUSR1", "SIGUSR2"];
const numberOf = (signal: NodeJS.Signals): number =>
  (constants.signals as Record<string, number>)[signal] ?? 0;

export async function runCommand(p: {
  client: ApiClient;
  selector: Selector;
  /** Emptied once the set is resolved. */
  credential: { token: string };
  command: string;
  args: string[];
  override: boolean;
  env: NodeJS.ProcessEnv;
  tty: boolean;
  /** Ends the CLI before a child exists (a signal); process.exit by default. */
  exit?: (code: number) => never;
}): Promise<number> {
  const exit = p.exit ?? ((code: number) => process.exit(code));
  let child: ReturnType<typeof spawn> | null = null;
  const handlers = new Map<Forwarded, () => void>();
  for (const signal of FORWARDED) {
    const handler = (): void => {
      if (child === null) exit(128 + numberOf(signal));
      // With a terminal, the terminal already signalled the whole foreground
      // group, the child among them; only what no terminal sends is passed on.
      else if (NEVER_FROM_A_TERMINAL.includes(signal) || !p.tty) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const release = (): void => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  try {
    let resolved: Awaited<ReturnType<ApiClient["resolve"]>> | null = await p.client.resolve(
      p.selector,
      p.credential.token,
    );
    p.credential.token = "";
    let env: NodeJS.ProcessEnv | null = buildChildEnv(p.env, resolved.entries, p.override);
    resolved = null;
    checkSize(env, p.command, p.args, process.platform);
    const started = await new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
      const spawned = spawn(p.command, p.args, { shell: false, stdio: "inherit", env: env ?? {} });
      // From here a signal is forwarded, never an exit that would orphan it.
      child = spawned;
      spawned.once("spawn", () => {
        resolve(spawned);
      });
      spawned.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "ENOENT" || error.code === "EACCES"
            ? new CliError("usage", "the command cannot be found or executed")
            : error.code === "E2BIG"
              ? new CliError(
                  "capacity",
                  "the environment and arguments are too large to start the command",
                )
              : new CliError("unavailable", "the command could not be started"),
        );
      });
    });
    env = null;
    return await new Promise<number>((resolve) => {
      started.once("exit", (code, signal) => {
        resolve(code ?? 128 + numberOf(signal ?? "SIGKILL"));
      });
    });
  } finally {
    release();
  }
}
