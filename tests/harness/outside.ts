// Checks of a MyKey host as the internet sees it, run from the operator's
// workstation (Run 2.5 Task D). Nothing here logs in to a host: the SSH steps
// of the outside tests go through tests/harness/staging.ts.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";

const run = promisify(execFile);

const lock = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../infra/dependencies.lock.json"), "utf8"),
) as { images: Record<string, { image: string; digest: string }> };
const nmapPin = lock.images.nmap;
if (nmapPin === undefined) throw new Error("infra/dependencies.lock.json has no images.nmap");

/** The pinned nmap image, by digest. */
export const NMAP_IMAGE = `${nmapPin.image}@${nmapPin.digest}`;

// ---------------------------------------------------------------------- nmap

export interface ScannedPort {
  port: number;
  protocol: "tcp" | "udp";
  state: string;
}

/** The port lines of normal nmap output. Throws unless the scan finished with the host up. */
export function parseNmapPorts(text: string): ScannedPort[] {
  const done = /^Nmap done: .*\((\d+) hosts? up\)/m.exec(text);
  if (done === null) throw new Error("nmap did not finish");
  if (done[1] !== "1") throw new Error("nmap did not see the host up");
  const ports: ScannedPort[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+)\/(tcp|udp)\s+(\S+)/.exec(line);
    if (match?.[1] === undefined || match[3] === undefined) continue;
    ports.push({ port: Number(match[1]), protocol: match[2] as "tcp" | "udp", state: match[3] });
  }
  return ports;
}

/**
 * Runs the pinned nmap in a container on the workstation and returns its
 * normal output. `-Pn`: the hosts drop ping-like probes on most ports.
 */
export async function nmap(args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await run("docker", ["run", "--rm", NMAP_IMAGE, "-Pn", ...args], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

// ----------------------------------------------------------------- WireGuard

/** Every AllowedIPs range of a WireGuard configuration file. */
export function parseAllowedIps(conf: string): string[] {
  return conf
    .split(/\r?\n/)
    .map((line) => /^\s*AllowedIPs\s*=\s*(.+)$/i.exec(line)?.[1])
    .filter((value) => value !== undefined)
    .flatMap((value) => value.split(",").map((range) => range.trim()))
    .filter((range) => range !== "");
}

const ipv4ToNumber = (address: string): number => {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    throw new Error(`not an IPv4 address: ${address}`);
  return parts.reduce((sum, part) => sum * 256 + part, 0);
};

export function ipInCidr(address: string, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const length = Number(bits);
  if (base === undefined || !Number.isInteger(length) || length < 0 || length > 32) {
    throw new Error(`not an IPv4 range: ${cidr}`);
  }
  const size = 2 ** (32 - length);
  return Math.floor(ipv4ToNumber(address) / size) === Math.floor(ipv4ToNumber(base) / size);
}

/** The operator's tunnel configuration (written by `host.ts bootstrap`). */
export function operatorWireguardConf(home: string = homedir()): string {
  return readFileSync(join(home, ".mykey", "wireguard", "mykey-ops.conf"), "utf8");
}

/** IPv4 addresses of the peers in `wg show wg0 endpoints` output. */
export function parseWireguardEndpoints(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => /\s(\d{1,3}(?:\.\d{1,3}){3}):\d+\s*$/.exec(line)?.[1])
    .filter((value) => value !== undefined);
}

// ----------------------------------------------------------------- sockets

export type TcpAnswer = "open" | "refused" | "timeout" | "error";

/** What a TCP connection attempt to address:port gets within the time. */
export function tcpAnswer(address: string, port: number, timeoutMs: number): Promise<TcpAnswer> {
  return new Promise((resolveAnswer) => {
    const socket = net.connect({ host: address, port });
    const done = (answer: TcpAnswer): void => {
      socket.destroy();
      resolveAnswer(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      done("open");
    });
    socket.once("timeout", () => {
      done("timeout");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      done(error.code === "ECONNREFUSED" ? "refused" : "error");
    });
  });
}

export interface HandshakeResult {
  ok: boolean;
  protocol: string | null;
  /** The error code, e.g. ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION, when the handshake failed. */
  code: string | null;
}

/** One TLS handshake to address:443. `servername: null` sends no SNI. */
export function tlsHandshake(opts: {
  address: string;
  servername: string | null;
  minVersion?: tls.SecureVersion;
  maxVersion?: tls.SecureVersion;
  ciphers?: string;
  timeoutMs?: number;
}): Promise<HandshakeResult> {
  return new Promise((resolveHandshake) => {
    const socket = tls.connect({
      host: opts.address,
      port: 443,
      ...(opts.servername === null ? {} : { servername: opts.servername }),
      ...(opts.minVersion === undefined ? {} : { minVersion: opts.minVersion }),
      ...(opts.maxVersion === undefined ? {} : { maxVersion: opts.maxVersion }),
      ...(opts.ciphers === undefined ? {} : { ciphers: opts.ciphers }),
      // Only the protocol is under test here; the chain is checked by httpsGet.
      rejectUnauthorized: false,
    });
    const done = (result: HandshakeResult): void => {
      socket.destroy();
      resolveHandshake(result);
    };
    socket.setTimeout(opts.timeoutMs ?? 15_000);
    socket.once("secureConnect", () => {
      done({ ok: true, protocol: socket.getProtocol(), code: null });
    });
    socket.once("timeout", () => {
      done({ ok: false, protocol: null, code: "TIMEOUT" });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      done({ ok: false, protocol: null, code: error.code ?? error.message });
    });
  });
}

export interface HttpsAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** True when the chain verified under Node's root certificates. */
  authorized: boolean;
  certificate: { subject: string; subjectAltName: string; issuer: string; validTo: string };
}

/** GET https://<hostname><path> with full certificate verification. */
export function httpsGet(
  hostname: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpsAnswer> {
  return new Promise((resolveGet, reject) => {
    const request = https.get(
      { host: hostname, path, headers, timeout: 20_000, agent: false },
      (response) => {
        const socket = response.socket as tls.TLSSocket;
        const peer = socket.getPeerCertificate();
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolveGet({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            authorized: socket.authorized,
            certificate: {
              subject: [peer.subject.CN].flat().filter(Boolean).join(" "),
              subjectAltName: peer.subjectaltname ?? "",
              issuer: [peer.issuer.O, peer.issuer.CN].flat().filter(Boolean).join(" "),
              validTo: peer.valid_to,
            },
          });
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error(`GET ${hostname}${path} timed out`)));
    request.once("error", reject);
  });
}

/** Polls GET /health until it answers `status`, or throws after the time. */
export async function waitForHealth(
  hostname: string,
  status: number,
  timeoutMs: number,
): Promise<number> {
  const started = Date.now();
  let last: string;
  for (;;) {
    try {
      const answer = await httpsGet(hostname, "/health");
      if (answer.status === status) return Math.round((Date.now() - started) / 1000);
      last = `HTTP ${answer.status}`;
    } catch (error) {
      last = (error as Error).message;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${hostname}/health did not answer ${status} in ${timeoutMs} ms (${last})`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
  }
}
