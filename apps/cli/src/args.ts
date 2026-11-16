// The CLI's argument grammar (P-96, Doc 04 §7):
//
//   secrets keys   [--project <id>] [--env <name>] [--token-stdin]
//   secrets run    [--project <id>] [--env <name>] [--override] -- <command> [args…]
//   secrets export [--project <id>] [--env <name>] --output <new-file> [--token-stdin]
//   secrets --version
//
// No flag carries a token (FR-1.46). Every refusal is a usage error whose text
// names no argument: what was typed may be a token.
import { CliError } from "./errors.ts";

export type Command =
  | { name: "keys"; tokenStdin: boolean }
  | { name: "run"; override: boolean; command: string; args: string[] }
  | { name: "export"; output: string; tokenStdin: boolean }
  | { name: "version" };

export interface Parsed {
  command: Command;
  project: string | null;
  env: string | null;
}

const COMMANDS = ["keys", "run", "export"] as const;
type CommandName = (typeof COMMANDS)[number];

/** Flags that take a value, and the commands that accept each flag. */
const VALUED: ReadonlyMap<string, readonly CommandName[]> = new Map<string, readonly CommandName[]>(
  [
    ["--project", COMMANDS],
    ["--env", COMMANDS],
    ["--output", ["export"]],
  ],
);
const SWITCHES: ReadonlyMap<string, readonly CommandName[]> = new Map<
  string,
  readonly CommandName[]
>([
  ["--token-stdin", ["keys", "export"]],
  ["--override", ["run"]],
]);

const usage = (text: string): CliError =>
  new CliError(
    "usage",
    `${text}; usage: secrets keys|run|export [--project <id>] [--env <name>] …`,
  );

export function parseArgs(argv: readonly string[]): Parsed {
  if (argv.length === 1 && argv[0] === "--version") {
    return { command: { name: "version" }, project: null, env: null };
  }
  const name = argv[0];
  if (name === undefined || !(COMMANDS as readonly string[]).includes(name)) {
    throw usage("the first argument must be a command");
  }
  const command = name as CommandName;
  const values = new Map<string, string>();
  const switches = new Set<string>();
  let rest: string[] | null = null;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      rest = argv.slice(index + 1);
      break;
    }
    if (!arg.startsWith("--")) throw usage("unexpected argument (a token is never an argument)");
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (SWITCHES.get(flag)?.includes(command) === true) {
      if (equals !== -1) throw usage("a switch takes no value");
      if (switches.has(flag)) throw usage("an option was given twice");
      switches.add(flag);
      continue;
    }
    if (VALUED.get(flag)?.includes(command) !== true) {
      throw usage("unknown option for this command (a token is never an option)");
    }
    if (values.has(flag)) throw usage("an option was given twice");
    let value: string | undefined;
    if (equals !== -1) value = arg.slice(equals + 1);
    else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value === "" || value === "--")
      throw usage("an option needs a value");
    values.set(flag, value);
  }

  const selectors = { project: values.get("--project") ?? null, env: values.get("--env") ?? null };
  if (command === "run") {
    if (rest === null) throw usage("run needs -- before the command");
    const [program, ...args] = rest;
    if (program === undefined || program === "") throw usage("run needs a command after --");
    return {
      command: { name: "run", override: switches.has("--override"), command: program, args },
      ...selectors,
    };
  }
  if (rest !== null) throw usage("-- is for run only");
  if (command === "export") {
    const output = values.get("--output");
    if (output === undefined) throw usage("export needs --output <new-file>");
    return {
      command: { name: "export", output, tokenStdin: switches.has("--token-stdin") },
      ...selectors,
    };
  }
  return { command: { name: "keys", tokenStdin: switches.has("--token-stdin") }, ...selectors };
}
