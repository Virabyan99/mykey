// One-shot SSH commands to a host (Run 2.5). Secrets never cross the terminal:
// a command that names /etc/mykey/secrets or /root/mykey-custody is refused
// unless the caller says `secretOutput: true`, and then its output is
// registered with `registerSecret` before it is returned. Nothing here logs;
// errors pass through `redact`. Moved from tests/harness/staging.ts in Run 3.2 (M17).
import { spawn } from "node:child_process";
import { sshPaths, type HostEntry } from "./hosts.ts";
import { mentionsSecretPath, redact, registerOutput } from "./redact.ts";

// ----------------------------------------------------------------------- ssh

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `timeout`: outcome unknown (Doc 10 §4.1 rule 3). `exit`: the command ran and failed. */
export type SshErrorKind = "timeout" | "refused" | "spawn" | "exit" | "tunnel";

export class SshError extends Error {
  readonly kind: SshErrorKind;
  readonly code: number | undefined;
  constructor(kind: SshErrorKind, message: string, code?: number) {
    super(redact(message));
    this.name = "SshError";
    this.kind = kind;
    this.code = code;
  }
}

/** Runs `ssh` with the given arguments; aborting `signal` ends the process. */
export type SshRunner = (
  args: string[],
  io: { stdin?: string | Uint8Array; signal: AbortSignal },
) => Promise<SshResult>;

const spawnRunner: SshRunner = (args, io) =>
  new Promise((resolveRun, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.stdin.on("error", () => undefined); // the remote side may close stdin early
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(new SshError("spawn", `ssh could not be started (${error.code ?? "unknown error"})`));
    });
    child.on("close", (code) => {
      resolveRun({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    io.signal.addEventListener("abort", () => child.kill(), { once: true });
    child.stdin.end(io.stdin);
  });

let runner: SshRunner = spawnRunner;

/** Replaces how `ssh` is run (unit tests); `undefined` restores the real one. */
export function setSshRunner(replacement: SshRunner | undefined): void {
  runner = replacement ?? spawnRunner;
}

/** POSIX single-quoting: the result is one word for any input. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** An ssh_config value; a path with a space must be one quoted token. */
function configValue(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** Forward slashes, accepted by both the Windows and the MSYS build of OpenSSH. */
function portablePath(path: string): string {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

/**
 * The argument array for one `ssh` invocation. Every call is a new TCP
 * connection (no multiplexing), and the host key recorded under the public
 * address is checked whichever address is used.
 */
export function sshArgs(
  host: HostEntry,
  command: string | undefined,
  opts: {
    address: "vpn" | "public";
    paths?: { key: string; knownHosts: string };
    /** `-L` forward, `127.0.0.1:<local>:<address>:<port>`; with it, no command runs. */
    forward?: string;
  },
): string[] {
  const paths = opts.paths ?? sshPaths();
  const args = [
    "-i",
    portablePath(paths.key),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${configValue(portablePath(paths.knownHosts))}`,
    "-o",
    `HostKeyAlias=${host.publicIp}`,
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-l",
    host.sshUser,
  ];
  if (opts.forward !== undefined) {
    args.push("-N", "-o", "ExitOnForwardFailure=yes", "-L", opts.forward);
  } else {
    args.push("-T");
  }
  args.push(opts.address === "public" ? host.publicIp : host.vpnIp);
  if (command !== undefined) args.push(command);
  return args;
}

/** The command line the remote login shell runs. */
export function remoteCommand(command: string, sudo: boolean): string {
  return sudo ? `sudo -n -- sh -c ${shQuote(command)}` : command;
}

/**
 * Runs one command on a host over a new SSH connection. A non-zero exit
 * resolves with its `code`; a timeout rejects with kind `timeout` (the
 * command may have run). Defaults: VPN address, 60 s.
 */
export async function sshExec(
  host: HostEntry,
  command: string,
  opts: {
    stdin?: string | Uint8Array;
    sudo?: boolean;
    timeoutMs?: number;
    address?: "vpn" | "public";
    secretOutput?: boolean;
  } = {},
): Promise<SshResult> {
  const secretOutput = opts.secretOutput === true;
  const script = typeof opts.stdin === "string" ? opts.stdin : "";
  if (!secretOutput && (mentionsSecretPath(command) || mentionsSecretPath(script))) {
    throw new SshError(
      "refused",
      `refused: a command for ${host.name} names /etc/mykey/secrets or /root/mykey-custody without secretOutput`,
    );
  }
  if (secretOutput && typeof opts.stdin === "string") registerOutput(opts.stdin);
  const address = opts.address ?? "vpn";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const args = sshArgs(host, remoteCommand(command, opts.sudo === true), { address });
  const controller = new AbortController();
  const timeoutError = new SshError(
    "timeout",
    `ssh to ${host.name} (${address}) timed out after ${timeoutMs} ms; outcome unknown`,
  );
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject before aborting: the aborted process may still report an exit
      // code, and that must not be mistaken for the command's own outcome.
      reject(timeoutError);
      controller.abort();
    }, timeoutMs);
  });
  const io: { stdin?: string | Uint8Array; signal: AbortSignal } = { signal: controller.signal };
  if (opts.stdin !== undefined) io.stdin = opts.stdin;
  let result: SshResult;
  try {
    result = await Promise.race([runner(args, io), timedOut]);
  } finally {
    clearTimeout(timer);
  }
  if (controller.signal.aborted) throw timeoutError;
  if (secretOutput) {
    registerOutput(result.stdout);
    registerOutput(result.stderr);
  }
  return result;
}

/** Returns the result when the command exited 0; otherwise throws with the redacted end of stderr. */
export function expectSuccess(result: SshResult, what: string): SshResult {
  if (result.code === 0) return result;
  const tail = result.stderr.trim().slice(-2000);
  throw new SshError("exit", `${what} failed with exit code ${result.code}: ${tail}`, result.code);
}
