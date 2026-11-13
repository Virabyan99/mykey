// Refuses to start the staging tests unless the staging host can be reached,
// so a missing file, key or VPN is a failure and never a silent skip.
// Run: node scripts/require-staging-env.ts
import { existsSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { hostsFile, loadHosts, sshPaths } from "@mykey/ops/remote";

const SSH_PORT = 22;
const PROBE_TIMEOUT_MS = 5_000;

export type PortProbe = (address: string, port: number, timeoutMs: number) => Promise<boolean>;

/** True when a TCP connection to address:port opens within the time. */
export const tcpProbe: PortProbe = (address, port, timeoutMs) =>
  new Promise((resolveProbe) => {
    const socket = net.connect({ host: address, port });
    const done = (answered: boolean): void => {
      socket.destroy();
      resolveProbe(answered);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      done(true);
    });
    socket.once("timeout", () => {
      done(false);
    });
    socket.once("error", () => {
      done(false);
    });
  });

/** What is missing for `pnpm run test:staging`; empty when everything is in place. */
export async function stagingPreflight(
  opts: { home?: string; probe?: PortProbe } = {},
): Promise<string[]> {
  const home = opts.home ?? homedir();
  const problems: string[] = [];
  let vpnIp: string | undefined;
  if (!existsSync(hostsFile(home))) {
    problems.push(`~/.mykey/hosts.json is missing (${hostsFile(home)})`);
  } else {
    try {
      vpnIp = loadHosts(hostsFile(home)).staging.vpnIp;
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  const { key, knownHosts } = sshPaths(home);
  if (!existsSync(key))
    problems.push(`the SSH key ~/.mykey/ssh/mykey_ops_ed25519 is missing (${key})`);
  if (!existsSync(knownHosts)) {
    problems.push(`the SSH known-hosts file ~/.mykey/ssh/known_hosts is missing (${knownHosts})`);
  }
  if (problems.length > 0 || vpnIp === undefined) return problems;

  const probe = opts.probe ?? tcpProbe;
  if (!(await probe(vpnIp, SSH_PORT, PROBE_TIMEOUT_MS))) {
    problems.push(
      `staging VPN address ${vpnIp} does not answer on port ${SSH_PORT} within ${PROBE_TIMEOUT_MS / 1000} s`,
    );
  }
  return problems;
}

if (import.meta.main) {
  const problems = await stagingPreflight();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`staging environment: ${problem}`);
    process.exit(1);
  }
  console.log("staging environment present: hosts.json, SSH key and the VPN answer.");
}
