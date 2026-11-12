// Harness for the two OVHcloud hosts: the host list in ~/.mykey/hosts.json,
// one-shot SSH commands, redaction of secrets, and the staging stack reached
// through `ssh -L` tunnels over the VPN. Used by scripts/host.ts and by the
// staging tests (`pnpm run test:staging`).
//
// Secrets never cross the terminal (Review focus 2): a command that names
// /etc/mykey/secrets or /root/mykey-custody is refused unless the caller says
// `secretOutput: true`, and then its output is registered with
// `registerSecret` before it is returned. Nothing in this file logs; errors
// it builds pass through `redact`.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Stack } from "./stack.ts";

export interface HostEntry {
  name: "staging" | "prod";
  publicIp: string;
  vpnIp: string;
  hostname: string;
  sshUser: "ubuntu";
}

export interface Hosts {
  region: string;
  staging: HostEntry;
  prod: HostEntry;
}

/**
 * Where the remote files live. scripts/host.ts and the files of Run 2.5
 * Task B (bootstrap, firewall, checks, compose) follow this one table.
 */
export const REMOTE = {
  hostsDir: "/opt/mykey/hosts",
  composeDir: "/opt/mykey/compose",
  hostEnv: "/etc/mykey/host.env",
  secretsDir: "/etc/mykey/secrets",
  custodyDir: "/root/mykey-custody",
  /** The host's private CA certificate (public, 0644). */
  caCert: "/etc/mykey/pki/ca.crt",
  pgSuperuserPassword: "/etc/mykey/secrets/postgres/superuser-password",
  postgres: { address: "10.78.2.2", port: 5432 },
  openbao: { address: "10.78.3.2", port: 8200 },
} as const;

// ---------------------------------------------------------------- hosts.json

export function hostsFile(home: string = homedir()): string {
  return join(home, ".mykey", "hosts.json");
}

export function sshPaths(home: string = homedir()): { key: string; knownHosts: string } {
  const dir = join(home, ".mykey", "ssh");
  return { key: join(dir, "mykey_ops_ed25519"), knownHosts: join(dir, "known_hosts") };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A DNS name of at least two lower-case labels: no IP literal syntax, no wildcard, no underscore. */
export function isHostname(value: string): boolean {
  return HOSTNAME.test(value);
}

function hostEntry(raw: unknown, name: "staging" | "prod"): HostEntry {
  if (typeof raw !== "object" || raw === null)
    throw new Error(`hosts.json: field ${name} is missing`);
  const entry = raw as Record<string, unknown>;
  const field = (key: string, valid: (value: string) => boolean): string => {
    const value = entry[key];
    if (value === undefined) throw new Error(`hosts.json: field ${name}.${key} is missing`);
    if (typeof value !== "string" || !valid(value)) {
      throw new Error(`hosts.json: field ${name}.${key} is malformed`);
    }
    return value;
  };
  field("name", (value) => value === name);
  field("sshUser", (value) => value === "ubuntu");
  return {
    name,
    publicIp: field("publicIp", (value) => IPV4.test(value)),
    vpnIp: field("vpnIp", (value) => IPV4.test(value)),
    hostname: field("hostname", (value) => HOSTNAME.test(value)),
    sshUser: "ubuntu",
  };
}

/** Reads and validates ~/.mykey/hosts.json; throws naming the missing or malformed field. */
export function loadHosts(file: string = hostsFile()): Hosts {
  if (!existsSync(file)) throw new Error(`~/.mykey/hosts.json is missing (${file})`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`~/.mykey/hosts.json is not valid JSON (${file})`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("hosts.json: not an object");
  const record = raw as Record<string, unknown>;
  const region = record.region;
  if (region === undefined) throw new Error("hosts.json: field region is missing");
  if (typeof region !== "string" || !/^[a-z0-9-]+$/.test(region)) {
    throw new Error("hosts.json: field region is malformed");
  }
  return {
    region,
    staging: hostEntry(record.staging, "staging"),
    prod: hostEntry(record.prod, "prod"),
  };
}

// ------------------------------------------------------------------- secrets

const secrets = new Set<string>();

/** From now on, every redacted text has `value` replaced by "[redacted]". */
export function registerSecret(value: string): void {
  if (value.trim() === "") return;
  secrets.add(value);
  secrets.add(value.trim());
}

export function redact(text: string): string {
  let result = text;
  // Longest first, so a secret that contains another is replaced whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(secret, "[redacted]");
  }
  return result;
}

function registerOutput(text: string): void {
  registerSecret(text);
  for (const line of text.split("\n")) {
    // Short lines ("}", "ok") would make every log unreadable; generated secrets are long.
    if (line.trim().length >= 8) registerSecret(line);
  }
}

/** True when a command or script names a secret directory (Review focus 2). A guard, not a sandbox. */
export function mentionsSecretPath(text: string): boolean {
  const normal = text.replace(/\/(\.\/)+/g, "/").replace(/\/{2,}/g, "/");
  return (
    normal.includes("mykey/secrets") ||
    normal.includes("mykey-custody") ||
    (normal.includes("/etc/mykey") && /\bsecrets\b/.test(normal))
  );
}

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

// ------------------------------------------------------------------- tunnels

export interface Tunnel {
  localPort: number;
  close(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolvePort(port);
      });
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolveConnect(false);
    });
    socket.once("error", () => {
      resolveConnect(false);
    });
  });
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    child.once("exit", () => {
      resolveStop();
    });
    child.kill();
  });
}

/** `ssh -N -L 127.0.0.1:<free port>:<address>:<port>` over the VPN, ready when it returns. */
export async function openTunnel(
  host: HostEntry,
  target: { address: string; port: number },
): Promise<Tunnel> {
  const localPort = await freePort();
  const forward = `127.0.0.1:${localPort}:${target.address}:${target.port}`;
  const child = spawn("ssh", sshArgs(host, undefined, { address: "vpn", forward }), {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const err: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  child.on("error", () => undefined);
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      const tail = Buffer.concat(err).toString("utf8").trim().slice(-500);
      throw new SshError(
        "tunnel",
        `tunnel to ${host.name} ${target.address}:${target.port} ended: ${tail}`,
      );
    }
    if (await canConnect(localPort)) return { localPort, close: () => stopProcess(child) };
    if (Date.now() > deadline) {
      await stopProcess(child);
      throw new SshError("timeout", `tunnel to ${host.name} not ready after 20 s; outcome unknown`);
    }
    await sleep(250);
  }
}

// -------------------------------------------------------------------- status

export interface HostStatus {
  host: string;
  bootId: string;
  time: string;
  clockOffsetMs: number;
  containers: Record<string, { state: string; pid: number; startedAt: string; imageId: string }>;
  sealed: boolean | null;
  sealType: string | null;
  kmsReachable: boolean | null;
  pendingRevert: string[];
  /**
   * chrony's own measurement of the system clock offset; null while
   * unsynchronised or not reported. This is the number to assert on:
   * `clockOffsetMs` compares against the workstation clock and includes about
   * half of the SSH connection set-up time (2 to 3 s observed in Run 2.5).
   */
  chronyOffsetMs: number | null;
  clockSynced: boolean | null;
  /** Whether table `inet mykey` is loaded and how many addresses each set holds; null when not reported. */
  firewall: { loaded: boolean; sets: Record<string, number> } | null;
  /** Local addresses with a listener on TCP 22; null when not reported. */
  sshListen: string[] | null;
  /** The service gate record as the host reads it (Run 3.1); null when not reported. */
  gate: "open" | "closed" | "absent" | "invalid" | null;
}

/** The remote check; prints one JSON object (everything but `clockOffsetMs`). */
export const STATUS_COMMAND = `${REMOTE.hostsDir}/checks/status.sh`;

const nullableBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

/**
 * Parses the output of checks/status.sh. `clockOffsetMs` is the host clock
 * minus the workstation clock at the middle of the request. A missing
 * reading stays `null` (rule 11: unknown is said as unknown).
 */
export function parseHostStatus(text: string, sentAt: number, receivedAt: number): HostStatus {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const str = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string" || value === "")
      throw new Error(`status.sh: field ${key} is missing`);
    return value;
  };
  const time = str("time");
  const hostTime = Date.parse(time);
  if (Number.isNaN(hostTime)) throw new Error("status.sh: field time is malformed");
  const containers: HostStatus["containers"] = {};
  const rawContainers = (raw.containers ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, container] of Object.entries(rawContainers)) {
    containers[name] = {
      state: String(container.state),
      pid: Number(container.pid),
      startedAt: String(container.startedAt),
      imageId: String(container.imageId),
    };
  }
  const pending = Array.isArray(raw.pendingRevert) ? raw.pendingRevert.map(String) : [];
  let firewall: HostStatus["firewall"] = null;
  if (typeof raw.firewall === "object" && raw.firewall !== null) {
    const report = raw.firewall as { loaded?: unknown; sets?: unknown };
    const sets: Record<string, number> = {};
    for (const [name, count] of Object.entries((report.sets ?? {}) as Record<string, unknown>)) {
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        throw new Error(`status.sh: firewall set ${name} has no count`);
      }
      sets[name] = count;
    }
    firewall = { loaded: report.loaded === true, sets };
  }
  return {
    host: str("host"),
    bootId: str("bootId"),
    time,
    clockOffsetMs: Math.round(hostTime - (sentAt + receivedAt) / 2),
    containers,
    sealed: nullableBoolean(raw.sealed),
    sealType: typeof raw.sealType === "string" ? raw.sealType : null,
    kmsReachable: nullableBoolean(raw.kmsReachable),
    pendingRevert: pending,
    chronyOffsetMs: typeof raw.chronyOffsetMs === "number" ? raw.chronyOffsetMs : null,
    clockSynced: nullableBoolean(raw.clockSynced),
    firewall,
    sshListen: Array.isArray(raw.sshListen) ? raw.sshListen.map(String) : null,
    gate:
      raw.gate === "open" ||
      raw.gate === "closed" ||
      raw.gate === "absent" ||
      raw.gate === "invalid"
        ? raw.gate
        : null,
  };
}

export async function hostStatus(
  host: HostEntry,
  address: "vpn" | "public" = "vpn",
): Promise<HostStatus> {
  const sentAt = Date.now();
  const result = await sshExec(host, STATUS_COMMAND, { sudo: true, address, timeoutMs: 60_000 });
  const receivedAt = Date.now();
  expectSuccess(result, `status of ${host.name}`);
  return parseHostStatus(result.stdout, sentAt, receivedAt);
}

// ------------------------------------------------------------- staging stack

// No `api`: on a host the API is a container, not a process of the test.
export interface StagingStack extends Omit<Stack, "api"> {
  host: HostEntry;
  status(): Promise<HostStatus>;
  reboot(): Promise<{ secondsUntilSsh: number }>;
  close(): Promise<void>;
}

/** KEY=value lines of host.env (no secrets there). */
export function parseHostEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) result[match[1]] = match[2] ?? "";
  }
  return result;
}

async function bootId(host: HostEntry): Promise<string> {
  const result = await sshExec(host, "cat /proc/sys/kernel/random/boot_id", { timeoutMs: 15_000 });
  return expectSuccess(result, "reading the boot id").stdout.trim();
}

/**
 * Connects to the staging host over the VPN: asserts the target (host.env
 * names the host of hosts.json), copies the host CA, reads the PostgreSQL
 * superuser password (registered as a secret) and opens tunnels.
 * `stop()` and `close()` only close the tunnels; nothing remote is removed.
 */
export async function connectStaging(opts: { openbao?: boolean } = {}): Promise<StagingStack> {
  const host = loadHosts().staging;
  const env = parseHostEnv(
    expectSuccess(await sshExec(host, `cat ${REMOTE.hostEnv}`), "reading host.env").stdout,
  );
  if (env.MYKEY_HOSTNAME !== host.hostname) {
    throw new Error(
      `staging target mismatch: host.env names ${env.MYKEY_HOSTNAME ?? "no host"}, hosts.json names ${host.hostname}`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "mykey-staging-"));
  const caCertPath = join(dir, "ca.crt");
  writeFileSync(
    caCertPath,
    expectSuccess(await sshExec(host, `cat ${REMOTE.caCert}`), "reading the host CA").stdout,
  );
  const password = expectSuccess(
    await sshExec(host, `cat ${REMOTE.pgSuperuserPassword}`, { sudo: true, secretOutput: true }),
    "reading the PostgreSQL superuser password",
  ).stdout.trim();

  // Run 2.7: the root token comes from the workstation's custody copy of the
  // init answer (host.ts staging bao-init); registered so it is never printed.
  let rootToken = "";
  if (opts.openbao === true) {
    const custody = join(homedir(), ".mykey", "custody", "staging", "openbao-init.json");
    if (!existsSync(custody)) {
      throw new Error(`no ${custody}: run node scripts/host.ts staging bao-init first`);
    }
    const token = (JSON.parse(readFileSync(custody, "utf8")) as { root_token?: unknown })
      .root_token;
    if (typeof token !== "string" || token === "") throw new Error(`${custody}: no root token`);
    registerSecret(token);
    rootToken = token;
  }

  let tunnels: Tunnel[] = [];
  const stack = {
    project: "staging",
    host,
    pg: {
      host: "127.0.0.1",
      port: 0,
      database: "postgres",
      superuser: { user: "postgres", password },
      caCertPath,
    },
    bao: { url: "", caCertPath, rootToken },
  };
  const openTunnels = async (): Promise<void> => {
    const pg = await openTunnel(host, REMOTE.postgres);
    tunnels = [pg];
    stack.pg.port = pg.localPort;
    if (opts.openbao === true) {
      const bao = await openTunnel(host, REMOTE.openbao);
      tunnels.push(bao);
      stack.bao.url = `https://127.0.0.1:${bao.localPort}`;
    }
  };
  const closeTunnels = async (): Promise<void> => {
    await Promise.all(tunnels.map((tunnel) => tunnel.close()));
    tunnels = [];
  };
  const close = async (): Promise<void> => {
    await closeTunnels();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await openTunnels();
  } catch (error) {
    await close();
    throw error;
  }

  const reboot = async (): Promise<{ secondsUntilSsh: number }> => {
    const before = await bootId(host);
    await closeTunnels();
    const started = Date.now();
    // The connection drops while the host goes down: exit code, 255 and a
    // timeout are all expected here. Only a new boot id proves the reboot.
    await sshExec(host, "systemctl reboot", { sudo: true, timeoutMs: 15_000 }).catch(
      () => undefined,
    );
    const deadline = started + 600_000;
    for (;;) {
      await sleep(5_000);
      const id = await bootId(host).catch(() => undefined);
      if (id !== undefined && id !== before) break;
      if (Date.now() > deadline) {
        throw new Error("staging: no new boot id within 600 s; reboot outcome unknown");
      }
    }
    const secondsUntilSsh = Math.round((Date.now() - started) / 1000);
    await openTunnels();
    return { secondsUntilSsh };
  };

  return {
    ...stack,
    status: () => hostStatus(host),
    reboot,
    close,
    stop: close,
  };
}
