// The CLI's one order, the same for every command (P-96): refuseUnsafeRuntime
// → parseArgs → resolveApiUrl and selectorOf → readToken → client.version() →
// the command. Nothing touches the network before the first four passed;
// `--version` stops after the arguments. Every failure is one stderr line and
// its exit code; an error that is not the CLI's own prints no message at all.
import { readFileSync, statSync } from "node:fs";
import { isatty } from "node:tty";
import { API_MAJOR } from "@mykey/contracts";
import { parseArgs } from "./args.ts";
import { createClient } from "./client.ts";
import { extraCaOf, resolveApiUrl, selectorOf } from "./config.ts";
import { CliError, EXIT, formatError } from "./errors.ts";
import { exportCommand } from "./export.ts";
import { refuseUnsafeRuntime } from "./guard.ts";
import { CLI_VERSION } from "./identity.ts";
import { keysCommand } from "./keys.ts";
import { runCommand } from "./run.ts";
import { readToken } from "./token.ts";

export interface Io {
  env: NodeJS.ProcessEnv;
  execArgv: readonly string[];
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function readConfig(path: string): { text: string; mode: number; uid: number } | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return { text: readFileSync(path, "utf8"), mode: stat.mode, uid: stat.uid };
  } catch {
    return null;
  }
}

function glibcVersion(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
    .header;
  return header?.glibcVersionRuntime;
}

const write = (stream: NodeJS.WritableStream, text: string): Promise<void> =>
  new Promise((resolve) => {
    stream.write(text, () => {
      resolve();
    });
  });

export async function main(argv: readonly string[], io: Io): Promise<number> {
  try {
    refuseUnsafeRuntime({
      env: io.env,
      execArgv: io.execArgv,
      platform: process.platform,
      arch: process.arch,
      glibc: glibcVersion(),
    });
    const parsed = parseArgs(argv);
    const command = parsed.command;
    if (command.name === "version") {
      const where = `${process.platform}-${process.arch}; node ${process.versions.node}`;
      await write(io.stdout, `secrets ${CLI_VERSION} (API major ${String(API_MAJOR)}; ${where})\n`);
      return 0;
    }
    const apiUrl = resolveApiUrl(io.env, readConfig, process.getuid?.() ?? -1);
    const selector = selectorOf(parsed, io.env);
    // `run` never reads stdin: it belongs to the child.
    const credential = {
      token: await readToken(
        io.env,
        command.name !== "run" && command.tokenStdin,
        command.name === "run" ? null : io.stdin,
      ),
    };
    const extraCa = extraCaOf(io.env, (path) => readFileSync(path, "utf8"));
    const client = createClient(apiUrl, extraCa === undefined ? {} : { extraCa });
    await client.version();
    switch (command.name) {
      case "keys":
        return await keysCommand(client, selector, credential, io.stdout);
      case "run":
        return await runCommand({
          client,
          selector,
          credential,
          command: command.command,
          args: command.args,
          override: command.override,
          env: io.env,
          tty: isatty(0),
        });
      case "export":
        return await exportCommand({
          client,
          selector,
          credential,
          out: command.output,
          stderr: io.stderr,
          uid: process.getuid?.() ?? -1,
        });
    }
  } catch (error) {
    const known =
      error instanceof CliError
        ? error
        : new CliError("unavailable", "an unexpected error stopped the CLI");
    await write(io.stderr, `${formatError(known)}\n`);
    return EXIT[known.category];
  }
}
