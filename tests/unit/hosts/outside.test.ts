// Run 2.5 Task D: the pure parts of the outside checks (tests/harness/outside.ts).
import { describe, expect, it } from "vitest";
import {
  NMAP_IMAGE,
  ipInCidr,
  parseAllowedIps,
  parseNmapPorts,
  parseWireguardEndpoints,
} from "../../harness/outside.ts";

describe("nmap output", () => {
  const sample = [
    "Starting Nmap 7.98 ( https://nmap.org ) at 2026-11-11 17:00 UTC",
    "Nmap scan report for 203.0.113.50",
    "Host is up (0.18s latency).",
    "Not shown: 65534 filtered tcp ports (no-response)",
    "PORT    STATE SERVICE",
    "443/tcp open  https",
    "",
    "PORT      STATE         SERVICE",
    "53/udp    open|filtered domain",
    "123/udp   closed        ntp",
    "51820/udp open|filtered unknown",
    "Nmap done: 1 IP address (1 host up) scanned in 812.12 seconds",
  ].join("\n");

  it("reads every listed port with its protocol and state", () => {
    expect(parseNmapPorts(sample)).toEqual([
      { port: 443, protocol: "tcp", state: "open" },
      { port: 53, protocol: "udp", state: "open|filtered" },
      { port: 123, protocol: "udp", state: "closed" },
      { port: 51820, protocol: "udp", state: "open|filtered" },
    ]);
  });

  it("refuses output of a scan that did not finish or did not reach the host", () => {
    expect(() => parseNmapPorts("Starting Nmap 7.98\n443/tcp open https\n")).toThrow(/finish/);
    expect(() =>
      parseNmapPorts("Note: Host seems down.\nNmap done: 1 IP address (0 hosts up) scanned"),
    ).toThrow(/up/);
  });

  it("runs the image pinned in the lock, by digest", () => {
    expect(NMAP_IMAGE).toMatch(/^instrumentisto\/nmap@sha256:[0-9a-f]{64}$/);
  });
});

describe("WireGuard configuration", () => {
  it("lists the address ranges the tunnel carries", () => {
    const conf = [
      "[Interface]",
      "Address = 10.77.1.10/32, 10.77.2.10/32",
      "[Peer]",
      "AllowedIPs = 10.77.1.1/32",
      "Endpoint = 203.0.113.48:51820",
      "[Peer]",
      "AllowedIPs = 10.77.2.1/32, 10.77.9.0/24",
    ].join("\r\n");
    expect(parseAllowedIps(conf)).toEqual(["10.77.1.1/32", "10.77.2.1/32", "10.77.9.0/24"]);
  });

  it("decides whether an IPv4 address falls inside a range", () => {
    expect(ipInCidr("10.77.2.1", "10.77.2.1/32")).toBe(true);
    expect(ipInCidr("10.77.9.200", "10.77.9.0/24")).toBe(true);
    expect(ipInCidr("203.0.113.50", "10.77.9.0/24")).toBe(false);
    expect(ipInCidr("203.0.113.50", "0.0.0.0/0")).toBe(true);
    expect(() => ipInCidr("::1", "0.0.0.0/0")).toThrow(/IPv4/);
  });

  it("reads the public address of each peer from `wg show wg0 endpoints`", () => {
    expect(parseWireguardEndpoints("abcKEY=\t198.51.100.7:61234\nxyzKEY=\t(none)\n")).toEqual([
      "198.51.100.7",
    ]);
  });
});
