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
  hostStatus,
  isHostname,
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
import type { RoleName } from "@mykey/db";

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
  status                         print the host status as JSON
  gate <open|close|status>       the service gate record (P-43); every deploy starts closed
--public uses the public address instead of the VPN (bootstrap always does).`;

export type HostCommand = { host: HostName; via: Address } & (
  | { command: "bootstrap" | "push" | "confirm" | "up" | "db-init" | "status" | "bao-init" }
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
  | { command: "gate"; action: GateAction }
);

export type GateAction = "open" | "close" | "status";

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
    if (option !== "--public") throw new Error(`unknown option ${option}`);
  }
  const via: Address = command === "bootstrap" || options.includes("--public") ? "public" : "vpn";
  const base = { host, via } as const;
  switch (command) {
    case "bootstrap":
    case "push":
    case "confirm":
    case "up":
    case "db-init":
    case "status":
    case "bao-init":
      if (positional.length !== 0) throw new Error(USAGE);
      return { ...base, command };
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
    case "gate": {
      const [action] = positional;
      if (
        positional.length !== 1 ||
        (action !== "open" && action !== "close" && action !== "status")
      ) {
        throw new Error("gate needs open, close or status");
      }
      return { ...base, command, action };
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
} as const;

/**
 * Where the password of each database role is kept. Only a role that a
 * service on the host logs in with is on the host; the others stay on the
 * operator's workstation under ~/.mykey/secrets/hosts/<host>/.
 */
export const ROLE_PASSWORD_PLACE: Record<RoleName, "host" | "workstation"> = {
  migration_owner: "workstation",
  api_runtime: "host",
  provisioner_runtime: "workstation",
  backup_reader: "workstation",
  maintenance: "workstation",
};

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
  return `${COMPOSE}${withOpenBao ? " --profile openbao" : ""} up -d`;
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
    passwords[role] =
      ROLE_PASSWORD_PLACE[role] === "host"
        ? await hostSecret(host, HOST_SECRETS.apiRuntime, address)
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
    case "status":
      log.info(JSON.stringify(await hostStatus(host, address), null, 2));
      return 0;
    case "gate":
      return runGate(host, command.action, address, log);
  }
}

async function runGate(
  host: HostEntry,
  action: GateAction,
  address: Address,
  log: Logger,
): Promise<number> {
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
