// The operator's tool for the two OVHcloud hosts. Run: node scripts/host.ts
// <staging|prod> <command> (see USAGE). Every remote step is one SSH command
// through tests/harness/staging.ts; nothing is printed except through the
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
  redact,
  registerSecret,
  shQuote,
  sshExec,
  type HostEntry,
  type Hosts,
} from "../tests/harness/staging.ts";
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
  up                             create missing host secrets, then docker compose up -d
  db-init                        roles and migrations through an SSH tunnel
  status                         print the host status as JSON
--public uses the public address instead of the VPN (bootstrap always does).`;

export type HostCommand = { host: HostName; via: Address } & (
  | { command: "bootstrap" | "push" | "confirm" | "up" | "db-init" | "status" }
  | { command: "apply"; target: "firewall" | "ssh" }
  | { command: "image"; name: string; tar: string }
  | { command: "acme"; directory: AcmeDirectory }
  | { command: "kms-csr"; name: string }
  | { command: "maint"; minutes: number; argv: string[] }
);

export function parseHostArgs(argv: string[]): HostCommand {
  const [host, command, ...rest] = argv;
  if (host === undefined || command === undefined) throw new Error(USAGE);
  if (host !== "staging" && host !== "prod") {
    throw new Error(`unknown host "${host}": use staging or prod`);
  }
  let words = rest;
  let tail: string[] = [];
  if (command === "maint") {
    const separator = rest.indexOf("--");
    if (separator < 0) throw new Error("maint needs -- before the command");
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

/**
 * Switches the ACME directory. The edge and its certificate store go with it:
 * a certificate of the other directory must not be served or renewed. `up`
 * afterwards starts the edge, which asks the new directory once.
 */
/**
 * A KMS access certificate's key (Run 2.7): made on the host, kept in
 * /etc/mykey/secrets/kms, never replaced; only the CSR is put where it can be read.
 */
export function kmsCsrCommands(name: string): { create: string; read: string } {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error("invalid certificate name");
  const key = `${REMOTE.secretsDir}/kms/${name}.key`;
  const csr = `/etc/mykey/kms-csr/${name}.csr`;
  return {
    create: [
      `install -d -m 0700 -o root -g root ${REMOTE.secretsDir}/kms`,
      "install -d -m 0755 -o root -g root /etc/mykey/kms-csr",
      `test ! -e ${key}`,
      `(umask 077 && openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ${key} -out ${csr} -subj /CN=${name} 2>/dev/null)`,
      `chmod 0400 ${key}`,
      `chmod 0644 ${csr}`,
    ].join(" && "),
    read: `cat ${csr}`,
  };
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

async function runUp(host: HostEntry, address: Address, log: Logger): Promise<void> {
  for (const secret of Object.values(HOST_SECRETS)) await hostSecret(host, secret, address);
  const pki = dirname(REMOTE.caCert);
  expectSuccess(
    await sshExec(host, `install -d -m 0755 -o root -g root ${pki}`, { sudo: true, address }),
    `creating ${pki}`,
  );
  const result = await sshExec(host, `${COMPOSE} up -d`, {
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
  let id = imageIdFromLoadOutput(output);
  if (id === undefined) {
    const ref = /Loaded image: (\S+)/.exec(output)?.[1];
    if (ref === undefined || !/^[a-z0-9][a-z0-9._/:@-]*$/.test(ref)) {
      throw new Error("docker load reported no image");
    }
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
    const result = await migrate({
      ...base,
      user: "migration_owner",
      password: passwords.migration_owner,
    });
    log.info(`${host.name}: roles ${ROLE_NAMES.join(", ")}`);
    log.info(
      `${host.name}: applied ${result.applied.length === 0 ? "nothing" : result.applied.join(", ")}`,
    );
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
    case "up":
      await runUp(host, address, log);
      return 0;
    case "db-init":
      await runDbInit(host, address, log);
      return 0;
    case "status":
      log.info(JSON.stringify(await hostStatus(host, address), null, 2));
      return 0;
  }
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
