// Harness for the staging host: the staging stack reached through `ssh -L`
// tunnels over the VPN. The host list, SSH, redaction, tunnels and the status
// report moved to apps/ops/src/remote in Run 3.2 (M17); they are re-exported
// here so the tests keep one import.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  REMOTE,
  expectSuccess,
  hostStatus,
  loadHosts,
  openTunnel,
  parseHostEnv,
  registerSecret,
  sshExec,
  type HostEntry,
  type HostStatus,
  type Tunnel,
} from "@mykey/ops/remote";
import type { Stack } from "./stack.ts";

export * from "@mykey/ops/remote";

// ------------------------------------------------------------- staging stack

// No `api`: on a host the API is a container, not a process of the test.
export interface StagingStack extends Omit<Stack, "api"> {
  host: HostEntry;
  status(): Promise<HostStatus>;
  reboot(): Promise<{ secondsUntilSsh: number }>;
  close(): Promise<void>;
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
