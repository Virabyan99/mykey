// Runs the CLI as a child process (P-97): MYKEY_CLI_BIN when set (the
// installed artifact of the matrix), else `node apps/cli/dist/secrets.mjs`.
// `env` is the child's whole environment, plus PATH. A token given in env or
// on stdin must never come back on stdout or stderr: the result rejects when
// it does, with a message that does not contain it.
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export const CLI_BUNDLE = join(process.cwd(), "apps", "cli", "dist", "secrets.mjs");

/** The command line that starts the CLI: [program, ...arguments before the CLI's own]. */
export function cliCommand(): [string, string[]] {
  const bin = process.env.MYKEY_CLI_BIN;
  return bin !== undefined && bin !== "" ? [bin, []] : [process.execPath, [CLI_BUNDLE]];
}

export interface StartedCli {
  pid: number;
  kill(signal: NodeJS.Signals): void;
  write(text: string): void;
  end(): void;
  result: Promise<CliResult>;
}

export interface StartOptions {
  env?: Record<string, string>;
  /** Written and closed at once; with `keepStdinOpen` written and left open. */
  stdin?: string;
  keepStdinOpen?: boolean;
  cwd?: string;
  timeoutMs?: number;
  /** A process group of its own (the test can then list the group's processes). */
  detached?: boolean;
  /** Run the CLI through this program: [program, ...args]; the CLI's command line follows. */
  through?: [string, string[]] | ((cli: string[]) => [string, string[]]);
}

export function startCli(args: string[], opts: StartOptions = {}): StartedCli {
  const [program, prefix] = cliCommand();
  const cli = [program, ...prefix, ...args];
  const [command, commandArgs] =
    opts.through === undefined
      ? [cli[0] ?? "", cli.slice(1)]
      : typeof opts.through === "function"
        ? opts.through(cli)
        : [opts.through[0], [...opts.through[1], ...cli]];
  const env: Record<string, string> = { ...opts.env, PATH: process.env.PATH ?? "" };
  // stdin is a token only when the CLI is told to read one there.
  const stdinToken = args.includes("--token-stdin") ? opts.stdin?.trim() : undefined;
  const secrets = [env.SECRETS_MACHINE_TOKEN, stdinToken].filter(
    (value): value is string => value !== undefined && value.length >= 8,
  );
  const child = spawn(command, commandArgs, {
    env,
    cwd: opts.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: opts.detached ?? false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdin.on("error", () => undefined);
  if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
  if (opts.keepStdinOpen !== true) child.stdin.end();
  const result = new Promise<CliResult>((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (secrets.some((secret) => stdout.includes(secret) || stderr.includes(secret))) {
        reject(new Error("the CLI printed the token it was given"));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
  return {
    pid: child.pid ?? -1,
    kill: (signal) => child.kill(signal),
    write: (text) => child.stdin.write(text),
    end: () => child.stdin.end(),
    result,
  };
}

export function runCli(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
  return startCli(args, opts).result;
}
