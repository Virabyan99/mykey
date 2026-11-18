// The two OVHcloud hosts as the operator's workstation knows them: the host
// list in ~/.mykey/hosts.json and where things live on a host (Run 2.5).
// Moved from tests/harness/staging.ts in Run 3.2 (M17).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Run 6.8 (P-125, D-56): `drill` is the clean host of the restore drill (production's server, lent). */
export type HostName = "staging" | "prod" | "drill";

export interface HostEntry {
  name: HostName;
  publicIp: string;
  vpnIp: string;
  hostname: string;
  sshUser: "ubuntu";
  /** Run 6.8: the server is lent to another entry; every command for this one is refused. */
  lent?: true;
}

export interface Hosts {
  region: string;
  staging: HostEntry;
  prod: HostEntry;
  /** Only while the drill runs (Run 6.8 until the gate). */
  drill?: HostEntry;
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

function hostEntry(raw: unknown, name: HostName): HostEntry {
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
  if (entry.lent !== undefined && entry.lent !== true) {
    throw new Error(`hosts.json: field ${name}.lent is malformed (true or absent)`);
  }
  return {
    name,
    publicIp: field("publicIp", (value) => IPV4.test(value)),
    vpnIp: field("vpnIp", (value) => IPV4.test(value)),
    hostname: field("hostname", (value) => HOSTNAME.test(value)),
    sshUser: "ubuntu",
    ...(entry.lent === true ? { lent: true as const } : {}),
  };
}

/** The entry a command may use: present, and not lent to another host (Run 6.8). */
export function usableHost(entry: HostEntry | undefined, name: HostName = "drill"): HostEntry {
  if (entry === undefined) throw new Error(`hosts.json: no ${name} entry`);
  if (entry.lent === true) {
    throw new Error(
      `${entry.name}: its server is lent to the drill (hosts.json); every command is refused until the gate gives it back`,
    );
  }
  return entry;
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
    ...(record.drill === undefined ? {} : { drill: hostEntry(record.drill, "drill") }),
  };
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
