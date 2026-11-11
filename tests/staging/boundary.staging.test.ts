// Run 2.5 Task D: the boundary of a MyKey host, proven from outside it.
//
// Runs from the operator's workstation. The scans target the public address
// (never the tunnel); SSH over the VPN is used only to read what the host
// itself reports and to start probe containers on staging. Production gets
// the read-only checks only: the scans and `docker inspect`.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectionConfig } from "@mykey/db";
import { parseEgressNames } from "../../scripts/host.ts";
import {
  NMAP_IMAGE,
  ipInCidr,
  nmap,
  operatorWireguardConf,
  parseAllowedIps,
  parseNmapPorts,
  tcpAnswer,
  waitForHealth,
  type ScannedPort,
} from "../harness/outside.ts";
import {
  connectStaging,
  expectSuccess,
  loadHosts,
  parseHostEnv,
  REMOTE,
  sshArgs,
  sshExec,
  type HostEntry,
  type StagingStack,
} from "../harness/staging.ts";

const EVIDENCE = resolve(import.meta.dirname, "../../docs/evidence/session-2");
const EGRESS_NAMES = resolve(import.meta.dirname, "../../infra/hosts/firewall/egress-names.conf");
/** TEST-NET-1 (RFC 5737): nothing listens there. A port open on it is answered by the scanner's own network. */
const CONTROL = "192.0.2.1";
/** Outside every egress set of the hosts. */
const ARBITRARY = "8.8.8.8";
const UDP_PORTS = "51820,53,123,500";
const SCAN_TIMEOUT_MS = 900_000;

const hosts = loadHosts();
const run = async (host: HostEntry, command: string, sudo = true): Promise<string> =>
  expectSuccess(await sshExec(host, command, { sudo, timeoutMs: 120_000 }), command).stdout;

// --------------------------------------------------------------- the scan

interface Scan {
  tcp: ScannedPort[];
  udp: ScannedPort[];
  /** Ports that also answer on CONTROL: the scanner's network answers them, not the host. */
  intercepted: ScannedPort[];
}

const isOpen = (port: ScannedPort): boolean => port.state === "open";

async function scan(host: HostEntry, file: string, note: string): Promise<Scan> {
  const tcpText = await nmap(
    ["-sS", "-p-", "--min-rate", "1000", "--max-retries", "3", host.publicIp],
    SCAN_TIMEOUT_MS,
  );
  const udpText = await nmap(
    ["-sU", "-p", UDP_PORTS, "--max-retries", "3", host.publicIp],
    300_000,
  );
  const tcp = parseNmapPorts(tcpText);
  const udp = parseNmapPorts(udpText);
  const tcpProbes = [...new Set([443, ...tcp.filter(isOpen).map((port) => port.port)])];
  const controlTcpText = await nmap(
    ["-sS", "-p", tcpProbes.join(","), "--max-retries", "3", CONTROL],
    300_000,
  );
  const controlUdpText = await nmap(
    ["-sU", "-p", UDP_PORTS, "--max-retries", "3", CONTROL],
    300_000,
  );
  const control = [...parseNmapPorts(controlTcpText), ...parseNmapPorts(controlUdpText)];
  // The method itself: the reserved address must not look like a web server.
  expect(control.find((port) => port.port === 443 && port.protocol === "tcp")?.state).not.toBe(
    "open",
  );
  // The interception on the scanner's side was seen to miss one probe, so a
  // port that looks open on the host is asked on CONTROL up to three more times.
  const retries: string[] = [];
  const suspects = [...tcp, ...udp].filter(
    (port) =>
      isOpen(port) &&
      !(port.port === 443 && port.protocol === "tcp") &&
      !control.some(
        (other) => other.port === port.port && other.protocol === port.protocol && isOpen(other),
      ),
  );
  for (const port of suspects) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const text = await nmap(
        [port.protocol === "tcp" ? "-sS" : "-sU", "-p", String(port.port), CONTROL],
        120_000,
      );
      retries.push(text.trim());
      const answer = parseNmapPorts(text)[0];
      if (answer !== undefined && isOpen(answer)) {
        control.push(answer);
        break;
      }
    }
  }
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(
    resolve(EVIDENCE, file),
    [
      `# Outside scan of ${host.name} (${host.hostname}, ${host.publicIp})`,
      `# ${new Date().toISOString()}, from the operator workstation over the internet (not the tunnel)`,
      `# image: ${NMAP_IMAGE}`,
      `# ${note}`,
      "",
      "## TCP, all ports",
      tcpText.trim(),
      "",
      `## UDP ${UDP_PORTS}`,
      udpText.trim(),
      "",
      `## Control: ${CONTROL} (TEST-NET-1, nothing listens there)`,
      controlTcpText.trim(),
      controlUdpText.trim(),
      ...(retries.length === 0 ? [] : ["", "## Control, asked again", ...retries]),
      "",
    ].join("\n"),
  );
  // Only a definite answer counts: `open|filtered` on CONTROL means nothing answered.
  return { tcp, udp, intercepted: control.filter(isOpen) };
}

/** Listening sockets of the host as `proto address:port` (from `ss`). */
async function listeners(host: HostEntry): Promise<{ proto: string; local: string }[]> {
  return (await run(host, "ss -Hlntu"))
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 5)
    .map((fields) => ({ proto: fields[0] ?? "", local: fields[4] ?? "" }));
}

const loopback = (local: string): boolean =>
  /^(127\.|\[::1\]|::1)/.test(local) || local.includes("%lo:");

async function expectOnlyHttps(host: HostEntry, result: Scan): Promise<void> {
  const intercepted = (port: ScannedPort): boolean =>
    result.intercepted.some(
      (other) => other.port === port.port && other.protocol === port.protocol,
    );
  expect(
    result.tcp.filter((port) => isOpen(port) && !intercepted(port)).map((port) => port.port),
  ).toEqual([443]);
  // UDP: WireGuard answers no unauthenticated packet, so nmap can at best say
  // open|filtered; the tunnel itself is the proof that 51820 is open. Nothing is `open`.
  expect(result.udp.filter((port) => isOpen(port) && !intercepted(port))).toEqual([]);
  // A port the scanner's own network answers is judged on the host: nothing
  // listens on it except on loopback.
  const sockets = await listeners(host);
  for (const port of [...result.tcp, ...result.udp].filter(intercepted)) {
    const exposed = sockets.filter(
      (socket) =>
        socket.proto === port.protocol &&
        socket.local.endsWith(`:${port.port}`) &&
        !loopback(socket.local),
    );
    expect(exposed, `${port.port}/${port.protocol} on ${host.name}`).toEqual([]);
  }
}

async function expectTunnelUp(host: HostEntry): Promise<void> {
  // This SSH connection itself runs through the tunnel; the handshake age shows it is current.
  const output = await run(host, "wg show wg0 latest-handshakes");
  const ages = output
    .trim()
    .split("\n")
    .map((line) => Math.floor(Date.now() / 1000) - Number(line.trim().split(/\s+/)[1]));
  expect(ages.length).toBe(1);
  expect(ages[0]).toBeLessThan(300);
}

function expectScanBypassesTunnel(host: HostEntry): void {
  const ranges = parseAllowedIps(operatorWireguardConf());
  expect(ranges.length).toBeGreaterThan(0);
  expect(ranges.some((range) => ipInCidr(host.vpnIp, range))).toBe(true);
  expect(ranges.filter((range) => ipInCidr(host.publicIp, range))).toEqual([]);
  expect(ranges.filter((range) => ipInCidr(CONTROL, range))).toEqual([]);
}

// ----------------------------------------------------------- other checks

async function expectNoPlainHttp(host: HostEntry): Promise<void> {
  expect(["refused", "timeout"]).toContain(await tcpAnswer(host.publicIp, 80, 8_000));
}

/** Runs ssh over the VPN with public-key authentication switched off. */
function sshWithoutKey(host: HostEntry): Promise<{ code: number; stderr: string }> {
  const args = sshArgs(host, "true", { address: "vpn" });
  // Options go before the destination, which sshArgs puts second to last.
  args.splice(
    args.length - 2,
    0,
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "PreferredAuthentications=password,keyboard-interactive",
  );
  return new Promise((resolveRun, reject) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const err: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolveRun({ code: code ?? -1, stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

async function expectSshVpnOnlyKeyOnly(host: HostEntry): Promise<void> {
  expect(["refused", "timeout"]).toContain(await tcpAnswer(host.publicIp, 22, 8_000));
  const attempt = await sshWithoutKey(host);
  expect(attempt.code).toBe(255);
  expect(attempt.stderr).toContain("Permission denied (publickey)");
}

async function expectPrivateServicesClosed(host: HostEntry): Promise<void> {
  const probes = [host.publicIp, host.vpnIp].flatMap((address) =>
    [5432, 8200, 8443].map(async (port) => ({
      target: `${address}:${port}`,
      answer: await tcpAnswer(address, port, 8_000),
    })),
  );
  for (const { target, answer } of await Promise.all(probes)) {
    expect(["refused", "timeout"], target).toContain(answer);
  }
}

const INSPECT_FORMAT = [
  "{{json .Name}}",
  "{{json .Config.User}}",
  "{{json .HostConfig.ReadonlyRootfs}}",
  "{{json .HostConfig.CapAdd}}",
  "{{json .HostConfig.CapDrop}}",
  "{{json .HostConfig.SecurityOpt}}",
  "{{json .HostConfig.Memory}}",
  "{{json .HostConfig.PidsLimit}}",
  "[{{range .Mounts}}{{json .Source}},{{end}}null]",
].join(",");

async function expectContainersRestricted(host: HostEntry): Promise<void> {
  const output = await run(host, `docker inspect --format '[${INSPECT_FORMAT}]' $(docker ps -q)`);
  const containers = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown[]);
  const names = containers.map((fields) => String(fields[0]).replace(/^\//, ""));
  expect(names.sort()).toEqual(["mykey-api-1", "mykey-edge-1", "mykey-postgres-1"]);
  for (const [
    name,
    user,
    readOnly,
    capAdd,
    capDrop,
    securityOpt,
    memory,
    pids,
    mounts,
  ] of containers as [
    string,
    string,
    boolean,
    string[] | null,
    string[] | null,
    string[] | null,
    number,
    number | null,
    (string | null)[],
  ][]) {
    expect(user, name).toMatch(/^[1-9]\d*(:[1-9]\d*)?$/);
    expect(readOnly, name).toBe(true);
    expect(capAdd ?? [], name).toEqual([]);
    expect(capDrop ?? [], name).toContain("ALL");
    expect(securityOpt ?? [], name).toContain("no-new-privileges:true");
    expect(memory, name).toBeGreaterThan(0);
    expect(pids ?? 0, name).toBeGreaterThan(0);
    for (const source of mounts.filter((mount) => mount !== null)) {
      expect(source, name).not.toContain("docker.sock");
    }
  }
  // The processes as the host kernel sees them, not only the configured user.
  for (const name of names) {
    // Docker needs the pid column in the ps output.
    const uids = (await run(host, `docker top ${name} -eo pid,uid`))
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[1] ?? "");
    expect(uids.length, name).toBeGreaterThan(0);
    expect(
      uids.filter((uid) => uid === "0"),
      name,
    ).toEqual([]);
  }
}

async function setMembers(host: HostEntry, set: string): Promise<string[]> {
  const output = await run(
    host,
    `nft -j list set inet mykey ${set} | jq -r '.nftables[] | select(.set) | .set.elem[]? | if type == "object" then .elem.val else . end'`,
  );
  return output
    .trim()
    .split("\n")
    .filter((line) => line !== "");
}

interface EgressReading {
  any443: boolean;
  acme443: boolean;
  kms5696: boolean;
  udp53: boolean;
  dns: boolean;
}

async function egressFrom(
  host: HostEntry,
  network: string,
  targets: { acme: string; kms: string },
): Promise<EgressReading> {
  const env = parseHostEnv(await run(host, `cat ${REMOTE.hostEnv}`, false));
  const image = env.API_IMAGE;
  expect(image).toMatch(/^sha256:[0-9a-f]{64}$/);
  const script = [
    `nc -w 4 -z ${ARBITRARY} 443 && echo any443=1 || echo any443=0`,
    `nc -w 4 -z ${targets.acme} 443 && echo acme443=1 || echo acme443=0`,
    `nc -w 4 -z ${targets.kms} 5696 && echo kms5696=1 || echo kms5696=0`,
    `nslookup -timeout=3 example.com ${ARBITRARY} >/dev/null 2>&1 && echo udp53=1 || echo udp53=0`,
    "nslookup -timeout=3 acme-v02.api.letsencrypt.org >/dev/null 2>&1 && echo dns=1 || echo dns=0",
  ].join("; ");
  const output = await run(
    host,
    `docker run --rm --network ${network} --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint sh ${image} -c '${script}'`,
  );
  const value = (key: string): boolean => new RegExp(`^${key}=1$`, "m").test(output);
  return {
    any443: value("any443"),
    acme443: value("acme443"),
    kms5696: value("kms5696"),
    udp53: value("udp53"),
    dns: value("dns"),
  };
}

async function expectEgressAsTheTableSays(host: HostEntry): Promise<void> {
  const networks = (await run(host, "docker network ls --filter name=mykey_ --format '{{.Name}}'"))
    .trim()
    .split("\n")
    .sort();
  // mykey_kms and mykey_bao arrive with OpenBao in Run 2.7; this list must grow with them.
  expect(networks).toEqual(["mykey_db", "mykey_edge", "mykey_pub"]);
  const acme = (await setMembers(host, "acme"))[0];
  const kms = (await setMembers(host, "kms"))[0];
  if (acme === undefined || kms === undefined) throw new Error("the acme or kms set is empty");
  for (const set of ["dns", "ntp", "acme", "kms", "r2", "probe", "apt", "registry"]) {
    expect(await setMembers(host, set), set).not.toContain(ARBITRARY);
  }
  const nothing = { any443: false, acme443: false, kms5696: false, udp53: false, dns: false };
  expect(await egressFrom(host, "mykey_pub", { acme, kms })).toEqual({
    ...nothing,
    acme443: true,
    // Docker's resolver answers public names on mk-pub, which may reach the resolver (D-21).
    dns: true,
  });
  expect(await egressFrom(host, "mykey_edge", { acme, kms })).toEqual(nothing);
  expect(await egressFrom(host, "mykey_db", { acme, kms })).toEqual(nothing);
}

async function expectHostEgressLimited(host: HostEntry): Promise<void> {
  const curl = async (url: string): Promise<{ code: number; status: string }> => {
    const result = await sshExec(host, `curl -s -o /dev/null -m 15 -w '%{http_code}' ${url}`, {
      timeoutMs: 60_000,
    });
    return { code: result.code, status: result.stdout.trim() };
  };
  // 7: could not connect (the output chain rejects).
  expect(await curl(`https://${ARBITRARY}/`)).toEqual({ code: 7, status: "000" });
  // ACME is for the edge container on mk-pub, not for the host.
  expect((await curl("https://acme-v02.api.letsencrypt.org/directory")).status).toBe("000");
  // Allowed names connect: the R2 endpoint (R31) and, from Run 2.6 on, the probe.
  const names = parseEgressNames(readFileSync(EGRESS_NAMES, "utf8"));
  for (const purpose of ["r2", "probe"] as const) {
    const name = names.find((entry) => entry.purpose === purpose)?.name;
    if (name === undefined) throw new Error(`egress-names.conf has no ${purpose} name`);
    const allowed = await curl(`https://${name}/`);
    expect(allowed.code, purpose).toBe(0);
    expect(allowed.status, purpose).toMatch(/^[1-5]\d\d$/);
  }
}

async function expectPostgresThroughTunnel(stack: StagingStack): Promise<void> {
  const client = new pg.Client(
    connectionConfig({
      host: stack.pg.host,
      port: stack.pg.port,
      database: stack.pg.database,
      user: stack.pg.superuser.user,
      password: stack.pg.superuser.password,
      caCertPath: stack.pg.caCertPath,
    }),
  );
  await client.connect();
  try {
    const result = await client.query<{ ok: number }>("select 1 as ok");
    expect(result.rows[0]?.ok).toBe(1);
  } finally {
    await client.end();
  }
}

// ------------------------------------------------------------------ tests

describe("staging, as deployed", () => {
  const host = hosts.staging;
  let stack: StagingStack;

  beforeAll(async () => {
    stack = await connectStaging();
  });
  afterAll(async () => {
    await stack.close();
  });

  it(
    "only 443/tcp answers from the internet",
    async () => {
      expectScanBypassesTunnel(host);
      await expectOnlyHttps(host, await scan(host, "host-scan-staging.txt", "as deployed"));
      await expectTunnelUp(host);
    },
    SCAN_TIMEOUT_MS * 2,
  );

  it("has no plain HTTP listener", async () => {
    await expectNoPlainHttp(host);
  });

  it("keeps SSH VPN-only and key-only", async () => {
    await expectSshVpnOnlyKeyOnly(host);
  });

  it("does not expose the private services, which answer through the tunnel", async () => {
    await expectPrivateServicesClosed(host);
    await expectPostgresThroughTunnel(stack);
  });

  it("runs its containers restricted", async () => {
    await expectContainersRestricted(host);
  });

  it("lets each bridge out only where the table says", async () => {
    await expectEgressAsTheTableSays(host);
  });

  it("keeps the host itself from reaching an arbitrary site", async () => {
    await expectHostEgressLimited(host);
  });

  it(
    "restores all of it after a reboot, with no command in between",
    async () => {
      const status = await stack.status();
      // Doc 10 §4.1: never reboot with a revert pending.
      expect(status.pendingRevert).toEqual([]);
      const { secondsUntilSsh } = await stack.reboot();
      const secondsUntilHealthy = await waitForHealth(host.hostname, 200, 600_000);
      expectScanBypassesTunnel(host);
      await expectOnlyHttps(
        host,
        await scan(
          host,
          "host-scan-staging-after-reboot.txt",
          `after a reboot: SSH back after ${secondsUntilSsh} s, /health 200 ${secondsUntilHealthy} s later`,
        ),
      );
      await expectTunnelUp(host);
      await expectNoPlainHttp(host);
      await expectSshVpnOnlyKeyOnly(host);
      await expectPrivateServicesClosed(host);
      await expectPostgresThroughTunnel(stack);
      await expectContainersRestricted(host);
      await expectEgressAsTheTableSays(host);
      await expectHostEgressLimited(host);
    },
    SCAN_TIMEOUT_MS * 3,
  );
});

describe("production, read-only checks from outside", () => {
  const host = hosts.prod;

  it(
    "only 443/tcp answers from the internet",
    async () => {
      expectScanBypassesTunnel(host);
      await expectOnlyHttps(host, await scan(host, "host-scan-prod.txt", "as deployed"));
      await expectTunnelUp(host);
    },
    SCAN_TIMEOUT_MS * 2,
  );

  it("has no plain HTTP listener, VPN-only SSH and no exposed private service", async () => {
    await expectNoPlainHttp(host);
    await expectSshVpnOnlyKeyOnly(host);
    await expectPrivateServicesClosed(host);
  });

  it("runs its containers restricted", async () => {
    await expectContainersRestricted(host);
  });
});
