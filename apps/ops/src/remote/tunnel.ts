// `ssh -L` tunnels over the VPN (Run 2.5). Moved from tests/harness/staging.ts in Run 3.2 (M17).
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { HostEntry } from "./hosts.ts";
import { SshError, sshArgs } from "./ssh.ts";

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
