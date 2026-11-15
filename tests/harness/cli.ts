// Runs the CLI as a child process (P-97): MYKEY_CLI_BIN when set (the
// installed artifact of the matrix), else `node apps/cli/dist/secrets.mjs`.
// `env` is the child's whole environment, plus PATH. A token given in env or
// on stdin must never come back on stdout or stderr: runCli throws when it
// does, with a message that does not contain it.
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export const CLI_BUNDLE = join(process.cwd(), "apps", "cli", "dist", "secrets.mjs");

export function runCli(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
  const bin = process.env.MYKEY_CLI_BIN;
  const [command, prefix] =
    bin !== undefined && bin !== "" ? [bin, []] : [process.execPath, [CLI_BUNDLE]];
  const env: Record<string, string> = { ...opts.env, PATH: process.env.PATH ?? "" };
  const secrets = [env.SECRETS_MACHINE_TOKEN, opts.stdin?.trim()].filter(
    (value): value is string => value !== undefined && value.length >= 8,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], {
      env,
      cwd: opts.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin ?? "");
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
}
