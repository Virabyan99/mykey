// The operator tool (P-45). Runs on the operator's workstation; on a host it
// is reached through `node scripts/host.ts <host> ops <command…>`, which opens
// the tunnels, logs in as `maintenance` and calls `runOps` in-process.
//
// Rules: a command never takes a secret as an argument (a flag named like one
// is refused for every command); a secret it needs is read from stdin; a
// secret it produces goes to a file under ~/.mykey/out/ and only the path is
// printed. Exit codes: 0 done, 1 failed, 2 refused, 3 needs review, 64 usage.
import type { Readable, Writable } from "node:stream";
import type { DbTarget } from "@mykey/db";
import type { AppRoleName, OpenBaoTarget } from "@mykey/openbao";
import { authCleanupCommand } from "./commands/auth-cleanup.ts";
import { bootstrapOwnerCommand } from "./commands/bootstrap-owner.ts";
import { provisionOrganizationCommand } from "./commands/provision-organization.ts";
import { resetAccountCommand } from "./commands/reset-account.ts";
import { verifyOrganizationCommand } from "./commands/verify-organization.ts";

export interface OpsEnv {
  /** The database as `maintenance` (through the tunnel on a host). */
  database?: DbTarget;
  /** The directory of the auth key files (workstation custody of the host's keys). */
  keysDirectory?: string;
  /** The public origin of the host. */
  baseUrl?: string;
  /** Where ~/.mykey/out lives; the real home unless a test says otherwise. */
  home?: string;
  /** OpenBao through the tunnel with the operator (root) token from workstation custody (Run 3.8). */
  openBao?: { target: OpenBaoTarget; rootToken: string };
  /** Installs a provisioned role's credential where its process reads it (on a host: over SSH, on stdin). */
  deliver?: (name: AppRoleName, credential: { roleId: string; secretId: string }) => Promise<void>;
  /** The addresses each AppRole is bound to on this host (P-56); none when absent. */
  boundCidrs?: Record<AppRoleName, readonly string[]>;
}

export interface OpsIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env: OpsEnv;
}

export interface OpsCommand {
  /** Flags the command accepts, each with a value (`--email a@b`). */
  flags: readonly string[];
  /** One line for the usage text. */
  summary: string;
  run(flags: Readonly<Record<string, string>>, io: OpsIo): Promise<number>;
}

export const COMMANDS: Readonly<Record<string, OpsCommand>> = {
  "bootstrap-owner": bootstrapOwnerCommand,
  "auth-cleanup": authCleanupCommand,
  "reset-account": resetAccountCommand,
  "provision-organization": provisionOrganizationCommand,
  "verify-organization": verifyOrganizationCommand,
};

export const OPS_COMMANDS = Object.freeze(Object.keys(COMMANDS));

/** Flag names that would carry a secret on the command line; refused for every command. */
const SECRET_FLAGS = /pass|secret|token|code|key|link|seed/i;

export const EXIT = { ok: 0, failed: 1, refused: 2, review: 3, usage: 64 } as const;

function usage(): string {
  const lines = Object.entries(COMMANDS).map(
    ([name, command]) =>
      `  ${name} ${command.flags.map((flag) => `--${flag} <${flag}>`).join(" ")}\n      ${command.summary}`,
  );
  return `usage: ops <command> [--flag value]…\n${lines.join("\n")}\n`;
}

function parseFlags(words: readonly string[], allowed: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < words.length; i += 2) {
    const word = words[i] ?? "";
    if (!word.startsWith("--")) throw new Error(`unexpected argument ${word.slice(0, 40)}`);
    const name = word.slice(2);
    if (SECRET_FLAGS.test(name)) {
      throw new Error(`--${name} is refused: secrets are read from stdin, never from arguments`);
    }
    if (!allowed.includes(name)) throw new Error(`unknown flag --${name}`);
    const value = words[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    if (name in flags) throw new Error(`--${name} given twice`);
    flags[name] = value;
  }
  return flags;
}

/** Runs one operator command; returns its exit code. */
export async function runOps(argv: readonly string[], io: OpsIo): Promise<number> {
  const [name, ...rest] = argv;
  const command = name === undefined ? undefined : COMMANDS[name];
  if (command === undefined) {
    io.stderr.write(usage());
    return EXIT.usage;
  }
  let flags: Record<string, string>;
  try {
    flags = parseFlags(rest, command.flags);
  } catch (error) {
    io.stderr.write(`${name ?? ""}: ${(error as Error).message}\n${usage()}`);
    return EXIT.usage;
  }
  return command.run(flags, io);
}

/** Reads one line from stdin (a secret: never echoed, never logged). */
export async function readSecretLine(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const end = text.search(/\r?\n/);
  return end === -1 ? text : text.slice(0, end);
}
