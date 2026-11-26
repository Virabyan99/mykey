// The CLI where it is allowed to run (Run 5.6 Task C). On Linux and macOS:
// the bundle directly. On Windows: the bundle in the pinned glibc Node image,
// mounted read-only, with the environment passed by name only (`-e NAME`), so
// no value and no token is ever on a command line; the docker client takes
// the values from its own environment. Output that holds the token rejects.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CliResult } from "./cli.ts";

// Session 11 (Run 11.8): MYKEY_CLI_DIST names a directory that holds another
// `secrets.mjs`, the bundle of a published release unpacked from its archive,
// so an older CLI can be run against a newer host (spec §6 item 12).
const DIST = process.env.MYKEY_CLI_DIST ?? join(process.cwd(), "apps", "cli", "dist");

function glibcImage(): string {
  const lock = JSON.parse(readFileSync("infra/dependencies.lock.json", "utf8")) as {
    images: Record<string, { image: string; tag: string; variant?: string; digest: string }>;
  };
  const pin = lock.images["node-glibc"];
  if (pin === undefined) throw new Error("infra/dependencies.lock.json has no images.node-glibc");
  return `${pin.image}:${pin.tag}${pin.variant === undefined ? "" : `-${pin.variant}`}@${pin.digest}`;
}

/** `command` where the CLI runs; MYKEY_CLI_COMMAND is how a shell script starts the CLI. */
function where(command: string[], env: Record<string, string>): Promise<CliResult> {
  const local = process.platform !== "win32";
  const cli = local ? `${process.execPath} ${join(DIST, "secrets.mjs")}` : "node /cli/secrets.mjs";
  const full = { ...env, MYKEY_CLI_COMMAND: cli };
  const [program, args, childEnv] = local
    ? [command[0] ?? "", command.slice(1), { ...full, PATH: process.env.PATH ?? "" }]
    : [
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--platform",
          "linux/amd64",
          ...Object.keys(full).flatMap((name) => ["-e", name]),
          "--mount",
          `type=bind,src=${DIST},dst=/cli,readonly`,
          glibcImage(),
          ...command,
        ],
        { ...process.env, ...full },
      ];
  const secrets = [env.SECRETS_MACHINE_TOKEN].filter(
    (value): value is string => value !== undefined && value.length >= 8,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => undefined);
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
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

/** `secrets <args>` where the CLI runs. */
export function runCliInLinux(
  args: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<CliResult> {
  const env = opts.env ?? {};
  if (process.platform !== "win32") {
    return where([process.execPath, join(DIST, "secrets.mjs"), ...args], env);
  }
  return where(["node", "/cli/secrets.mjs", ...args], env);
}

/** A POSIX shell script where the CLI runs; it starts the CLI as `$MYKEY_CLI_COMMAND`. */
export function runShellInLinux(
  script: string,
  opts: { env?: Record<string, string> } = {},
): Promise<CliResult> {
  return where(["sh", "-c", script], opts.env ?? {});
}
