// The operator's tool for the two OVHcloud hosts. Run: node scripts/host.ts
// <staging|prod> <command> (see USAGE). Every remote step is one SSH command
// through apps/ops/src/remote (@mykey/ops/remote); nothing is printed except through the
// redacting logger, and no file under /etc/mykey/secrets or /root/mykey-custody
// is ever printed (Review focus 2).
//
// Exit codes: 0 done, 1 failed, 2 usage, 3 timed out (outcome unknown, Doc 10
// §4.1 rule 3: look at the host before doing anything else).
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  REMOTE,
  SshError,
  expectSuccess,
  formatStatusView,
  hostStatus,
  isHostname,
  statusView,
  loadHosts,
  mentionsSecretPath,
  openTunnel,
  parseHostEnv,
  redact,
  registerSecret,
  shQuote,
  sshExec,
  type HostEntry,
  type Hosts,
} from "@mykey/ops/remote";
import { KEY_RINGS } from "@mykey/auth";
import { loadR2Credentials } from "@mykey/backup";
import type { RoleName } from "@mykey/db";
import { readOpsJobs } from "./ops-jobs.ts";
import { probeState } from "./probe.ts";

const REPOSITORY = resolve(import.meta.dirname, "..");
const FIREWALL = `${REMOTE.hostsDir}/firewall`;
const BOOTSTRAP = `${REMOTE.hostsDir}/bootstrap`;
const REVERT_SECONDS = 300;
const WG_PORT = 51820;
/** A host starts on the staging directory; `acme production` is a deliberate step (Run 2.5). */
export const ACME_DIRECTORIES = {
  staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
  production: "https://acme-v02.api.letsencrypt.org/directory",
} as const;
export type AcmeDirectory = keyof typeof ACME_DIRECTORIES;
const COMPOSE = `docker compose --env-file ${REMOTE.hostEnv} -f ${REMOTE.composeDir}/host.compose.yml -p mykey`;
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;

type Address = "vpn" | "public";
type HostName = "staging" | "prod";

// -------------------------------------------------------------------- logger

export interface Logger {
  info(line: string): void;
  error(line: string): void;
}

/** Every line passes through `redact` before it is written. */
export function createLogger(
  writers: { out: (text: string) => void; err: (text: string) => void } = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
): Logger {
  return {
    info: (line) => {
      writers.out(`${redact(line)}\n`);
    },
    error: (line) => {
      writers.err(`${redact(line)}\n`);
    },
  };
}

// ----------------------------------------------------------------- arguments

export const USAGE = `usage: node scripts/host.ts <staging|prod> <command> [--public]
  bootstrap                      first contact over the public address; idempotent
  push                           infra/hosts/** and infra/compose/host* to /opt/mykey
  apply <firewall|ssh>           apply with a ${REVERT_SECONDS} s automatic revert
  confirm                        cancel the pending revert, from a new connection
  image <name> <tar>             docker load; records <NAME>_IMAGE in host.env
  maint <minutes> -- <command>   open registry egress, run the command, close it
  acme <staging|production>      choose the Let's Encrypt directory; drops the edge's certificates
  kms-csr <name>                 new EC key on the host (kept there) and its CSR, printed
  kms-install <tar>              okms from the pinned release archive (staging only)
  kms-cert <name> <crt>          install a KMS certificate next to its key (staging only)
  kms-use <name>                 point seal.crt/seal.key at that certificate (staging only)
  kms-import <name> <crt> <key>  a workstation key and its certificate, for a test (staging only)
  kms-remove <name>              shred a certificate's key, unless the seal uses it (staging only)
  kms <name> -- <okms args>      run okms with that certificate (staging only)
  env <key> <value>              set an OpenBao/KMS setting in host.env (staging only)
  up                             create missing host secrets, then docker compose up -d
  db-init                        roles and migrations through an SSH tunnel
  bao-init                       initialise OpenBao once; custody copy; root-namespace setup (staging only)
  status [--json]                the private status view: every check with its observation time (P-117)
  gate <open|close|status>       the service gate record (P-43); every deploy starts closed
  keys init                      the auth key rings: new files on the workstation, installed on the host
  ops <command> [--flag value]   an operator command (apps/ops) as maintenance, through a tunnel
  ops-secrets                    role passwords for ops jobs on the host; MYKEY_HOST_NAME in host.env
  r2-install <audit-archive|pairs|pairs-cleanup>  the S3 credentials of that job's R2 token, on stdin
  backup-init                    backup password and signing key made on the host; trust anchor; AppRole backup
  backup-custody                 copy the backup password and signing key to ~/.mykey/custody/<host>/backup/
  timers                         install and start the job timers (ops-jobs.json, audit rotation)
  gate open --report <file>      opens with a verification report (v2; Run 6.7)
  gate close [--verifying]       closes; --verifying lets the verification listener serve
  tunnel verify                  a local port to the API's verification listener (Ctrl-C ends it)
  restore --source <host> (--pair <id> | --newest)   P-124 steps 1–7: restore a pair, start closed + verifying
  restore-verify --confirm-members <n> (--journey | --owner-confirmed) [--open]   the report; --open opens
  quiesce                        gate close, stop api and provisioner, restart OpenBao (staging only)
  resume                         start api and provisioner; the gate stays closed until gate open
--public uses the public address instead of the VPN (bootstrap always does).`;

export type HostCommand = { host: HostName; via: Address } & (
  | {
      command:
        | "bootstrap"
        | "push"
        | "confirm"
        | "up"
        | "db-init"
        | "bao-init"
        | "quiesce"
        | "resume"
        | "ops-secrets"
        | "backup-init"
        | "backup-custody"
        | "timers";
    }
  | { command: "status"; json: boolean }
  | { command: "apply"; target: "firewall" | "ssh" }
  | { command: "image"; name: string; tar: string }
  | { command: "acme"; directory: AcmeDirectory }
  | { command: "kms-csr"; name: string }
  | { command: "kms-install"; tar: string }
  | { command: "kms-cert"; name: string; crt: string }
  | { command: "kms-use"; name: string }
  | { command: "kms-import"; name: string; crt: string; key: string }
  | { command: "kms-remove"; name: string }
  | { command: "kms"; name: string; argv: string[] }
  | { command: "env"; key: OpenBaoEnvKey; value: string }
  | { command: "maint"; minutes: number; argv: string[] }
  | { command: "gate"; action: GateAction; report?: string; verifying?: true }
  | { command: "tunnel"; target: "verify" }
  | { command: "restore"; source: HostName; pair: string }
  | {
      command: "restore-verify";
      confirmMembers: number;
      journey: "run" | "owner-confirmed";
      open: boolean;
    }
  | { command: "keys"; action: "init" }
  | { command: "ops"; argv: string[] }
  | { command: "r2-install"; name: R2InstallName }
);

export type GateAction = "open" | "close" | "status";

/**
 * Run 6.7 (P-122): `gate open [--report <file>]`, `gate close [--verifying]`,
 * `gate status`. A v2 host needs the report to open; a v1 host (no incarnation
 * in host.env yet, until Run 6.9's first deploy) opens without one.
 */
const PAIR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `restore --source <host> (--pair <id> | --newest)`: P-124 steps 1–7. */
function parseRestoreArgs(host: "staging" | "prod", rest: string[]): HostCommand {
  let source: HostName | null = null;
  const pairs: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i];
    const value = rest[i + 1];
    if (word === "--source") {
      if (value !== "staging" && value !== "prod") {
        throw new Error("restore --source needs staging or prod");
      }
      source = value;
      i += 1;
    } else if (word === "--newest") {
      pairs.push("newest");
    } else if (word === "--pair") {
      if (value === undefined || !PAIR_ID.test(value))
        throw new Error("restore --pair needs a pair id");
      pairs.push(value);
      i += 1;
    } else {
      throw new Error(`restore: unknown word ${String(word)}`);
    }
  }
  if (source === null) throw new Error("restore needs --source <staging|prod>");
  const [pair] = pairs;
  if (pairs.length !== 1 || pair === undefined) {
    throw new Error("restore needs exactly one of --pair <id> or --newest");
  }
  return { host, via: "vpn", command: "restore", source, pair };
}

/** `restore-verify --confirm-members <n> (--journey | --owner-confirmed) [--open]`: steps 8–9. */
function parseRestoreVerifyArgs(host: "staging" | "prod", rest: string[]): HostCommand {
  let confirmMembers: number | null = null;
  const journeys: ("run" | "owner-confirmed")[] = [];
  let open = false;
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i];
    if (word === "--confirm-members") {
      const value = rest[i + 1] ?? "";
      if (!/^[0-9]{1,6}$/.test(value)) throw new Error("--confirm-members needs a count");
      confirmMembers = Number(value);
      i += 1;
    } else if (word === "--journey") {
      journeys.push("run");
    } else if (word === "--owner-confirmed") {
      journeys.push("owner-confirmed");
    } else if (word === "--open") {
      open = true;
    } else {
      throw new Error(`restore-verify: unknown word ${String(word)}`);
    }
  }
  if (confirmMembers === null) throw new Error("restore-verify needs --confirm-members <count>");
  const [journey] = journeys;
  if (journeys.length !== 1 || journey === undefined) {
    throw new Error("restore-verify needs exactly one of --journey or --owner-confirmed");
  }
  return { host, via: "vpn", command: "restore-verify", confirmMembers, journey, open };
}

function parseGateArgs(host: "staging" | "prod", rest: string[]): HostCommand {
  const [action, ...more] = rest;
  const base = { host, via: "vpn", command: "gate" } as const;
  if (action === "open") {
    if (more.length === 0) return { ...base, action };
    if (more[0] === "--report") {
      if (more.length !== 2 || more[1] === undefined || more[1].startsWith("--")) {
        throw new Error("gate open --report needs one file");
      }
      return { ...base, action, report: more[1] };
    }
  } else if (action === "close") {
    if (more.length === 0) return { ...base, action };
    if (more.length === 1 && more[0] === "--verifying") return { ...base, action, verifying: true };
  } else if (action === "status" && more.length === 0) {
    return { ...base, action };
  }
  throw new Error("gate needs open [--report <file>], close [--verifying] or status");
}

/** The host.env settings `env` may write: OpenBao and its KMS (Run 2.7). */
export const OPENBAO_ENV_KEYS = [
  "MYKEY_OPENBAO",
  "MYKEY_KMS_HOST",
  "MYKEY_KMS_SEAL_KEY_ID",
  "MYKEY_BAO_URL",
] as const;
export type OpenBaoEnvKey = (typeof OPENBAO_ENV_KEYS)[number];

/** Production holds no OpenBao and no KMS material in Session 2. */
const STAGING_ONLY = new Set([
  "kms-install",
  "kms-cert",
  "kms-use",
  "kms-import",
  "kms-remove",
  "kms",
  "env",
  "bao-init",
  "quiesce",
  "resume",
]);
const CERT_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export function parseHostArgs(argv: string[]): HostCommand {
  const [host, command, ...rest] = argv;
  if (host === undefined || command === undefined) throw new Error(USAGE);
  if (host !== "staging" && host !== "prod") {
    throw new Error(`unknown host "${host}": use staging or prod`);
  }
  if (host === "prod" && STAGING_ONLY.has(command)) {
    throw new Error(`${command}: production holds no OpenBao or KMS material in Session 2`);
  }
  if (command === "ops") {
    // Everything after `ops` belongs to the operator tool, flags included.
    if (rest.length === 0) throw new Error("ops needs a command (see apps/ops)");
    return { host, via: "vpn", command, argv: rest };
  }
  if (command === "gate") return parseGateArgs(host, rest);
  if (command === "restore") return parseRestoreArgs(host, rest);
  if (command === "restore-verify") return parseRestoreVerifyArgs(host, rest);
  if (command === "tunnel") {
    if (rest.length !== 1 || rest[0] !== "verify") throw new Error("tunnel needs verify");
    return { host, via: "vpn", command, target: "verify" };
  }
  let words = rest;
  let tail: string[] = [];
  if (command === "maint" || command === "kms") {
    const separator = rest.indexOf("--");
    if (separator < 0) throw new Error(`${command} needs -- before the command`);
    words = rest.slice(0, separator);
    tail = rest.slice(separator + 1);
  }
  const options = words.filter((word) => word.startsWith("--"));
  const positional = words.filter((word) => !word.startsWith("--"));
  for (const option of options) {
    if (option !== "--public" && !(option === "--json" && command === "status")) {
      throw new Error(`unknown option ${option}`);
    }
  }
  const via: Address = command === "bootstrap" || options.includes("--public") ? "public" : "vpn";
  const base = { host, via } as const;
  switch (command) {
    case "bootstrap":
    case "push":
    case "confirm":
    case "up":
    case "db-init":
    case "bao-init":
    case "quiesce":
    case "resume":
    case "ops-secrets":
    case "backup-init":
    case "backup-custody":
    case "timers":
      if (positional.length !== 0) throw new Error(USAGE);
      return { ...base, command };
    case "status":
      if (positional.length !== 0) throw new Error(USAGE);
      return { ...base, command, json: options.includes("--json") };
    case "apply": {
      const target = positional[0];
      if (positional.length !== 1 || (target !== "firewall" && target !== "ssh")) {
        throw new Error("apply needs one target: firewall|ssh");
      }
      return { ...base, command, target };
    }
    case "image": {
      const [name, tar] = positional;
      if (name === undefined || tar === undefined || positional.length !== 2)
        throw new Error(USAGE);
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) {
        throw new Error("image name must be lower-case letters, digits and hyphens");
      }
      return { ...base, command, name, tar };
    }
    case "acme": {
      const directory = positional[0];
      if (positional.length !== 1 || (directory !== "staging" && directory !== "production")) {
        throw new Error("acme needs one directory: staging|production");
      }
      return { ...base, command, directory };
    }
    case "kms-csr": {
      const name = positional[0];
      if (positional.length !== 1 || name === undefined || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) {
        throw new Error("kms-csr needs one certificate name: lower-case letters, digits, hyphens");
      }
      return { ...base, command, name };
    }
    case "kms-install": {
      const tar = positional[0];
      if (positional.length !== 1 || tar === undefined) throw new Error("kms-install needs <tar>");
      return { ...base, command, tar };
    }
    case "kms-cert": {
      const [name, crt] = positional;
      if (
        positional.length !== 2 ||
        name === undefined ||
        crt === undefined ||
        !CERT_NAME.test(name)
      ) {
        throw new Error("kms-cert needs <name> <certificate file>");
      }
      return { ...base, command, name, crt };
    }
    case "kms-use": {
      const name = positional[0];
      if (positional.length !== 1 || name === undefined || !CERT_NAME.test(name)) {
        throw new Error("kms-use needs one certificate name");
      }
      return { ...base, command, name };
    }
    case "kms-import": {
      const [name, crt, key] = positional;
      if (
        positional.length !== 3 ||
        name === undefined ||
        crt === undefined ||
        key === undefined ||
        !CERT_NAME.test(name) ||
        name === "seal"
      ) {
        throw new Error("kms-import needs <name> <certificate file> <key file>; not seal");
      }
      return { ...base, command, name, crt, key };
    }
    case "kms-remove": {
      const name = positional[0];
      if (
        positional.length !== 1 ||
        name === undefined ||
        !CERT_NAME.test(name) ||
        name === "seal"
      ) {
        throw new Error("kms-remove needs one certificate name; not seal");
      }
      return { ...base, command, name };
    }
    case "kms": {
      const name = positional[0];
      if (positional.length !== 1 || name === undefined || !CERT_NAME.test(name)) {
        throw new Error("kms needs one certificate name before --");
      }
      if (tail.length === 0) throw new Error("kms needs okms arguments after --");
      return { ...base, command, name, argv: tail };
    }
    case "env": {
      const [key, value] = positional;
      if (
        positional.length !== 2 ||
        value === undefined ||
        !(OPENBAO_ENV_KEYS as readonly string[]).includes(key ?? "")
      ) {
        throw new Error(`env needs <key> <value>; keys: ${OPENBAO_ENV_KEYS.join(", ")}`);
      }
      return { ...base, command, key: key as OpenBaoEnvKey, value };
    }
    case "keys": {
      if (positional.length !== 1 || positional[0] !== "init") {
        throw new Error("keys needs init");
      }
      return { ...base, command, action: "init" };
    }
    case "r2-install": {
      const [name] = positional;
      if (positional.length !== 1 || !(name !== undefined && name in R2_INSTALLS)) {
        throw new Error(`r2-install needs one of: ${Object.keys(R2_INSTALLS).join(", ")}`);
      }
      return { ...base, command, name: name as R2InstallName };
    }
    case "maint": {
      const minutes = Number(positional[0]);
      if (positional.length !== 1 || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
        throw new Error("maint minutes must be an integer from 1 to 60");
      }
      if (tail.length === 0) throw new Error("maint needs a command after --");
      return { ...base, command, minutes, argv: tail };
    }
    default:
      throw new Error(`unknown command "${command}"\n${USAGE}`);
  }
}

// -------------------------------------------------------------- egress names

export const EGRESS_PURPOSES = ["acme", "kms", "r2", "probe", "apt", "registry"] as const;
export type EgressPurpose = (typeof EGRESS_PURPOSES)[number];

/** Lines `purpose name` of infra/hosts/firewall/egress-names.conf; throws naming the line. */
export function parseEgressNames(text: string): { purpose: EgressPurpose; name: string }[] {
  const entries: { purpose: EgressPurpose; name: string }[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const where = `egress-names.conf line ${index + 1}`;
    const fields = line.split(/\s+/);
    const [purpose, name] = fields;
    if (fields.length !== 2 || purpose === undefined || name === undefined) {
      throw new Error(`${where}: expected "purpose name"`);
    }
    if (!(EGRESS_PURPOSES as readonly string[]).includes(purpose)) {
      throw new Error(`${where}: unknown purpose ${purpose}`);
    }
    if (/^[\d.]+$/.test(name) || !isHostname(name)) {
      throw new Error(`${where}: ${name} is not a DNS name (no IP address, no wildcard)`);
    }
    entries.push({ purpose: purpose as EgressPurpose, name });
  });
  return entries;
}

// ---------------------------------------------------------------------- push

export interface PushFile {
  /** Repository-relative, forward slashes. */
  localPath: string;
  remotePath: string;
  owner: "root";
  group: "root";
  mode: 0o644 | 0o755;
  sha256: string;
  content: Buffer;
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/**
 * infra/hosts/** → /opt/mykey/hosts, infra/compose/host* → /opt/mykey/compose.
 * Refuses any file with a carriage return (naming every one) and a malformed
 * egress-names.conf. Every file gets owner root:root and mode 0755 (*.sh) or 0644.
 */
export function collectPushFiles(root: string = REPOSITORY): PushFile[] {
  const compose = join(root, "infra/compose");
  const composeEntries = existsSync(compose) ? readdirSync(compose, { withFileTypes: true }) : [];
  const sources = [
    ...walk(join(root, "infra/hosts")),
    ...composeEntries
      .filter((entry) => entry.name.startsWith("host"))
      .flatMap((entry) => {
        const path = join(compose, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
      }),
  ];
  const files: PushFile[] = [];
  const withCarriageReturn: string[] = [];
  for (const source of sources) {
    const localPath = source.slice(root.length + 1).replaceAll("\\", "/");
    if (localPath.endsWith("/.gitkeep")) continue;
    // Printable ASCII only: the readback is line-based, one line per file.
    if (/[^ -~]/.test(localPath)) throw new Error(`${localPath}: unusable file name`);
    const content = readFileSync(source);
    if (content.includes(0x0d)) {
      withCarriageReturn.push(localPath);
      continue;
    }
    if (localPath === "infra/hosts/firewall/egress-names.conf") {
      try {
        parseEgressNames(content.toString("utf8"));
      } catch (error) {
        throw new Error(`${localPath}: ${(error as Error).message}`, { cause: error });
      }
    }
    const remotePath = localPath.startsWith("infra/hosts/")
      ? `${REMOTE.hostsDir}/${localPath.slice("infra/hosts/".length)}`
      : `${REMOTE.composeDir}/${localPath.slice("infra/compose/".length)}`;
    files.push({
      localPath,
      remotePath,
      owner: "root",
      group: "root",
      mode: localPath.endsWith(".sh") ? 0o755 : 0o644,
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    });
  }
  if (withCarriageReturn.length > 0) {
    throw new Error(`refused, carriage return in: ${withCarriageReturn.sort().join(", ")}`);
  }
  return files.sort((a, b) => a.remotePath.localeCompare(b.remotePath));
}

/** A root shell script, fed on stdin, that installs every file with its owner and mode. */
export function pushScript(files: PushFile[]): string {
  const lines = ["set -eu", "umask 022", 'tmp="$(mktemp)"', `trap 'rm -f "$tmp"' EXIT`];
  for (const file of files) {
    const encoded = file.content.toString("base64").replace(/.{1,76}/g, "$&\n");
    lines.push(
      `base64 -d > "$tmp" <<'MYKEY_PUSH_EOF'\n${encoded}MYKEY_PUSH_EOF`,
      `install -D -o ${file.owner} -g ${file.group} -m 0${file.mode.toString(8)} "$tmp" ${shQuote(file.remotePath)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Prints `owner:group:mode sha256` for every file, in order. */
export function readbackScript(files: PushFile[]): string {
  const paths = files.map((file) => shQuote(file.remotePath)).join(" ");
  return [
    `for p in ${paths}; do`,
    `  printf '%s %s\\n' "$(stat -c '%U:%G:%a' -- "$p")" "$(sha256sum -- "$p" | cut -c1-64)"`,
    "done",
    "",
  ].join("\n");
}

/** Every difference between what was pushed and what the host reports. */
export function verifyReadback(files: PushFile[], output: string): string[] {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  const problems: string[] = [];
  if (lines.length !== files.length) {
    problems.push(`readback returned ${lines.length} lines for ${files.length} files`);
  }
  files.forEach((file, index) => {
    const expected = `${file.owner}:${file.group}:${file.mode.toString(8)} ${file.sha256}`;
    const actual = lines[index]?.trim();
    if (actual !== undefined && actual !== expected) {
      problems.push(`${file.remotePath}: expected ${expected}, host reports ${actual}`);
    }
  });
  return problems;
}

/** Installs the files over stdin, then reads owner, mode and content back over a new connection. */
export async function pushFiles(
  host: HostEntry,
  files: PushFile[],
  opts: { address: Address },
): Promise<void> {
  if (files.length === 0) throw new Error("nothing to push");
  const timeoutMs = 300_000;
  const installed = await sshExec(host, "sh -s", {
    sudo: true,
    stdin: pushScript(files),
    address: opts.address,
    timeoutMs,
  });
  expectSuccess(installed, `push to ${host.name}`);
  const back = await sshExec(host, "sh -s", {
    stdin: readbackScript(files),
    address: opts.address,
    timeoutMs,
  });
  const problems = verifyReadback(files, expectSuccess(back, `readback on ${host.name}`).stdout);
  if (problems.length > 0) {
    throw new Error(`push to ${host.name}: readback mismatch\n${problems.join("\n")}`);
  }
}

// ---------------------------------------------------------- apply and confirm

const APPLY_SCRIPTS = {
  firewall: {
    apply: `${FIREWALL}/mykey-egress.sh apply`,
    revert: `${FIREWALL}/mykey-egress.sh revert`,
  },
  ssh: { apply: `${BOOTSTRAP}/30-ssh.sh apply`, revert: `${BOOTSTRAP}/30-ssh.sh revert` },
} as const;

/** Starts the revert timer first, then applies (apply-with-revert.sh, Review focus 1). */
export function applyCommand(target: "firewall" | "ssh"): string {
  const { apply, revert } = APPLY_SCRIPTS[target];
  return `${FIREWALL}/apply-with-revert.sh ${target} ${shQuote(apply)} ${shQuote(revert)} ${REVERT_SECONDS}`;
}

/**
 * Run without sudo by the login shell of a new connection: prints when this
 * connection's sshd process started and when each pending revert timer was
 * started, both in microseconds since boot (CLOCK_MONOTONIC; a VPS does not
 * suspend, so it matches the boot clock of /proc/<pid>/stat).
 */
export const CONFIRM_PROBE = [
  "set -eu",
  'tck="$(getconf CLK_TCK)"',
  `start="$(sed 's/^.*) //' /proc/$PPID/stat | cut -d' ' -f20)"`,
  'echo "connection $((start * 1000000 / tck))"',
  "for u in $(systemctl list-units --plain --no-legend --state=active 'mykey-revert-*.timer' | awk '{print $1}'); do",
  '  echo "pending $u $(systemctl show -p ActiveEnterTimestampMonotonic --value "$u")"',
  "done",
].join("\n");

export interface ConfirmProbe {
  connectionUs: number;
  pending: { unit: string; activatedUs: number }[];
}

const REVERT_UNIT = /^mykey-revert-[a-z0-9-]+\.timer$/;

export function parseConfirmProbe(text: string): ConfirmProbe {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const first = /^connection (\d+)$/.exec(lines[0]?.trim() ?? "");
  if (first?.[1] === undefined) throw new Error("confirm probe: no connection start time");
  const pending = lines.slice(1).map((line) => {
    const match = /^pending (\S+) (\d+)$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined || !REVERT_UNIT.test(match[1])) {
      throw new Error("confirm probe: unexpected line");
    }
    return { unit: match[1], activatedUs: Number(match[2]) };
  });
  return { connectionUs: Number(first[1]), pending };
}

/** Cancel only reverts started before this connection was opened; otherwise refuse. */
export function confirmPlan(probe: ConfirmProbe): { cancel: string[] } | { refuse: string } {
  if (probe.pending.length === 0) return { refuse: "no pending revert on this host" };
  const unproven = probe.pending.filter(
    (entry) => entry.activatedUs === 0 || entry.activatedUs >= probe.connectionUs,
  );
  if (unproven.length > 0) {
    return {
      refuse: `this connection is not newer than the apply of ${unproven.map((entry) => entry.unit).join(", ")}; confirm again from a new connection`,
    };
  }
  return { cancel: probe.pending.map((entry) => entry.unit) };
}

/** Probes from one new connection, then stops the timers from another. Returns the units cancelled. */
export async function runConfirm(
  host: HostEntry,
  opts: { address: Address; log: Logger },
): Promise<string[]> {
  const probe = await sshExec(host, CONFIRM_PROBE, { address: opts.address, timeoutMs: 30_000 });
  const plan = confirmPlan(parseConfirmProbe(expectSuccess(probe, "confirm probe").stdout));
  if ("refuse" in plan) throw new Error(`confirm refused: ${plan.refuse}`);
  const stop = await sshExec(host, `systemctl stop ${plan.cancel.join(" ")}`, {
    sudo: true,
    address: opts.address,
    timeoutMs: 30_000,
  });
  expectSuccess(stop, "stopping the revert timers");
  opts.log.info(`${host.name}: cancelled ${plan.cancel.join(", ")}`);
  return plan.cancel;
}

// ------------------------------------------------------ host.env and images

export function imageEnvKey(name: string): string {
  return `${name.toUpperCase().replaceAll("-", "_")}_IMAGE`;
}

export function imageIdFromLoadOutput(text: string): string | undefined {
  return /Loaded image ID: (sha256:[0-9a-f]{64})/.exec(text)?.[1];
}

/** The one image `docker load` reported (an id or a reference); refuses none or several. */
export function loadedImageReference(text: string): string {
  const loaded = [...text.matchAll(/^Loaded image(?: ID)?: (\S+)$/gm)].map((match) => match[1]);
  if (loaded.length === 0) throw new Error("docker load reported no image");
  if (loaded.length > 1) {
    throw new Error(
      `the archive holds ${loaded.length} images; save exactly one (docker save <name>:<tag>)`,
    );
  }
  return loaded[0] ?? "";
}

/** Sets KEY=value in /etc/mykey/host.env (non-secret settings only), replacing an old value. */
export function hostEnvSetCommand(key: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("host.env: invalid key");
  if (!/^[A-Za-z0-9._:/@-]*$/.test(value)) throw new Error(`host.env: invalid value for ${key}`);
  const file = REMOTE.hostEnv;
  return [
    `install -d -m 0755 ${dirname(file)}`,
    `touch ${file}`,
    `chmod 0644 ${file}`,
    `if grep -q '^${key}=' ${file}; then sed -i 's|^${key}=.*|${key}=${value}|' ${file}; else printf '%s\\n' '${key}=${value}' >> ${file}; fi`,
  ].join(" && ");
}

/** Writes KEY=value only when the key is absent, so a later choice is never reset. */
export function hostEnvDefaultCommand(key: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("host.env: invalid key");
  if (!/^[A-Za-z0-9._:/@-]*$/.test(value)) throw new Error(`host.env: invalid value for ${key}`);
  const file = REMOTE.hostEnv;
  return [
    `install -d -m 0755 ${dirname(file)}`,
    `touch ${file}`,
    `chmod 0644 ${file}`,
    `if ! grep -q '^${key}=' ${file}; then printf '%s\\n' '${key}=${value}' >> ${file}; fi`,
  ].join(" && ");
}

// ------------------------------------------------------------------- gate

/** The gate record on the host (P-43); its directory is mounted read-only into the API. */
export const GATE_DIRECTORY = "/etc/mykey/gate";
export const GATE_FILE = `${GATE_DIRECTORY}/gate.json`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The next gate record: version 1, the epoch one above the previous record's (or 1). */
export function gateRecordText(
  state: "open" | "closed",
  previous: string | null,
  hostInstanceId: string,
  writtenAt: string,
): string {
  if (!UUID.test(hostInstanceId)) throw new Error("gate: the host instance id is not a uuid");
  let epoch = 0;
  if (previous !== null) {
    try {
      const value = (JSON.parse(previous) as { gateEpoch?: unknown }).gateEpoch;
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) epoch = value;
    } catch {
      // An unreadable previous record: start above 0 again; the API reads it as closed anyway.
    }
  }
  return JSON.stringify({ version: 1, state, gateEpoch: epoch + 1, hostInstanceId, writtenAt });
}

/** Run 6.7 (P-123): the API's verification listener, inside the host (never published). */
export const REMOTE_API_VERIFY = { address: "10.78.2.3", port: 8444 } as const;

/** Run 6.7 (P-122): the running API's MYKEY_BUILD, and nothing else of its environment. */
export function apiBuildCommand(): string {
  return "docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' mykey-api-1 | sed -n 's/^MYKEY_BUILD=//p'";
}

/** The origin a close keeps: the previous v2 record's, else a fresh install of this host. */
export function gateOriginOf(
  previous: string | null,
  hostInstanceId: string,
): { kind: "fresh_install"; id: string } | { kind: "restore"; pairId: string } {
  const fresh = { kind: "fresh_install", id: hostInstanceId } as const;
  if (previous === null) return fresh;
  try {
    const record = JSON.parse(previous) as { version?: unknown; origin?: unknown };
    if (record.version !== 2) return fresh;
    const origin = record.origin as { kind?: unknown; id?: unknown; pairId?: unknown } | undefined;
    if (
      origin?.kind === "restore" &&
      typeof origin.pairId === "string" &&
      UUID.test(origin.pairId)
    ) {
      return { kind: "restore", pairId: origin.pairId };
    }
    if (origin?.kind === "fresh_install" && typeof origin.id === "string" && UUID.test(origin.id)) {
      return { kind: "fresh_install", id: origin.id };
    }
  } catch {
    // An unreadable record: the host's own fresh install.
  }
  return fresh;
}

/**
 * Run 6.7 (P-122): db-init's incarnation. New when neither the database nor
 * host.env holds one; copied to the side that lacks it; two different ones are
 * an unfinished restore, and db-init stops.
 */
export function planIncarnation(
  database: string | null,
  hostEnv: string | undefined,
  fresh: () => string,
): { incarnation: string; writeDatabase: boolean; writeHostEnv: boolean } {
  for (const value of [database, hostEnv]) {
    if (value !== null && value !== undefined && !UUID.test(value)) {
      throw new Error("db-init: the incarnation is not a uuid");
    }
  }
  if (database !== null && hostEnv !== undefined && database !== hostEnv) {
    throw new Error(
      "db-init: the database and host.env name different incarnations (an unfinished restore?)",
    );
  }
  const incarnation = database ?? hostEnv ?? fresh();
  return { incarnation, writeDatabase: database === null, writeHostEnv: hostEnv === undefined };
}

/**
 * Installs the record from stdin atomically: a temporary file beside it,
 * fsync, rename, fsync of the directory. Root-owned, readable by the API's uid.
 */
export function gateWriteCommand(): string {
  const tmp = `${GATE_FILE}.tmp`;
  return [
    `install -d -m 0755 -o root -g root ${GATE_DIRECTORY}`,
    `cat > ${tmp}`,
    `chown root:root ${tmp}`,
    `chmod 0644 ${tmp}`,
    `sync ${tmp}`,
    `mv -f ${tmp} ${GATE_FILE}`,
    `sync ${GATE_DIRECTORY}`,
  ].join(" && ");
}

// ---------------------------------------------------------- quiesce, resume

/**
 * Executor exclusion before a delete or undelete is reconciled (Run 4.5,
 * P-75, runbook reconciliation.md): with the gate closed no request starts;
 * with api and provisioner stopped no executor runs; restarting OpenBao ends
 * any request it still holds (D-20). Plain container commands: no firewall
 * change, no revert timer.
 */
export function quiesceCommands(): { stop: string; restartOpenBao: string } {
  return {
    stop: `${COMPOSE} stop api provisioner`,
    restartOpenBao: `${COMPOSE} restart openbao`,
  };
}

/** Starts both executors again; the gate is left as quiesce left it (closed). */
export function resumeCommand(): string {
  return `${COMPOSE} start api provisioner`;
}

/**
 * Switches the ACME directory. The edge and its certificate store go with it:
 * a certificate of the other directory must not be served or renewed. `up`
 * afterwards starts the edge, which asks the new directory once.
 */
/**
 * A KMS access certificate's key (Run 2.7): made on the host, kept in
 * /etc/mykey/secrets/kms, never replaced; only the CSR is put where it can be read.
 */
export interface OpenBaoConfigValues {
  host: string;
  /** The KMIP endpoint's host name, e.g. us-east-vin.okms.ovh.us. */
  kmsHost: string;
  sealKeyId: string;
  /** D-20, e.g. "15s". */
  maxRequestDuration: string;
}

/** infra/compose/host/openbao.hcl.tmpl with its placeholders filled; every value is checked first. */
export function renderOpenBaoConfig(values: OpenBaoConfigValues): string {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(values.host)) throw new Error("openbao.hcl: invalid host");
  if (!isHostname(values.kmsHost)) throw new Error("openbao.hcl: invalid KMS host name");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(values.sealKeyId))
    throw new Error("openbao.hcl: invalid key id");
  if (!/^\d{1,4}s$/.test(values.maxRequestDuration)) {
    throw new Error("openbao.hcl: invalid request duration");
  }
  const template = readFileSync(join(REPOSITORY, "infra/compose/host/openbao.hcl.tmpl"), "utf8");
  return template
    .replaceAll("{{host}}", values.host)
    .replaceAll("{{kms_host}}", values.kmsHost)
    .replaceAll("{{seal_key_id}}", values.sealKeyId)
    .replaceAll("{{max_request_duration}}", values.maxRequestDuration);
}

/** OpenBao's uid:gid in the pinned image; it reads the KMS directory through a bind mount. */
const OPENBAO_OWNER = "100:1000";
const KMS_DIR = `${REMOTE.secretsDir}/kms`;
const OKMS_BINARY = "/opt/mykey/bin/okms";

export function kmsCsrCommands(name: string): { create: string; read: string } {
  if (!CERT_NAME.test(name)) throw new Error("invalid certificate name");
  const key = `${KMS_DIR}/${name}.key`;
  const csr = `/etc/mykey/kms-csr/${name}.csr`;
  const [uid, gid] = OPENBAO_OWNER.split(":");
  return {
    create: [
      `install -d -m 0700 -o ${uid} -g ${gid} ${KMS_DIR}`,
      "install -d -m 0755 -o root -g root /etc/mykey/kms-csr",
      `test ! -e ${key}`,
      `(umask 077 && openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ${key} -out ${csr} -subj /CN=${name} 2>/dev/null)`,
      `chown ${OPENBAO_OWNER} ${key}`,
      `chmod 0400 ${key}`,
      `chmod 0644 ${csr}`,
    ].join(" && "),
    read: `cat ${csr}`,
  };
}

/** Unpacks okms from the uploaded release archive, only when it has the pinned checksum. */
export function okmsInstallCommand(archive: string): string {
  if (!/^\/var\/tmp\/mykey-okms\.[0-9a-f]{8}\.tar\.gz$/.test(archive)) {
    throw new Error("kms-install: unexpected archive path");
  }
  const lock = JSON.parse(
    readFileSync(join(REPOSITORY, "infra/dependencies.lock.json"), "utf8"),
  ) as { binaries?: { "okms-cli"?: { sha256: string } } };
  const sha256 = lock.binaries?.["okms-cli"]?.sha256;
  if (sha256 === undefined || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("dependencies.lock.json has no binaries.okms-cli.sha256");
  }
  const work = archive.replace(/\.tar\.gz$/, "");
  return [
    `echo '${sha256}  ${archive}' | sha256sum -c --quiet`,
    `install -d -m 0700 ${work}`,
    `tar -xzf ${archive} -C ${work} okms`,
    "install -d -m 0755 -o root -g root /opt/mykey/bin",
    `install -m 0755 -o root -g root ${work}/okms ${OKMS_BINARY}`,
  ].join(" && ");
}

/** Installs <name>.crt (from stdin) next to its key, only when the two belong together. */
export function kmsCertCommand(name: string): string {
  if (!CERT_NAME.test(name)) throw new Error("invalid certificate name");
  const [uid, gid] = OPENBAO_OWNER.split(":");
  const key = `${KMS_DIR}/${name}.key`;
  const crt = `${KMS_DIR}/${name}.crt`;
  return [
    `test -e ${key}`,
    `install -d -m 0700 -o ${uid} -g ${gid} ${KMS_DIR}`,
    `install -m 0444 -o ${uid} -g ${gid} /dev/stdin ${crt}.new`,
    `{ [ "$(openssl x509 -in ${crt}.new -noout -pubkey | sha256sum)" = "$(openssl pkey -in ${key} -pubout | sha256sum)" ] || { rm -f ${crt}.new; echo 'certificate does not match the key' >&2; exit 1; }; }`,
    `mv ${crt}.new ${crt}`,
    `chown ${OPENBAO_OWNER} ${key}`,
    `chmod 0400 ${key}`,
  ].join(" && ");
}

/** A key made on the workstation (the losstest certificates), for the test only; never replaces one. */
export function kmsImportKeyCommand(name: string): string {
  if (!CERT_NAME.test(name) || name === "seal") throw new Error("invalid certificate name");
  const [uid, gid] = OPENBAO_OWNER.split(":");
  const key = `${KMS_DIR}/${name}.key`;
  return [
    `install -d -m 0700 -o ${uid} -g ${gid} ${KMS_DIR}`,
    `test ! -e ${key}`,
    `install -m 0400 -o ${uid} -g ${gid} /dev/stdin ${key}`,
  ].join(" && ");
}

/** Removes a certificate and its key, unless the seal links point at them. */
export function kmsRemoveCommand(name: string): string {
  if (!CERT_NAME.test(name) || name === "seal") throw new Error("invalid certificate name");
  return [
    `[ "$(readlink ${KMS_DIR}/seal.key)" != ${name}.key ]`,
    `shred -u ${KMS_DIR}/${name}.key`,
    `rm -f ${KMS_DIR}/${name}.crt`,
  ].join(" && ");
}

/** seal.crt / seal.key, which OpenBao's configuration names, point at one certificate. */
export function kmsUseCommand(name: string): string {
  if (!CERT_NAME.test(name)) throw new Error("invalid certificate name");
  return [
    `test -e ${KMS_DIR}/${name}.crt`,
    `test -e ${KMS_DIR}/${name}.key`,
    `ln -sfn ${name}.crt ${KMS_DIR}/seal.crt`,
    `ln -sfn ${name}.key ${KMS_DIR}/seal.key`,
  ].join(" && ");
}

const BAO_INIT_FILE = `${REMOTE.custodyDir}/openbao-init.json`;

/**
 * P-35: `sys/init` on the host with one recovery share. The answer (root token
 * and recovery key) goes straight into root's custody file; the command prints
 * only the number of recovery keys. Refuses to run twice.
 */
export function baoInitCommand(): string {
  const { address, port } = REMOTE.openbao;
  const tls = `--cacert ${REMOTE.caCert} --resolve openbao:${port}:${address}`;
  return [
    `install -d -m 0700 -o root -g root ${REMOTE.custodyDir}`,
    `test ! -e ${BAO_INIT_FILE}`,
    // A first attempt whose outcome is unknown may have left the only copy here.
    `test ! -e ${BAO_INIT_FILE}.new`,
    // Never PUT sys/init to an OpenBao that already is initialised.
    `curl --fail --silent --show-error --max-time 30 ${tls} https://openbao:${port}/v1/sys/init | jq -e '.initialized == false' >/dev/null`,
    `(umask 077 && curl --fail --silent --show-error --max-time 60 --cacert ${REMOTE.caCert} --resolve openbao:${port}:${address} -X PUT --data '{"recovery_shares":1,"recovery_threshold":1}' https://openbao:${port}/v1/sys/init > ${BAO_INIT_FILE}.new)`,
    `mv ${BAO_INIT_FILE}.new ${BAO_INIT_FILE}`,
    `chmod 0400 ${BAO_INIT_FILE}`,
    `jq -er '.recovery_keys_base64 | length' ${BAO_INIT_FILE}`,
  ].join(" && ");
}

/** The workstation's copy of a host's init answer (P-35). */
export function custodyCopyPath(host: HostName, home: string = homedir()): string {
  return join(home, ".mykey", "custody", host, "openbao-init.json");
}

/** okms with one certificate, through infra/hosts/kms/okms.sh (prints identifiers, not secrets). */
export function okmsCommand(name: string, argv: string[]): string {
  if (!CERT_NAME.test(name)) throw new Error("invalid certificate name");
  for (const arg of argv) {
    if (!/^[A-Za-z0-9_.,:=@/-]+$/.test(arg)) throw new Error(`kms: unexpected argument ${arg}`);
  }
  return [`${REMOTE.hostsDir}/kms/okms.sh`, name, ...argv].join(" ");
}

/** Run 6.6 (P-121): a KMS key's attributes, as JSON (no key material). */
export function kmsKeyStateCommand(cert: string, keyId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(keyId)) {
    throw new Error("kms: not a key id");
  }
  return okmsCommand(cert, ["kmip", "attributes", "get", keyId, "--output", "json"]);
}

/**
 * The State attribute (Active, Deactivated, Destroyed, …) in okms's answer,
 * which may follow a line of its own; null when the answer holds none.
 */
export function kmsKeyState(output: string): string | null {
  const start = output.search(/[[{]/);
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start));
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { Attribute?: unknown } | null)?.Attribute ?? []);
  if (!Array.isArray(list)) return null;
  for (const entry of list as { AttributeName?: unknown; AttributeValue?: unknown }[]) {
    if (entry.AttributeName === "State" && typeof entry.AttributeValue === "string") {
      return entry.AttributeValue;
    }
  }
  return null;
}

export function acmeCommands(directory: AcmeDirectory): string[] {
  return [
    hostEnvSetCommand("MYKEY_ACME_DIRECTORY", ACME_DIRECTORIES[directory]),
    "docker rm --force mykey-edge-1 mykey-pki-init-1",
    "docker volume rm --force mykey_acme",
  ];
}

// ------------------------------------------------------------------- secrets

/** The secrets a service on the host reads, each in a directory only that service's user can open. */
export const HOST_SECRETS = {
  postgresSuperuser: { path: REMOTE.pgSuperuserPassword, owner: "999:999" },
  apiRuntime: { path: `${REMOTE.secretsDir}/api/db-password`, owner: "1000:1000" },
  // Run 3.8: the provisioner container logs in as provisioner_runtime.
  provisionerRuntime: { path: `${REMOTE.secretsDir}/provisioner/db-password`, owner: "1000:1000" },
} as const;

/** The host secret that holds the password of a role kept on the host. */
const ROLE_HOST_SECRET: Partial<Record<RoleName, { path: string; owner: string }>> = {
  api_runtime: HOST_SECRETS.apiRuntime,
  provisioner_runtime: HOST_SECRETS.provisionerRuntime,
};

/**
 * Where the password of each database role is kept. Only a role that a
 * service on the host logs in with is on the host; the others stay on the
 * operator's workstation under ~/.mykey/secrets/hosts/<host>/.
 */
export const ROLE_PASSWORD_PLACE: Record<RoleName, "host" | "workstation"> = {
  migration_owner: "workstation",
  api_runtime: "host",
  provisioner_runtime: "host",
  backup_reader: "workstation",
  maintenance: "workstation",
};

// ------------------------------------------------------- provisioned credentials

type AppRoleName = "runtime" | "issuer" | "provisioner";

/**
 * Where `ops provision-organization` installs each AppRole's credential on a
 * host (Run 3.8): runtime and issuer for the API, the provisioner's for its
 * container, each beside the id of the organization the host serves.
 */
export function credentialFiles(name: AppRoleName): {
  organizationId: string;
  roleId: string;
  secretId: string;
} {
  const directory = `${REMOTE.secretsDir}/${name === "provisioner" ? "provisioner" : "api"}`;
  return {
    organizationId: `${directory}/organization-id`,
    roleId: `${directory}/${name}-role-id`,
    secretId: `${directory}/${name}-secret-id`,
  };
}

/** The bao-bridge addresses each AppRole is bound to on a host (P-56; compose fixes them). */
export const HOST_BOUND_CIDRS: Readonly<Record<AppRoleName, readonly string[]>> = {
  runtime: ["10.78.3.3/32"],
  issuer: ["10.78.3.3/32"],
  provisioner: ["10.78.3.4/32"],
};

/** Where the API's auth key files live on a host (mounted read-only at /run/mykey/keys). */
export const API_KEYS_DIRECTORY = `${REMOTE.secretsDir}/api-keys`;
const KEY_FILE_NAME = new RegExp(`^(${KEY_RINGS.join("|")})[.]k[1-9][0-9]{0,8}[.]key$`);

/** Installs one key file from stdin, unless the host already has it (Run 3.2, P-45). */
export function keyInstallCommand(name: string): string {
  if (!KEY_FILE_NAME.test(name)) throw new Error(`not a key file name: ${name.slice(0, 60)}`);
  const path = `${API_KEYS_DIRECTORY}/${name}`;
  return [
    `install -d -m 0755 -o root -g root ${REMOTE.secretsDir}`,
    `install -d -m 0700 -o 1000 -g 1000 ${API_KEYS_DIRECTORY}`,
    `{ test -e ${path} || install -m 0600 -o 1000 -g 1000 /dev/stdin ${path}; }`,
  ].join(" && ");
}

/** The workstation's custody copy of a host's auth keys. */
export function workstationKeysDirectory(host: HostName, home: string = homedir()): string {
  return join(home, ".mykey", "secrets", "hosts", host, "auth-keys");
}

/** Installs stdin as a secret file under /etc/mykey/secrets/<service>/, owned by the service's user. */
export function secretInstallCommand(path: string, owner: string): string {
  const match = /^\/etc\/mykey\/secrets\/([a-z0-9-]+)\/[a-z0-9_-]+$/.exec(path);
  if (match === null || !path.startsWith(`${REMOTE.secretsDir}/`)) {
    throw new Error(`a host secret lives in ${REMOTE.secretsDir}/<service>/<name>`);
  }
  const ids = /^(\d+):(\d+)$/.exec(owner);
  if (ids === null) throw new Error("owner must be uid:gid");
  const own = `-o ${ids[1]} -g ${ids[2]}`;
  return [
    `install -d -m 0755 -o root -g root ${REMOTE.secretsDir}`,
    `install -d -m 0700 ${own} ${dirname(path)}`,
    `install -m 0400 ${own} /dev/stdin ${path}`,
  ].join(" && ");
}

const newSecret = (): string => {
  const fresh = randomBytes(24).toString("base64url");
  registerSecret(fresh);
  return fresh;
};

/** A secret kept on the workstation: created once (0600), the same value afterwards. */
export function localSecret(file: string): string {
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing !== "") {
      registerSecret(existing);
      return existing;
    }
  }
  const fresh = newSecret();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, fresh, { mode: 0o600 });
  chmodSync(file, 0o600);
  return fresh;
}

export function workstationRoleSecretFile(
  host: HostName,
  role: RoleName,
  home: string = homedir(),
): string {
  return join(home, ".mykey", "secrets", "hosts", host, role);
}

/** Reads a host secret, creating it first when it is absent. The value travels on stdin only. */
async function hostSecret(
  host: HostEntry,
  secret: { path: string; owner: string },
  address: Address,
): Promise<string> {
  const remote = { sudo: true, address, secretOutput: true } as const;
  const read = await sshExec(
    host,
    `if test -s ${secret.path}; then cat ${secret.path}; fi`,
    remote,
  );
  const existing = expectSuccess(read, `reading ${secret.path}`).stdout.trim();
  if (existing !== "") return existing;
  const fresh = newSecret();
  expectSuccess(
    await sshExec(host, secretInstallCommand(secret.path, secret.owner), {
      ...remote,
      stdin: fresh,
    }),
    `storing ${secret.path}`,
  );
  return fresh;
}

/** `docker compose … up -d`; with OpenBao, under its profile (production has none in Session 2). */
export function composeUpCommand(withOpenBao: boolean): string {
  if (withOpenBao) return `${COMPOSE} --profile openbao up -d`;
  // Compose interpolates every service, also those of an inactive profile: the
  // provisioner's required variables get placeholders where it never starts.
  return `PROVISIONER_IMAGE=unused-without-openbao MYKEY_BAO_URL=https://unused.invalid ${COMPOSE} up -d`;
}

/** D-20: the request-duration cap of OpenBao on a host. */
const OPENBAO_MAX_REQUEST_DURATION = "15s";

/** OpenBao's configuration values from host.env, or null where it does not run. */
export function openBaoValuesFrom(
  host: string,
  env: Record<string, string>,
): OpenBaoConfigValues | null {
  if (env.MYKEY_OPENBAO !== "1") return null;
  const kmsHost = env.MYKEY_KMS_HOST;
  const sealKeyId = env.MYKEY_KMS_SEAL_KEY_ID;
  if (kmsHost === undefined || kmsHost === "")
    throw new Error("host.env: MYKEY_KMS_HOST is not set");
  if (sealKeyId === undefined || sealKeyId === "") {
    throw new Error("host.env: MYKEY_KMS_SEAL_KEY_ID is not set");
  }
  return { host, kmsHost, sealKeyId, maxRequestDuration: OPENBAO_MAX_REQUEST_DURATION };
}

async function runUp(host: HostEntry, address: Address, log: Logger): Promise<void> {
  for (const secret of Object.values(HOST_SECRETS)) await hostSecret(host, secret, address);
  // Run 3.1: the API's settings. The host instance id is generated once and kept;
  // the gate directory exists but no record is written: a deploy starts closed.
  for (const step of [
    hostEnvDefaultCommand("MYKEY_HOST_INSTANCE_ID", randomUUID()),
    hostEnvSetCommand("MYKEY_BASE_URL", `https://${host.hostname}`),
    // Run 3.8: the provisioner's drift sweep interval (staging sweeps every minute).
    hostEnvSetCommand("MYKEY_SWEEP_SECONDS", host.name === "staging" ? "60" : "300"),
    `install -d -m 0755 -o root -g root ${GATE_DIRECTORY}`,
  ]) {
    expectSuccess(await sshExec(host, step, { sudo: true, address }), "API settings");
  }
  const pki = dirname(REMOTE.caCert);
  expectSuccess(
    await sshExec(host, `install -d -m 0755 -o root -g root ${pki}`, { sudo: true, address }),
    `creating ${pki}`,
  );
  const env = parseHostEnv(
    expectSuccess(await sshExec(host, `cat ${REMOTE.hostEnv}`, { address }), "reading host.env")
      .stdout,
  );
  const openbao = openBaoValuesFrom(host.name, env);
  if (openbao !== null) {
    expectSuccess(
      await sshExec(
        host,
        "install -d -m 0755 -o root -g root /etc/mykey/openbao && install -m 0644 -o root -g root /dev/stdin /etc/mykey/openbao/openbao.hcl",
        { sudo: true, address, stdin: renderOpenBaoConfig(openbao) },
      ),
      "installing openbao.hcl",
    );
    log.info(`${host.name}: openbao.hcl rendered`);
  }
  const result = await sshExec(host, composeUpCommand(openbao !== null), {
    sudo: true,
    address,
    timeoutMs: 600_000,
  });
  expectSuccess(result, "docker compose up");
  log.info(`${host.name}: compose up done`);
}

// The route from the workstation to the hosts loses packets in the upload
// direction, which holds one TCP stream near 40 kB/s. Several streams add up,
// so an archive is sent as parts and put together on the host (run-2.5.md).
const IMAGE_UPLOAD_PREFIX = "/var/tmp/mykey-image.";
const IMAGE_PART_BYTES = 2 * 1024 * 1024;
const IMAGE_UPLOAD_STREAMS = 8; // below sshd's MaxStartups of 10

export interface ImagePart {
  name: string;
  start: number;
  end: number;
}

export function imageParts(size: number, partBytes: number): ImagePart[] {
  if (size <= 0) throw new Error("the image archive is empty");
  const count = Math.ceil(size / partBytes);
  if (count > 10_000) throw new Error("the image archive needs more than 10000 parts");
  return Array.from({ length: count }, (_, index) => ({
    name: `part-${String(index).padStart(4, "0")}`,
    start: index * partBytes,
    end: Math.min(size, (index + 1) * partBytes),
  }));
}

/** Loads the uploaded parts, but only when together they have the checksum of the archive. */
export function imageLoadCommand(directory: string, sha256: string): string {
  if (!/^\/var\/tmp\/mykey-image\.[0-9a-f]{8}$/.test(directory)) {
    throw new Error("image upload: unexpected directory");
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("image upload: sha256 expected");
  const parts = `cat ${directory}/part-*`;
  return `test "$(${parts} | sha256sum | cut -d ' ' -f 1)" = ${sha256} && ${parts} | docker load`;
}

/** Runs `work` for every item, at most `limit` at a time. After a failure nothing new starts. */
export async function inParallel<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  let failed = false;
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined && !failed; item = queue.shift()) {
      try {
        await work(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

async function runImage(
  host: HostEntry,
  name: string,
  tar: string,
  opts: { address: Address; log: Logger },
): Promise<void> {
  const archive = readFileSync(tar);
  const sha = createHash("sha256").update(archive).digest("hex");
  const directory = `${IMAGE_UPLOAD_PREFIX}${randomBytes(4).toString("hex")}`;
  const remote = { sudo: true, address: opts.address } as const;
  const parts = imageParts(archive.length, IMAGE_PART_BYTES);
  expectSuccess(
    await sshExec(host, `install -d -m 0700 -o root -g root ${directory}`, remote),
    "creating the upload directory",
  );
  let output: string;
  try {
    let sent = 0;
    await inParallel(parts, IMAGE_UPLOAD_STREAMS, async (part) => {
      const upload = await sshExec(host, `cat > ${directory}/${part.name}`, {
        ...remote,
        stdin: archive.subarray(part.start, part.end),
        timeoutMs: 900_000,
      });
      expectSuccess(upload, `uploading ${part.name}`);
      sent += 1;
      opts.log.info(`${host.name}: ${part.name} sent (${sent}/${parts.length})`);
    });
    const loaded = await sshExec(host, imageLoadCommand(directory, sha), {
      ...remote,
      timeoutMs: 900_000,
    });
    output = expectSuccess(loaded, "checksum and docker load").stdout;
  } finally {
    expectSuccess(
      await sshExec(host, `rm -rf ${directory}`, remote),
      "removing the upload directory",
    );
  }
  const loaded = loadedImageReference(output);
  let id = /^sha256:[0-9a-f]{64}$/.test(loaded) ? loaded : undefined;
  if (id === undefined) {
    const ref = loaded;
    if (!/^[a-z0-9][a-z0-9._/:@-]*$/.test(ref)) throw new Error("docker load: unusable image name");
    const inspect = await sshExec(host, `docker image inspect --format '{{.Id}}' ${shQuote(ref)}`, {
      sudo: true,
      address: opts.address,
    });
    id = expectSuccess(inspect, "docker image inspect").stdout.trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error("docker image inspect: no image id");
  }
  const key = imageEnvKey(name);
  const set = await sshExec(host, hostEnvSetCommand(key, id), {
    sudo: true,
    address: opts.address,
  });
  expectSuccess(set, `writing ${key}`);
  opts.log.info(`${host.name}: ${key}=${id}`);
}

// --------------------------------------------------------------- maintenance

export function maintCommands(
  minutes: number,
  argv: string[],
): { open: string; run: string; close: string } {
  return {
    open: `${FIREWALL}/mykey-egress.sh maint ${minutes}`,
    run: argv.map(shQuote).join(" "),
    close: `${FIREWALL}/mykey-egress.sh maint-end`,
  };
}

/** Opens registry egress, runs the command, always closes the window. Returns the command's exit code. */
export async function runMaint(
  host: HostEntry,
  minutes: number,
  argv: string[],
  opts: { address: Address; log: Logger },
): Promise<number> {
  const commands = maintCommands(minutes, argv);
  if (mentionsSecretPath(commands.run)) throw new Error("maint: the command names a secret path");
  const remote = { sudo: true, address: opts.address } as const;
  expectSuccess(await sshExec(host, commands.open, remote), "opening the maintenance window");
  try {
    const result = await sshExec(host, commands.run, { ...remote, timeoutMs: minutes * 60_000 });
    if (result.stdout.trim() !== "") opts.log.info(result.stdout.trimEnd());
    if (result.stderr.trim() !== "") opts.log.error(result.stderr.trimEnd());
    return result.code;
  } finally {
    expectSuccess(await sshExec(host, commands.close, remote), "closing the maintenance window");
  }
}

// ----------------------------------------------------------------- WireGuard

// DER prefix of a PKCS#8 X25519 private key; the raw 32 bytes follow.
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");

const toBase64 = (base64url: string | undefined): string => {
  if (base64url === undefined) throw new Error("WireGuard: key export failed");
  return Buffer.from(base64url, "base64url").toString("base64");
};

/** A WireGuard key pair: raw 32-byte X25519 keys in standard base64. */
export function wireguardKeyPair(): { privateKey: string; publicKey: string } {
  const jwk = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
  return { privateKey: toBase64(jwk.d), publicKey: toBase64(jwk.x) };
}

export function wireguardPublicKey(privateKey: string): string {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, Buffer.from(privateKey, "base64")]),
    format: "der",
    type: "pkcs8",
  });
  return toBase64(createPublicKey(key).export({ format: "jwk" }).x);
}

type PeerKeys = Partial<Record<HostName, string>>;

const operatorAddress = (vpnIp: string): string => vpnIp.replace(/\.\d+$/, ".10");

export function renderWireguardConfig(config: {
  privateKey: string;
  hosts: { prod: HostEntry; staging: HostEntry };
  peerKeys: PeerKeys;
}): string {
  const order = [config.hosts.prod, config.hosts.staging];
  const lines = [
    "# MyKey operator tunnel, written by scripts/host.ts. Holds a private key: keep it 0600.",
    "[Interface]",
    `PrivateKey = ${config.privateKey}`,
    `Address = ${order.map((host) => `${operatorAddress(host.vpnIp)}/32`).join(", ")}`,
  ];
  for (const host of order) {
    const publicKey = config.peerKeys[host.name];
    if (publicKey === undefined) continue;
    lines.push(
      "",
      "[Peer]",
      `# ${host.name} ${host.hostname}`,
      `PublicKey = ${publicKey}`,
      `AllowedIPs = ${host.vpnIp}/32`,
      `Endpoint = ${host.publicIp}:${WG_PORT}`,
      "PersistentKeepalive = 25",
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseWireguardConfig(
  text: string,
  hosts: { prod: HostEntry; staging: HostEntry },
): { privateKey: string | undefined; peerKeys: PeerKeys } {
  const peerKeys: PeerKeys = {};
  let privateKey: string | undefined;
  for (const block of text.split(/^(?=\[)/m)) {
    const value = (key: string) => new RegExp(`^${key} = (\\S+)$`, "m").exec(block)?.[1];
    if (block.startsWith("[Interface]")) privateKey = value("PrivateKey");
    if (!block.startsWith("[Peer]")) continue;
    const allowed = value("AllowedIPs");
    const publicKey = value("PublicKey");
    for (const host of [hosts.prod, hosts.staging]) {
      if (allowed === `${host.vpnIp}/32` && publicKey !== undefined)
        peerKeys[host.name] = publicKey;
    }
  }
  return { privateKey, peerKeys };
}

export function defaultWireguardFile(home: string = homedir()): string {
  return join(home, ".mykey", "wireguard", "mykey-ops.conf");
}

/**
 * Writes the operator configuration with mode 0600, keeping the private key
 * and the peers already in the file and adding `peerKeys`. Returns the
 * operator's public key only; the private key never leaves this function.
 */
export function writeWireguardConfig(
  file: string,
  hosts: { prod: HostEntry; staging: HostEntry },
  peerKeys: PeerKeys,
): { file: string; publicKey: string } {
  for (const key of Object.values(peerKeys)) {
    if (!BASE64_KEY.test(key)) throw new Error("WireGuard: a host public key is malformed");
  }
  const existing = existsSync(file)
    ? parseWireguardConfig(readFileSync(file, "utf8"), hosts)
    : { privateKey: undefined, peerKeys: {} };
  const privateKey = existing.privateKey ?? wireguardKeyPair().privateKey;
  if (!BASE64_KEY.test(privateKey)) throw new Error(`WireGuard: ${file} holds a malformed key`);
  registerSecret(privateKey);
  const text = renderWireguardConfig({
    privateKey,
    hosts,
    peerKeys: { ...existing.peerKeys, ...peerKeys },
  });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Windows ignores POSIX modes; there the file is protected by the ACL of the
  // user profile it lives in. On Linux the mode is what protects it.
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, publicKey: wireguardPublicKey(privateKey) };
}

// ----------------------------------------------------------------- bootstrap

/** The remote steps of `bootstrap` after the push, each run with sudo. sshd is changed by `apply ssh`. */
export function bootstrapCommands(
  name: HostName,
  hosts: Hosts,
  operatorPublicKey: string,
): string[] {
  const host = hosts[name];
  const wireguardEnv = [
    `WG_ADDRESS=${host.vpnIp}/24`,
    `WG_PEER_ADDRESS=${operatorAddress(host.vpnIp)}/32`,
    `WG_PEER_PUBLIC_KEY=${shQuote(operatorPublicKey)}`,
    `WG_LISTEN_PORT=${WG_PORT}`,
  ].join(" ");
  return [
    hostEnvSetCommand("MYKEY_HOST", name),
    hostEnvSetCommand("MYKEY_HOSTNAME", host.hostname),
    hostEnvSetCommand("MYKEY_REGION", hosts.region),
    hostEnvDefaultCommand("MYKEY_ACME_DIRECTORY", ACME_DIRECTORIES.staging),
    `${BOOTSTRAP}/10-packages.sh`,
    `env ${wireguardEnv} ${BOOTSTRAP}/20-wireguard.sh`,
    `${BOOTSTRAP}/40-sysctl.sh`,
    `${BOOTSTRAP}/50-docker.sh`,
  ];
}

async function runBootstrap(name: HostName, hosts: Hosts, log: Logger): Promise<void> {
  const host = hosts[name];
  const wireguardFile = defaultWireguardFile();
  const { publicKey } = writeWireguardConfig(wireguardFile, hosts, {});
  await pushFiles(host, collectPushFiles(), { address: "public" });
  log.info(`${name}: pushed`);
  for (const command of bootstrapCommands(name, hosts, publicKey)) {
    const step = command.split(" ").find((word) => word.startsWith(BOOTSTRAP)) ?? "host.env";
    const result = await sshExec(host, command, {
      sudo: true,
      address: "public",
      timeoutMs: 1_200_000,
    });
    expectSuccess(result, `${name}: ${step}`);
    log.info(`${name}: ${step} done`);
  }
  const key = await sshExec(host, "wg show wg0 public-key", { sudo: true, address: "public" });
  const hostKey = expectSuccess(key, "reading the host WireGuard key").stdout.trim();
  writeWireguardConfig(wireguardFile, hosts, { [name]: hostKey });
  log.info(
    `${name}: WireGuard peer recorded in ${wireguardFile}; import or reload it in WireGuard`,
  );
  log.info(`next: node scripts/host.ts ${name} apply ssh, then confirm from a new connection`);
}

// ------------------------------------------------------------------- db-init

async function runDbInit(host: HostEntry, address: Address, log: Logger): Promise<void> {
  const { ROLE_NAMES, applyRoles, migrate } = await import("@mykey/db");
  const passwords = {} as Record<RoleName, string>;
  for (const role of ROLE_NAMES) {
    const onHost = ROLE_HOST_SECRET[role];
    passwords[role] =
      ROLE_PASSWORD_PLACE[role] === "host" && onHost !== undefined
        ? await hostSecret(host, onHost, address)
        : localSecret(workstationRoleSecretFile(host.name, role));
  }
  const superuserPassword = await hostSecret(host, HOST_SECRETS.postgresSuperuser, address);
  const dir = mkdtempSync(join(tmpdir(), "mykey-db-init-"));
  const tunnel = await openTunnel(host, REMOTE.postgres);
  try {
    const caCertPath = join(dir, "ca.crt");
    writeFileSync(
      caCertPath,
      expectSuccess(await sshExec(host, `cat ${REMOTE.caCert}`, { address }), "reading the host CA")
        .stdout,
    );
    const base = { host: "127.0.0.1", port: tunnel.localPort, database: "postgres", caCertPath };
    await applyRoles({ ...base, user: "postgres", password: superuserPassword }, passwords);
    const owner = { ...base, user: "migration_owner", password: passwords.migration_owner };
    const result = await migrate(owner);
    // Run 3.1: the job queues, created by the schema owner after the migrations.
    const { createPool } = await import("@mykey/db");
    const { ensureQueues } = await import("@mykey/operations");
    const ownerPool = createPool(owner, { max: 1 });
    try {
      await ensureQueues(ownerPool);
    } finally {
      await ownerPool.end();
    }
    // Run 6.7 (P-122): the incarnation in the database and in host.env.
    const { readIncarnation, writeIncarnation } = await import("@mykey/db");
    const superPool = createPool(
      { ...base, user: "postgres", password: superuserPassword },
      { max: 1 },
    );
    try {
      const hostEnv = parseHostEnv(
        expectSuccess(await sshExec(host, `cat ${REMOTE.hostEnv}`, { address }), "reading host.env")
          .stdout,
      );
      const plan = planIncarnation(
        await readIncarnation(superPool),
        hostEnv.MYKEY_BACKEND_INCARNATION,
        () => randomUUID(),
      );
      if (plan.writeDatabase) await writeIncarnation(superPool, plan.incarnation, null);
      if (plan.writeHostEnv) {
        expectSuccess(
          await sshExec(host, hostEnvSetCommand("MYKEY_BACKEND_INCARNATION", plan.incarnation), {
            sudo: true,
            address,
          }),
          "writing the incarnation into host.env",
        );
      }
      log.info(`${host.name}: incarnation ${plan.incarnation}`);
    } finally {
      await superPool.end();
    }
    log.info(`${host.name}: roles ${ROLE_NAMES.join(", ")}`);
    log.info(
      `${host.name}: applied ${result.applied.length === 0 ? "nothing" : result.applied.join(", ")}`,
    );
    log.info(`${host.name}: job queues present`);
  } finally {
    await tunnel.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Waits until OpenBao answers sys/health with 200 (initialised, unsealed, active). */
async function waitForOpenBao(host: HostEntry, address: Address, seconds: number): Promise<void> {
  const { address: ip, port } = REMOTE.openbao;
  const probe = `curl -s -o /dev/null -w '%{http_code}' --max-time 5 --cacert ${REMOTE.caCert} --resolve openbao:${port}:${ip} https://openbao:${port}/v1/sys/health`;
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const result = await sshExec(host, probe, { sudo: true, address });
    if (result.stdout.trim() === "200") return;
    if (Date.now() > deadline) {
      throw new Error(`OpenBao sys/health: ${result.stdout.trim()} after ${seconds} s`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
}

/**
 * P-35: init once on the host, copy the answer unseen to the workstation's
 * custody directory, then the root-namespace setup (audit headers, the backup
 * policy) with the root token through a tunnel. Safe to run again.
 */
async function runBaoInit(host: HostEntry, address: Address, log: Logger): Promise<void> {
  const remote = { sudo: true, address, secretOutput: true } as const;
  if ((await sshExec(host, `test -e ${BAO_INIT_FILE}`, remote)).code === 0) {
    log.info(`${host.name}: already initialised; checking custody and the root-namespace setup`);
  } else {
    const count = expectSuccess(
      await sshExec(host, baoInitCommand(), { ...remote, timeoutMs: 120_000 }),
      "bao-init (refused when OpenBao is already initialised or a first attempt left openbao-init.json.new in the custody directory: recover that file by hand)",
    ).stdout.trim();
    log.info(`${host.name}: initialized: true, recovery keys: ${count}`);
  }
  const answer = expectSuccess(
    await sshExec(host, `cat ${BAO_INIT_FILE}`, remote),
    "reading the init answer",
  ).stdout;
  const rootToken = (JSON.parse(answer) as { root_token?: unknown }).root_token;
  if (typeof rootToken !== "string" || rootToken === "") {
    throw new Error("the init answer has no root token");
  }
  const copy = custodyCopyPath(host.name);
  mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
  if (!existsSync(copy)) writeFileSync(copy, answer, { mode: 0o600, flag: "wx" });
  else if (readFileSync(copy, "utf8") !== answer) {
    throw new Error(`${copy} differs from the host's init answer; it is never overwritten`);
  }
  log.info(`${host.name}: custody copy at ${copy}`);

  await waitForOpenBao(host, address, 120);
  const { OpenBaoAdmin } = await import("@mykey/openbao/admin");
  const { renderPolicy } = await import("@mykey/openbao");
  const dir = mkdtempSync(join(tmpdir(), "mykey-bao-init-"));
  const tunnel = await openTunnel(host, REMOTE.openbao);
  try {
    const caCertPath = join(dir, "ca.crt");
    writeFileSync(
      caCertPath,
      expectSuccess(await sshExec(host, `cat ${REMOTE.caCert}`, { address }), "reading the host CA")
        .stdout,
    );
    const admin = new OpenBaoAdmin(
      { url: `https://127.0.0.1:${tunnel.localPort}`, caCertPath },
      rootToken,
    );
    await admin.registerAuditHeaders();
    await admin.putPolicy("", "backup", renderPolicy("backup"));
    log.info(`${host.name}: audit headers registered; root-namespace policy backup written`);
  } finally {
    await tunnel.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------- main

async function main(argv: string[], log: Logger): Promise<number> {
  let command: HostCommand;
  try {
    command = parseHostArgs(argv);
  } catch (error) {
    log.error((error as Error).message);
    return 2;
  }
  const hosts = loadHosts();
  const host = hosts[command.host];
  const address = command.via;
  switch (command.command) {
    case "bootstrap":
      await runBootstrap(command.host, hosts, log);
      return 0;
    case "push":
      await pushFiles(host, collectPushFiles(), { address });
      log.info(`${host.name}: pushed and read back`);
      return 0;
    case "apply": {
      const result = await sshExec(host, applyCommand(command.target), {
        sudo: true,
        address,
        timeoutMs: 120_000,
      });
      expectSuccess(result, `apply ${command.target}`);
      log.info(
        `${host.name}: ${command.target} applied; reverts in ${REVERT_SECONDS} s unless confirmed`,
      );
      log.info(`next, from a new connection: node scripts/host.ts ${host.name} confirm`);
      return 0;
    }
    case "confirm":
      await runConfirm(host, { address, log });
      return 0;
    case "image":
      await runImage(host, command.name, command.tar, { address, log });
      return 0;
    case "maint":
      return runMaint(host, command.minutes, command.argv, { address, log });
    case "acme": {
      for (const step of acmeCommands(command.directory)) {
        expectSuccess(await sshExec(host, step, { sudo: true, address }), "acme");
      }
      log.info(`${host.name}: ACME directory is ${ACME_DIRECTORIES[command.directory]}`);
      log.info(`next: node scripts/host.ts ${host.name} up`);
      return 0;
    }
    case "kms-csr": {
      const { create, read } = kmsCsrCommands(command.name);
      // The command names the secrets directory; it prints nothing.
      expectSuccess(
        await sshExec(host, create, { sudo: true, address, secretOutput: true }),
        `kms-csr ${command.name} (an existing key is never replaced)`,
      );
      log.info(
        expectSuccess(await sshExec(host, read, { address }), "reading the CSR").stdout.trimEnd(),
      );
      return 0;
    }
    case "kms-install": {
      const archive = `/var/tmp/mykey-okms.${randomBytes(4).toString("hex")}.tar.gz`;
      const remote = { sudo: true, address, timeoutMs: 300_000 } as const;
      try {
        expectSuccess(
          await sshExec(host, `(umask 077 && cat > ${archive})`, {
            ...remote,
            stdin: readFileSync(command.tar),
          }),
          "uploading the okms archive",
        );
        expectSuccess(
          await sshExec(host, okmsInstallCommand(archive), remote),
          "checksum and install",
        );
      } finally {
        await sshExec(host, `rm -rf ${archive} ${archive.replace(/\.tar\.gz$/, "")}`, remote);
      }
      log.info(`${host.name}: okms installed (checksum of the pinned release)`);
      return 0;
    }
    case "kms-cert":
      // Names the secrets directory; prints nothing. The certificate is public.
      expectSuccess(
        await sshExec(host, kmsCertCommand(command.name), {
          sudo: true,
          address,
          secretOutput: true,
          stdin: readFileSync(command.crt, "utf8"),
        }),
        `kms-cert ${command.name}`,
      );
      log.info(`${host.name}: certificate ${command.name} installed next to its key`);
      return 0;
    case "kms-import":
      // The key crosses only as stdin of a command that prints nothing.
      expectSuccess(
        await sshExec(host, kmsImportKeyCommand(command.name), {
          sudo: true,
          address,
          secretOutput: true,
          stdin: readFileSync(command.key, "utf8"),
        }),
        `kms-import ${command.name} (an existing key is never replaced)`,
      );
      expectSuccess(
        await sshExec(host, kmsCertCommand(command.name), {
          sudo: true,
          address,
          secretOutput: true,
          stdin: readFileSync(command.crt, "utf8"),
        }),
        `kms-import ${command.name}: certificate`,
      );
      log.info(`${host.name}: ${command.name} imported (key and matching certificate)`);
      return 0;
    case "kms-remove":
      expectSuccess(
        await sshExec(host, kmsRemoveCommand(command.name), {
          sudo: true,
          address,
          secretOutput: true,
        }),
        `kms-remove ${command.name} (refused while the seal uses it)`,
      );
      log.info(`${host.name}: ${command.name} removed`);
      return 0;
    case "kms-use":
      expectSuccess(
        await sshExec(host, kmsUseCommand(command.name), {
          sudo: true,
          address,
          secretOutput: true,
        }),
        `kms-use ${command.name}`,
      );
      log.info(`${host.name}: seal.crt and seal.key now point at ${command.name}`);
      return 0;
    case "kms": {
      const result = await sshExec(host, okmsCommand(command.name, command.argv), {
        sudo: true,
        address,
        timeoutMs: 120_000,
      });
      if (result.stdout !== "") log.info(redact(result.stdout).trimEnd());
      if (result.stderr !== "") log.error(redact(result.stderr).trimEnd());
      return result.code;
    }
    case "env":
      expectSuccess(
        await sshExec(host, hostEnvSetCommand(command.key, command.value), { sudo: true, address }),
        `env ${command.key}`,
      );
      log.info(`${host.name}: ${command.key}=${command.value}`);
      return 0;
    case "up":
      await runUp(host, address, log);
      return 0;
    case "db-init":
      await runDbInit(host, address, log);
      return 0;
    case "bao-init":
      await runBaoInit(host, address, log);
      return 0;
    case "status": {
      // P-117: the private status view — the host's report and the probe's state, each check with its time.
      const report = await hostStatus(host, address);
      const probe = await probeState(host.name);
      const lines = statusView(report, probe, Date.now());
      log.info(
        command.json
          ? JSON.stringify({ status: report, probe, lines }, null, 2)
          : formatStatusView(lines),
      );
      return 0;
    }
    case "gate":
      return runGate(host, command, address, log);
    case "tunnel":
      return runVerifyTunnel(host, log);
    case "restore":
      return runRestore(host, command, address, log);
    case "restore-verify":
      return runRestoreVerify(host, command, address, log);
    case "quiesce":
      return runQuiesce(host, address, log);
    case "resume":
      expectSuccess(await sshExec(host, resumeCommand(), { sudo: true, address }), "resume");
      log.info(`${host.name}: executors: started; the gate stays closed until gate open`);
      return 0;
    case "keys":
      await runKeysInit(host, address, log);
      return 0;
    case "ops":
      return runOpsOnHost(host, command.argv, address);
    case "ops-secrets":
      await runOpsSecrets(host, address, log);
      return 0;
    case "r2-install":
      await runR2Install(host, command.name, address, log);
      return 0;
    case "backup-init":
      await runBackupInit(host, address, log);
      return 0;
    case "backup-custody":
      await runBackupCustody(host, address, log);
      return 0;
    case "timers":
      await runTimers(host, address, log);
      return 0;
  }
}

/** Run 6.2 (P-112): which R2 token each host job uses, and where its three files go. */
export const R2_INSTALLS = {
  "audit-archive": {
    token: () => "mykey-audit-archive-upload",
    directory: "/etc/mykey/secrets/r2-audit-archive",
  },
  /** Run 6.5 (P-119): the pair job; the token reads back what it wrote (Item Write). */
  pairs: {
    token: (host: HostName) => `mykey-${host}-pairs-upload`,
    directory: "/etc/mykey/secrets/r2-pairs",
  },
  /** Run 6.6 (P-121): the retention job deletes through its own token. */
  "pairs-cleanup": {
    token: (host: HostName) => `mykey-${host}-pairs-cleanup`,
    directory: "/etc/mykey/secrets/r2-pairs-cleanup",
  },
} as const;
export type R2InstallName = keyof typeof R2_INSTALLS;

/** The three files of a job's R2 credentials, as ops-run.sh mounts them. */
export function r2InstallFiles(
  name: R2InstallName,
): Record<"accountId" | "accessKeyId" | "secretAccessKey", string> {
  const { directory } = R2_INSTALLS[name];
  return {
    accountId: `${directory}/account-id`,
    accessKeyId: `${directory}/access-key-id`,
    secretAccessKey: `${directory}/secret-access-key`,
  };
}

/** Installs a job's R2 credentials from workstation custody (owner 1000, mode 0400), on stdin. */
async function runR2Install(
  host: HostEntry,
  name: R2InstallName,
  address: Address,
  log: Logger,
): Promise<void> {
  const credentials = loadR2Credentials(R2_INSTALLS[name].token(host.name));
  registerSecret(credentials.secretAccessKey);
  const files = r2InstallFiles(name);
  for (const field of ["accountId", "accessKeyId", "secretAccessKey"] as const) {
    expectSuccess(
      await sshExec(host, secretInstallCommand(files[field], "1000:1000"), {
        sudo: true,
        address,
        secretOutput: true,
        stdin: credentials[field],
      }),
      `installing ${files[field]}`,
    );
    log.info(`${host.name}: ${files[field]} installed`);
  }
}

/** Run 6.5 (P-119): the backup secrets of a host, as files on it. */
export const BACKUP_FILES = {
  /** Restic's password; owner 1000 (the ops user), mode 0400. */
  password: "/etc/mykey/secrets/backup/password",
  /** The Ed25519 key that signs eligible.json; owner 1000, mode 0400. */
  signingKey: "/etc/mykey/secrets/backup/signing-key",
  /** The root AppRole backup, read by backup.sh as root. */
  roleId: "/etc/mykey/secrets/backup-approle/role-id",
  secretId: "/etc/mykey/secrets/backup-approle/secret-id",
} as const;
/** The signing key's id (ops-jobs.json: MYKEY_PAIR_SIGNER). */
export const BACKUP_KEY_ID = "k1";
/** The token of the AppRole backup lives 600 s (P-119). */
const BACKUP_TOKEN_SECONDS = 600;

/** Makes the backup password and the signing key on the host, once; never prints them. */
export function backupKeysCommand(): string {
  const make = (path: string, generate: string): string =>
    `( test -s ${path} || ( ${generate} > ${path}.new && chown 1000:1000 ${path}.new && chmod 0400 ${path}.new && mv ${path}.new ${path} ) )`;
  return [
    "umask 077",
    "install -d -m 0700 -o 1000 -g 1000 /etc/mykey/secrets/backup",
    make(BACKUP_FILES.password, "openssl rand -hex 32"),
    make(BACKUP_FILES.signingKey, "openssl genpkey -algorithm ed25519"),
  ].join(" && ");
}

/** The committed public key of a host (the trust anchor a restore checks against). */
export function trustFile(host: HostName): string {
  return resolve(
    import.meta.dirname,
    "..",
    "infra/hosts/backup/trust",
    `${host}-${BACKUP_KEY_ID}.pub`,
  );
}

/**
 * P-119: the backup password and the signing key are made on the host; the
 * public key is written to infra/hosts/backup/trust/ (commit it); the root
 * AppRole backup (policy backup, 600 s tokens) gets a new secret id, installed
 * for backup.sh. Safe to run again: the keys are never replaced.
 */
async function runBackupInit(host: HostEntry, address: Address, log: Logger): Promise<void> {
  const remote = { sudo: true, address, secretOutput: true } as const;
  expectSuccess(await sshExec(host, backupKeysCommand(), remote), "the backup password and key");
  const answer = expectSuccess(
    await sshExec(host, `openssl pkey -in ${BACKUP_FILES.signingKey} -pubout`, remote),
    "the public signing key",
  ).stdout;
  const key = createPublicKey(answer);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("the signing key is not Ed25519");
  const pem = key.export({ format: "pem", type: "spki" }).toString();
  const file = trustFile(host.name);
  if (existsSync(file) && readFileSync(file, "utf8") !== pem) {
    throw new Error(`${file} differs from the host's key: a new key needs a new key id`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, pem);
  log.info(`${host.name}: trust anchor ${file} (commit it)`);

  const custody = custodyCopyPath(host.name);
  const rootToken = (JSON.parse(readFileSync(custody, "utf8")) as { root_token?: unknown })
    .root_token;
  if (typeof rootToken !== "string" || rootToken === "") {
    throw new Error(`${custody} holds no root token`);
  }
  registerSecret(rootToken);
  const { OpenBaoAdmin } = await import("@mykey/openbao/admin");
  const dir = mkdtempSync(join(tmpdir(), "mykey-backup-init-"));
  const tunnel = await openTunnel(host, REMOTE.openbao);
  try {
    const caCertPath = join(dir, "ca.crt");
    writeFileSync(
      caCertPath,
      expectSuccess(await sshExec(host, `cat ${REMOTE.caCert}`, { address }), "reading the host CA")
        .stdout,
    );
    const admin = new OpenBaoAdmin(
      { url: `https://127.0.0.1:${tunnel.localPort}`, caCertPath },
      rootToken,
    );
    if ((await admin.readAuthMount("", "approle")) === null) await admin.enableAppRole("");
    // The role of the Run 2.9 spike gave secret ids 60 s; this one lives until
    // backup-init replaces it (it is installed on the host, never on a workstation).
    const { roleId } = await admin.putAppRole("", "backup", BACKUP_TOKEN_SECONDS, [], 0);
    const { secretId } = await admin.newSecretId("", "backup");
    registerSecret(secretId);
    for (const [path, value] of [
      [BACKUP_FILES.roleId, roleId],
      [BACKUP_FILES.secretId, secretId],
    ] as const) {
      expectSuccess(
        await sshExec(host, secretInstallCommand(path, "0:0"), { ...remote, stdin: value }),
        `installing ${path}`,
      );
      log.info(`${host.name}: ${path} installed`);
    }
  } finally {
    await tunnel.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** OWN-4: the backup password and signing key, copied unseen to workstation custody. */
async function runBackupCustody(host: HostEntry, address: Address, log: Logger): Promise<void> {
  const dir = join(homedir(), ".mykey", "custody", host.name, "backup");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, path] of [
    ["password", BACKUP_FILES.password],
    ["signing-key", BACKUP_FILES.signingKey],
  ] as const) {
    const value = expectSuccess(
      await sshExec(host, `cat ${path}`, { sudo: true, address, secretOutput: true }),
      `reading ${name}`,
    ).stdout;
    if (value.trim() === "") throw new Error(`${path} is empty: run backup-init first`);
    registerSecret(value.trim());
    const target = join(dir, name);
    if (existsSync(target)) {
      if (readFileSync(target, "utf8") !== value) {
        throw new Error(`${target} differs from the host's ${name}; it is never overwritten`);
      }
      log.info(`${host.name}: ${target} already holds the host's ${name}`);
    } else {
      writeFileSync(target, value, { mode: 0o600, flag: "wx" });
      log.info(`${host.name}: ${target} written`);
    }
  }
}

/** The timers of host jobs: every unit of ops-jobs.json, and the rotation of OpenBao's audit file. */
export function jobTimers(): string[] {
  const units = Object.values(readOpsJobs().jobs).flatMap((job) =>
    job.unit === null ? [] : [job.unit],
  );
  // Run 6.5 (P-119): the daily pair, run by backup.sh rather than ops-run.sh.
  return ["mykey-bao-audit-rotate", ...units, "mykey-backup"];
}

/** Run 6.5 (P-120): services enabled at boot without a timer. */
export const BOOT_SERVICES = ["mykey-capture-recover"] as const;

export function timersCommand(units: readonly string[]): string {
  for (const unit of units) {
    if (!/^mykey-[a-z0-9-]+$/.test(unit)) throw new Error(`unusable unit name ${unit}`);
  }
  const files = [
    ...units.flatMap((unit) => [
      `${REMOTE.hostsDir}/systemd/${unit}.service`,
      `${REMOTE.hostsDir}/systemd/${unit}.timer`,
    ]),
    ...BOOT_SERVICES.map((unit) => `${REMOTE.hostsDir}/systemd/${unit}.service`),
  ];
  return [
    `install -m 0644 ${files.join(" ")} /etc/systemd/system/`,
    "systemctl daemon-reload",
    `systemctl enable --now ${units.map((unit) => `${unit}.timer`).join(" ")}`,
    `systemctl enable ${BOOT_SERVICES.map((unit) => `${unit}.service`).join(" ")}`,
    // The heartbeat expects a pair from now on (status.sh: backup_stale).
    hostEnvSetCommand("MYKEY_BACKUP_EXPECTED", "yes"),
  ].join(" && ");
}

async function runTimers(host: HostEntry, address: Address, log: Logger): Promise<void> {
  const units = jobTimers();
  expectSuccess(
    await sshExec(host, timersCommand(units), { sudo: true, address }),
    "installing the job timers",
  );
  log.info(`${host.name}: timers enabled: ${units.join(", ")}`);
}

/** Run 6.2 (P-111): the role passwords ops jobs log in with, where ops-run.sh mounts them. */
export const OPS_ROLE_SECRETS = {
  maintenance: "/etc/mykey/secrets/ops/maintenance",
  backup_reader: "/etc/mykey/secrets/ops/backup_reader",
} as const;

/**
 * Installs the workstation's custody copies of the maintenance and
 * backup_reader passwords for the ops image (owner 1000:1000, mode 0400) and
 * records MYKEY_HOST_NAME. Values cross on stdin only; names are printed.
 */
async function runOpsSecrets(host: HostEntry, address: Address, log: Logger): Promise<void> {
  for (const [role, path] of Object.entries(OPS_ROLE_SECRETS)) {
    const file = workstationRoleSecretFile(host.name, role as RoleName);
    if (!existsSync(file)) throw new Error(`no custody copy of the ${role} password: ${file}`);
    const value = readFileSync(file, "utf8").trim();
    if (value === "") throw new Error(`the custody copy of the ${role} password is empty`);
    registerSecret(value);
    expectSuccess(
      await sshExec(host, secretInstallCommand(path, "1000:1000"), {
        sudo: true,
        address,
        secretOutput: true,
        stdin: value,
      }),
      `installing ${path}`,
    );
    log.info(`${host.name}: ${path} installed`);
  }
  expectSuccess(
    await sshExec(host, hostEnvSetCommand("MYKEY_HOST_NAME", host.name), { sudo: true, address }),
    "writing MYKEY_HOST_NAME",
  );
  log.info(`${host.name}: MYKEY_HOST_NAME=${host.name}`);
}

/**
 * Creates the missing key files on the workstation (existing ones are kept)
 * and installs every key file the host does not have yet. Prints names only.
 */
async function runKeysInit(host: HostEntry, address: Address, log: Logger): Promise<void> {
  const { generateKeyFiles } = await import("@mykey/auth");
  const directory = workstationKeysDirectory(host.name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const created = generateKeyFiles(directory);
  log.info(
    `${host.name}: created on the workstation: ${created.length === 0 ? "nothing" : created.join(", ")}`,
  );
  const names = readdirSync(directory)
    .filter((name) => KEY_FILE_NAME.test(name))
    .sort();
  for (const name of names) {
    const content = readFileSync(join(directory, name), "utf8");
    registerSecret(content.trim());
    expectSuccess(
      await sshExec(host, keyInstallCommand(name), {
        sudo: true,
        address,
        secretOutput: true,
        stdin: content,
      }),
      `installing ${name}`,
    );
  }
  log.info(`${host.name}: key files present on the host: ${names.join(", ")}`);
}

/**
 * Runs one operator command (apps/ops) against the host's database as
 * `maintenance`, through an SSH tunnel; stdin, stdout and stderr are this
 * process's. The keys are the workstation's custody copy.
 */
async function runOpsOnHost(host: HostEntry, argv: string[], address: Address): Promise<number> {
  const { runOps } = await import("@mykey/ops");
  const password = localSecret(workstationRoleSecretFile(host.name, "maintenance"));
  const dir = mkdtempSync(join(tmpdir(), "mykey-ops-"));
  const tunnel = await openTunnel(host, REMOTE.postgres);
  let baoTunnel: Awaited<ReturnType<typeof openTunnel>> | null = null;
  try {
    const caCertPath = join(dir, "ca.crt");
    writeFileSync(
      caCertPath,
      expectSuccess(await sshExec(host, `cat ${REMOTE.caCert}`, { address }), "reading the host CA")
        .stdout,
    );
    // Run 3.8: on a host with OpenBao, the operator token (workstation custody)
    // through a tunnel, and delivery of provisioned credentials over SSH on stdin.
    const env = parseHostEnv(
      expectSuccess(await sshExec(host, `cat ${REMOTE.hostEnv}`, { address }), "reading host.env")
        .stdout,
    );
    let openBao: { target: { url: string; caCertPath: string }; rootToken: string } | undefined;
    const custody = custodyCopyPath(host.name);
    if (env.MYKEY_OPENBAO === "1" && existsSync(custody)) {
      const token = (JSON.parse(readFileSync(custody, "utf8")) as { root_token?: unknown })
        .root_token;
      if (typeof token === "string" && token !== "") {
        registerSecret(token);
        baoTunnel = await openTunnel(host, REMOTE.openbao);
        openBao = {
          target: { url: `https://127.0.0.1:${String(baoTunnel.localPort)}`, caCertPath },
          rootToken: token,
        };
      }
    }
    const flagAt = argv.indexOf("--organization");
    const organizationId = flagAt === -1 ? undefined : argv[flagAt + 1];
    const install = async (path: string, value: string): Promise<void> => {
      expectSuccess(
        await sshExec(host, secretInstallCommand(path, "1000:1000"), {
          sudo: true,
          address,
          secretOutput: true,
          stdin: value,
        }),
        `installing ${path}`,
      );
    };
    const deliver = async (
      name: AppRoleName,
      credential: { roleId: string; secretId: string },
    ): Promise<void> => {
      if (organizationId === undefined) throw new Error("no --organization to deliver for");
      registerSecret(credential.secretId);
      const files = credentialFiles(name);
      await install(files.roleId, credential.roleId);
      await install(files.secretId, credential.secretId);
      await install(files.organizationId, organizationId);
    };
    return await runOps(argv, {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: {
        database: {
          host: "127.0.0.1",
          port: tunnel.localPort,
          database: "postgres",
          user: "maintenance",
          password,
          caCertPath,
        },
        keysDirectory: workstationKeysDirectory(host.name),
        baseUrl: `https://${host.hostname}`,
        ...(openBao === undefined ? {} : { openBao, deliver, boundCidrs: HOST_BOUND_CIDRS }),
      },
    });
  } finally {
    await baoTunnel?.close();
    await tunnel.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runGate(
  host: HostEntry,
  command: { action: GateAction; report?: string; verifying?: true },
  address: Address,
  log: Logger,
): Promise<number> {
  const { action } = command;
  const current = await sshExec(host, `cat ${GATE_FILE}`, { sudo: true, address });
  const previous = current.code === 0 ? current.stdout : null;
  if (action === "status") {
    log.info(previous === null ? `${host.name}: no gate record (closed)` : previous.trim());
    return 0;
  }
  const env = parseHostEnv(
    expectSuccess(await sshExec(host, `cat ${REMOTE.hostEnv}`, { address }), "reading host.env")
      .stdout,
  );
  const hostInstanceId = env.MYKEY_HOST_INSTANCE_ID;
  if (hostInstanceId === undefined)
    throw new Error("host.env has no MYKEY_HOST_INSTANCE_ID: run up first");
  const backendIncarnation = env.MYKEY_BACKEND_INCARNATION;
  if (backendIncarnation !== undefined) {
    return runGateV2(
      host,
      { ...command, action },
      { hostInstanceId, backendIncarnation },
      address,
      log,
    );
  }
  // Ruling (Run 6.7): a host without an incarnation still runs a v1 release
  // (until Run 6.9's first deploy); it keeps v1 records, which that release reads.
  if (command.report !== undefined || command.verifying === true) {
    throw new Error("gate: this host has no MYKEY_BACKEND_INCARNATION yet (a v1 release)");
  }
  log.info(`${host.name}: v1 record (host.env has no MYKEY_BACKEND_INCARNATION)`);
  const record = gateRecordText(
    action === "open" ? "open" : "closed",
    previous,
    hostInstanceId,
    new Date().toISOString(),
  );
  expectSuccess(
    await sshExec(host, gateWriteCommand(), { sudo: true, address, stdin: record }),
    `gate ${action}`,
  );
  log.info(`${host.name}: ${record}`);
  return 0;
}

/**
 * Run 6.7 (P-122, D-54): the v2 record. Open needs a report `mayOpen` accepts
 * and `operator.gate_open` committed first (as maintenance, through a tunnel);
 * close is written first and audited when PostgreSQL answers.
 */
async function runGateV2(
  host: HostEntry,
  command: { action: "open" | "close"; report?: string; verifying?: true },
  binding: { hostInstanceId: string; backendIncarnation: string },
  address: Address,
  log: Logger,
): Promise<number> {
  const { closeGate, openGate } = await import("@mykey/operations/operator");
  const releaseBuild = expectSuccess(
    await sshExec(host, apiBuildCommand(), { sudo: true, address }),
    "reading the API's build",
  ).stdout.trim();
  if (command.action === "open" && !/^[0-9a-f]{7,40}$/.test(releaseBuild)) {
    throw new Error("gate open: the API container is not running or names no build");
  }
  const expect = { ...binding, releaseBuild };
  const writer = {
    read: async (): Promise<string | null> => {
      const answer = await sshExec(host, `cat ${GATE_FILE}`, { sudo: true, address });
      return answer.code === 0 ? answer.stdout : null;
    },
    write: async (text: string): Promise<void> => {
      expectSuccess(
        await sshExec(host, gateWriteCommand(), { sudo: true, address, stdin: text }),
        `gate ${command.action}`,
      );
    },
  };
  let report: unknown = null;
  if (command.action === "open") {
    if (command.report === undefined) {
      throw new Error("gate open: this host needs --report <file> (a verification report)");
    }
    report = JSON.parse(readFileSync(command.report, "utf8"));
  }
  const { createPool } = await import("@mykey/db");
  const password = localSecret(workstationRoleSecretFile(host.name, "maintenance"));
  const dir = mkdtempSync(join(tmpdir(), "mykey-gate-"));
  const tunnel = await openTunnel(host, REMOTE.postgres).catch(() => null);
  let pool: ReturnType<typeof createPool> | null = null;
  try {
    if (tunnel !== null) {
      const caCertPath = join(dir, "ca.crt");
      const ca = await sshExec(host, `cat ${REMOTE.caCert}`, { address });
      if (ca.code === 0) {
        writeFileSync(caCertPath, ca.stdout);
        pool = createPool(
          {
            host: "127.0.0.1",
            port: tunnel.localPort,
            database: "postgres",
            user: "maintenance",
            password,
            caCertPath,
          },
          { max: 1 },
        );
      }
    }
    if (command.action === "close") {
      const closed = await closeGate({
        writer,
        pool,
        expect,
        origin: gateOriginOf(await writer.read(), binding.hostInstanceId),
        phase: command.verifying === true ? "verifying" : "serving",
        now: () => new Date(),
      });
      log.info(`${host.name}: ${JSON.stringify(closed.record)}`);
      if (!closed.audited) log.error(`${host.name}: closed; operator.gate_close not audited`);
      return 0;
    }
    if (pool === null) throw new Error("gate open: PostgreSQL is not reachable for the audit");
    const opened = await openGate({
      writer,
      pool,
      expect,
      report,
      kind:
        (report as { origin?: { kind?: unknown } }).origin?.kind === "restore"
          ? "restore"
          : "deploy",
      now: () => new Date(),
    });
    if (!opened.ok) {
      log.error(`${host.name}: gate open refused: ${opened.cause}`);
      return 1;
    }
    log.info(`${host.name}: ${JSON.stringify(opened.record)}`);
    return 0;
  } finally {
    await pool?.end();
    await tunnel?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ restore (Run 6.7)

/** Where `restore` leaves what `restore-verify` needs, on the workstation (0600). */
export function restoreHandoffFiles(
  host: HostName,
  home: string = homedir(),
): { state: string; token: string; report: string; measurements: string } {
  const directory = join(home, ".mykey", "secrets", "hosts", host);
  return {
    state: join(directory, "restore.json"),
    token: join(directory, "restore-root-token"),
    report: join(directory, "restore-report.json"),
    measurements: join(directory, "restore-measurements.json"),
  };
}

interface RestoreHandoff {
  pairId: string;
  restoreStartedAt: string;
  backendIncarnation: string;
  hostInstanceId: string;
  schemaRevision: string;
  given: Record<string, { state: "ok" | "failed" | "unknown"; observed: string }>;
  /** FR-1.69. */
  captureStartedAt: string;
  startedAt: string;
  restoredAt: string;
}

function hostGateWriter(host: HostEntry, address: Address) {
  return {
    read: async (): Promise<string | null> => {
      const answer = await sshExec(host, `cat ${GATE_FILE}`, { sudo: true, address });
      return answer.code === 0 ? answer.stdout : null;
    },
    write: async (text: string): Promise<void> => {
      expectSuccess(
        await sshExec(host, gateWriteCommand(), { sudo: true, address, stdin: text }),
        "writing the gate",
      );
    },
  };
}

/** The host's CA certificate in a local temporary directory. */
async function localCaCert(host: HostEntry, address: Address, dir: string): Promise<string> {
  const path = join(dir, "ca.crt");
  writeFileSync(
    path,
    expectSuccess(await sshExec(host, `cat ${REMOTE.caCert}`, { address }), "reading the CA")
      .stdout,
  );
  return path;
}

/**
 * P-124 steps 1–7 on a host: the pair from R2 (signature, bundle, Restic,
 * digests), PostgreSQL with new role passwords, OpenBao from the snapshot,
 * every credential class invalidated, started closed + verifying. The
 * restore's root token and the report's inputs stay on the workstation for
 * `restore-verify`.
 */
async function runRestore(
  host: HostEntry,
  command: { source: HostName; pair: string },
  address: Address,
  log: Logger,
): Promise<number> {
  const { loadTrust, newestEligiblePrefix, r2Store } = await import("@mykey/backup");
  const { restoreToVerifying } = await import("@mykey/ops");
  const { OpenBaoAdmin } = await import("@mykey/openbao/admin");
  const { createPool } = await import("@mykey/db");
  const { hostRestoreTarget, pairPrefixFor } = await import("./host-restore.ts");
  const store = r2Store(
    loadR2Credentials(`mykey-${command.source}-pairs-upload`),
    `mykey-${command.source}-pairs`,
  );
  const prefix =
    command.pair === "newest"
      ? await newestEligiblePrefix(store, command.source)
      : await pairPrefixFor(store, command.source, command.pair);
  if (prefix === null)
    throw new Error(`restore: no eligible pair ${command.pair} of ${command.source}`);
  const trust = loadTrust(
    resolve(import.meta.dirname, "..", "infra/hosts/backup/trust"),
    command.source,
  );
  const custody = custodyCopyPath(command.source);
  const pairRootToken = (JSON.parse(readFileSync(custody, "utf8")) as { root_token?: unknown })
    .root_token;
  if (typeof pairRootToken !== "string" || pairRootToken === "") {
    throw new Error(`${custody} holds no root token`);
  }
  registerSecret(pairRootToken);
  const oldMaintenance = localSecret(workstationRoleSecretFile(host.name, "maintenance"));
  const superuserPassword = await hostSecret(host, HOST_SECRETS.postgresSuperuser, address);
  const organizationFile = await sshExec(
    host,
    `if test -s ${credentialFiles("runtime").organizationId}; then cat ${credentialFiles("runtime").organizationId}; fi`,
    { sudo: true, address, secretOutput: true },
  );
  const organizationId =
    organizationFile.stdout.trim() === "" ? null : organizationFile.stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), "mykey-restore-"));
  const restoreStartedAt = new Date();
  const files = restoreHandoffFiles(host.name);
  const target = await hostRestoreTarget(
    {
      exec: async (cmd, opts = {}) => {
        const answer = await sshExec(host, cmd, {
          sudo: true,
          address,
          ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
          ...(opts.secretOutput === true || mentionsSecretPath(cmd) ? { secretOutput: true } : {}),
          ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        });
        return { code: answer.code, stdout: answer.stdout };
      },
      tunnel: (remote) => openTunnel(host, remote),
      caCertPath: await localCaCert(host, address, dir),
      superuserPassword,
      pairRootToken,
      kmsKeyUsable: async (keyId) => {
        try {
          const answer = await sshExec(host, kmsKeyStateCommand("seal", keyId), {
            sudo: true,
            address,
          });
          return answer.code === 0 && kmsKeyState(answer.stdout) === "Active";
        } catch {
          return false;
        }
      },
      keepPassword: async (role, password) => {
        registerSecret(password);
        const onHost = ROLE_HOST_SECRET[role];
        if (ROLE_PASSWORD_PLACE[role] === "host" && onHost !== undefined) {
          expectSuccess(
            await sshExec(host, secretInstallCommand(onHost.path, onHost.owner), {
              sudo: true,
              address,
              stdin: password,
              secretOutput: true,
            }),
            `storing the ${role} password`,
          );
        } else {
          const file = workstationRoleSecretFile(host.name, role);
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, password, { mode: 0o600 });
          chmodSync(file, 0o600);
        }
      },
      setHostEnv: async (key, value) => {
        expectSuccess(
          await sshExec(host, hostEnvSetCommand(key, value), { sudo: true, address }),
          `host.env ${key}`,
        );
      },
      startExecutors: async () => {
        expectSuccess(await sshExec(host, resumeCommand(), { sudo: true, address }), "resume");
        return expectSuccess(
          await sshExec(host, apiBuildCommand(), { sudo: true, address }),
          "reading the API's build",
        ).stdout.trim();
      },
      organizationId,
      log: (line) => {
        log.info(`${host.name}: ${line}`);
      },
    },
    { store, prefix, trust },
  );
  try {
    const restored = await restoreToVerifying(target);
    registerSecret(restored.rootToken);
    try {
      // Two of the old world's credentials the workstation holds: both refused.
      const oldRoot = await new OpenBaoAdmin(target.openbao.target, pairRootToken)
        .lookupSelf()
        .then(() => "accepted")
        .catch(() => "refused");
      const oldPassword = await (async () => {
        const pool = createPool(
          { ...target.postgres.superuser, user: "maintenance", password: oldMaintenance },
          { max: 1 },
        );
        try {
          await pool.query("SELECT 1");
          return "accepted";
        } catch {
          return "refused";
        } finally {
          await pool.end();
        }
      })();
      const handoff: RestoreHandoff = {
        pairId: restored.manifest.pairId,
        restoreStartedAt: restoreStartedAt.toISOString(),
        backendIncarnation: restored.backendIncarnation,
        hostInstanceId: restored.hostInstanceId,
        schemaRevision: restored.manifest.schemaRevision,
        captureStartedAt: restored.manifest.captureStartedAt,
        startedAt: restored.startedAt.toISOString(),
        restoredAt: restored.restoredAt.toISOString(),
        given: {
          ...restored.given,
          old_credentials_refused:
            oldRoot === "refused" && oldPassword === "refused"
              ? {
                  state: "ok",
                  observed: "the pair's root token and the old maintenance password refused",
                }
              : {
                  state: "failed",
                  observed: `root token ${oldRoot}, maintenance password ${oldPassword}`,
                },
        },
      };
      mkdirSync(dirname(files.state), { recursive: true, mode: 0o700 });
      writeFileSync(files.token, restored.rootToken, { mode: 0o600 });
      chmodSync(files.token, 0o600);
      writeFileSync(files.state, JSON.stringify(handoff, null, 2), { mode: 0o600 });
      log.info(
        `${host.name}: pair ${handoff.pairId} restored; closed + verifying; incarnation ${handoff.backendIncarnation}`,
      );
      log.info(`${host.name}: measured (FR-1.69): ${JSON.stringify(restored.measurements)}`);
      log.info(
        `${host.name}: next: ops reset-account for the owner, the journey through tunnel verify, then restore-verify`,
      );
    } finally {
      await restored.pool.end();
    }
    return 0;
  } finally {
    await target.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * P-124 steps 8–9 on a host: the report from both stores (the journey run by
 * the operator, or confirmed by the owner who ran it in a browser); with
 * --open, gate open re-checks what may have changed since, then the
 * restore's root token is revoked and its copy removed.
 */
async function runRestoreVerify(
  host: HostEntry,
  command: { confirmMembers: number; journey: "run" | "owner-confirmed"; open: boolean },
  address: Address,
  log: Logger,
): Promise<number> {
  if (command.journey === "run") {
    // Ruling (Run 6.7): the journey against a host's listener is built with the drill (Run 6.8).
    throw new Error(
      "restore-verify --journey on a host arrives with the drill (Run 6.8); use --owner-confirmed",
    );
  }
  const files = restoreHandoffFiles(host.name);
  if (!existsSync(files.state) || !existsSync(files.token)) {
    throw new Error(`restore-verify: no restore of ${host.name} to verify (${files.state})`);
  }
  const handoff = JSON.parse(readFileSync(files.state, "utf8")) as RestoreHandoff;
  const token = readFileSync(files.token, "utf8").trim();
  registerSecret(token);
  const { restoreVerify, recheckForOpen } = await import("@mykey/ops");
  const { openGate } = await import("@mykey/operations/operator");
  const { OpenBaoAdmin } = await import("@mykey/openbao/admin");
  const { createPool } = await import("@mykey/db");
  const dir = mkdtempSync(join(tmpdir(), "mykey-restore-verify-"));
  const pgTunnel = await openTunnel(host, REMOTE.postgres);
  const baoTunnel = await openTunnel(host, REMOTE.openbao);
  try {
    const caCertPath = await localCaCert(host, address, dir);
    const pool = createPool(
      {
        host: "127.0.0.1",
        port: pgTunnel.localPort,
        database: "postgres",
        user: "postgres",
        password: await hostSecret(host, HOST_SECRETS.postgresSuperuser, address),
        caCertPath,
      },
      { max: 2 },
    );
    try {
      const admin = new OpenBaoAdmin(
        { url: `https://127.0.0.1:${String(baoTunnel.localPort)}`, caCertPath },
        token,
      );
      const releaseBuild = expectSuccess(
        await sshExec(host, apiBuildCommand(), { sudo: true, address }),
        "reading the API's build",
      ).stdout.trim();
      const deps = {
        pool,
        admin,
        host: host.name,
        expect: {
          hostInstanceId: handoff.hostInstanceId,
          backendIncarnation: handoff.backendIncarnation,
          releaseBuild,
        },
        origin: { kind: "restore" as const, pairId: handoff.pairId },
        schemaRevision: handoff.schemaRevision,
        restoreStartedAt: new Date(handoff.restoreStartedAt),
        given: handoff.given,
        confirmMembers: command.confirmMembers,
        boundCidrs: HOST_BOUND_CIDRS,
      };
      const confirmed = { state: "ok" as const, observed: "owner confirmed (--owner-confirmed)" };
      const report = await restoreVerify(deps, {
        checks: {
          journey_owner_enrolled: confirmed,
          journey_reveal_digest: confirmed,
          journey_mutation_refused: confirmed,
        },
      });
      writeFileSync(files.report, JSON.stringify(report, null, 2));
      const failed = report.checks.filter((c) => c.state !== "ok");
      const { restoreMeasurements } = await import("@mykey/ops");
      const measured = restoreMeasurements({
        captureStartedAt: handoff.captureStartedAt,
        startedAt: new Date(handoff.startedAt),
        restoredAt: new Date(handoff.restoredAt),
        report: { createdAt: report.createdAt, failed: failed.length },
      });
      writeFileSync(
        files.measurements,
        JSON.stringify({ host: host.name, pairId: handoff.pairId, ...measured }, null, 2),
      );
      log.info(`${host.name}: measured (FR-1.69): ${JSON.stringify(measured)}`);
      log.info(
        `${host.name}: report ${files.report}: ${String(report.checks.length - failed.length)}/${String(report.checks.length)} ok, members ${String(report.members)}`,
      );
      for (const c of failed) log.error(`${host.name}:   ${c.id}: ${c.state} (${c.observed})`);
      if (!command.open) return failed.length === 0 ? 0 : 1;
      const opened = await openGate({
        writer: hostGateWriter(host, address),
        pool,
        expect: deps.expect,
        report,
        kind: "restore",
        now: () => new Date(),
        recheck: () => recheckForOpen(deps),
      });
      if (!opened.ok) {
        log.error(`${host.name}: gate open refused: ${opened.cause}`);
        return 1;
      }
      await admin.revokeSelf();
      rmSync(files.token, { force: true });
      rmSync(files.state, { force: true });
      expectSuccess(
        await sshExec(host, `rm -f /var/lib/mykey/restore-state.json`, { sudo: true, address }),
        "removing the restore state",
      );
      log.info(`${host.name}: ${JSON.stringify(opened.record)}; the restore's root token revoked`);
      return 0;
    } finally {
      await pool.end();
    }
  } finally {
    await pgTunnel.close();
    await baoTunnel.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run 6.7 (P-123): a local port to the verification listener until Ctrl-C. */
async function runVerifyTunnel(host: HostEntry, log: Logger): Promise<number> {
  const tunnel = await openTunnel(host, REMOTE_API_VERIFY);
  log.info(
    `${host.name}: the verification listener is at https://127.0.0.1:${String(tunnel.localPort)} (Ctrl-C ends it)`,
  );
  await new Promise<void>((resolveStop) => {
    process.once("SIGINT", () => {
      resolveStop();
    });
  });
  await tunnel.close();
  return 0;
}

async function runQuiesce(host: HostEntry, address: Address, log: Logger): Promise<number> {
  await runGate(host, { action: "close" }, address, log);
  const steps = quiesceCommands();
  expectSuccess(await sshExec(host, steps.stop, { sudo: true, address }), "stopping the executors");
  expectSuccess(
    await sshExec(host, steps.restartOpenBao, { sudo: true, address, timeoutMs: 180_000 }),
    "restarting OpenBao",
  );
  await waitForOpenBao(host, address, 300);
  log.info(`${host.name}: executors: stopped`);
  return 0;
}

if (import.meta.main) {
  const log = createLogger();
  try {
    process.exitCode = await main(process.argv.slice(2), log);
  } catch (error) {
    const timedOut = error instanceof SshError && error.kind === "timeout";
    log.error(`host.ts: ${(error as Error).message}`);
    process.exitCode = timedOut ? 3 : 1;
  }
}
