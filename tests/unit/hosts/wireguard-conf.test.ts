// The operator's WireGuard configuration (P-28). Nothing here touches the real
// ~/.mykey/wireguard/mykey-ops.conf: every file lives under os.tmpdir().
import { createPublicKey, createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultWireguardFile,
  renderWireguardConfig,
  wireguardKeyPair,
  writeWireguardConfig,
} from "../../../scripts/host.ts";
import type { HostEntry } from "../../harness/staging.ts";

const hosts: { prod: HostEntry; staging: HostEntry } = {
  prod: {
    name: "prod",
    publicIp: "192.0.2.48",
    vpnIp: "10.77.1.1",
    hostname: "prod.example.test",
    sshUser: "ubuntu",
  },
  staging: {
    name: "staging",
    publicIp: "192.0.2.50",
    vpnIp: "10.77.2.1",
    hostname: "staging.example.test",
    sshUser: "ubuntu",
  },
};

const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;
const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "mykey-wg-"));
  dirs.push(dir);
  return join(dir, "wireguard", "mykey-ops.conf");
}

/** The value of `Key = value` lines in one block of a WireGuard file. */
function values(block: string, key: string): string[] {
  return block
    .split("\n")
    .filter((line) => line.startsWith(`${key} = `))
    .map((line) => line.slice(key.length + 3));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("wireguardKeyPair", () => {
  it("returns raw 32-byte X25519 keys in standard base64 (44 characters ending in '=')", () => {
    const { privateKey, publicKey } = wireguardKeyPair();
    expect(privateKey).toMatch(BASE64_KEY);
    expect(publicKey).toMatch(BASE64_KEY);
    expect(Buffer.from(privateKey, "base64")).toHaveLength(32);
    // The public key is the X25519 public key of the private key.
    const jwk = createPublicKey(
      createPrivateKey({
        key: Buffer.concat([
          Buffer.from("302e020100300506032b656e04220420", "hex"),
          Buffer.from(privateKey, "base64"),
        ]),
        format: "der",
        type: "pkcs8",
      }),
    ).export({ format: "jwk" });
    expect(Buffer.from(jwk.x!, "base64url").toString("base64")).toBe(publicKey);
  });
});

describe("renderWireguardConfig", () => {
  const { privateKey } = wireguardKeyPair();
  const prodKey = wireguardKeyPair().publicKey;
  const stagingKey = wireguardKeyPair().publicKey;
  const text = renderWireguardConfig({
    privateKey,
    hosts,
    peerKeys: { prod: prodKey, staging: stagingKey },
  });
  const blocks = text.split(/^(?=\[)/m).filter((block) => block.startsWith("["));

  it("has one [Interface] and two [Peer] blocks", () => {
    expect(blocks.filter((block) => block.startsWith("[Interface]"))).toHaveLength(1);
    expect(blocks.filter((block) => block.startsWith("[Peer]"))).toHaveLength(2);
  });

  it("gives the interface both operator addresses, its private key and no DNS line", () => {
    const iface = blocks.find((block) => block.startsWith("[Interface]"))!;
    expect(values(iface, "Address")).toEqual(["10.77.1.10/32, 10.77.2.10/32"]);
    expect(values(iface, "PrivateKey")).toEqual([privateKey]);
    expect(values(iface, "PrivateKey")[0]).toMatch(BASE64_KEY);
    expect(text).not.toMatch(/^DNS\s*=/m);
  });

  it("routes only each host's VPN address to its peer, with keepalive", () => {
    const peers = blocks.filter((block) => block.startsWith("[Peer]"));
    const prod = peers.find((block) => values(block, "PublicKey")[0] === prodKey)!;
    const stage = peers.find((block) => values(block, "PublicKey")[0] === stagingKey)!;
    expect(values(prod, "AllowedIPs")).toEqual(["10.77.1.1/32"]);
    expect(values(prod, "Endpoint")).toEqual(["192.0.2.48:51820"]);
    expect(values(stage, "AllowedIPs")).toEqual(["10.77.2.1/32"]);
    expect(values(stage, "Endpoint")).toEqual(["192.0.2.50:51820"]);
    for (const peer of peers) expect(values(peer, "PersistentKeepalive")).toEqual(["25"]);
  });

  it("uses LF line endings only", () => {
    expect(text).not.toContain("\r");
  });
});

describe("writeWireguardConfig", () => {
  it("writes the file with mode 0600 and returns only the public key", () => {
    const file = tempFile();
    const prodKey = wireguardKeyPair().publicKey;
    const stagingKey = wireguardKeyPair().publicKey;
    const result = writeWireguardConfig(file, hosts, { prod: prodKey, staging: stagingKey });

    const text = readFileSync(file, "utf8");
    const privateKey = values(text, "PrivateKey")[0]!;
    expect(privateKey).toMatch(BASE64_KEY);
    expect(result.publicKey).toMatch(BASE64_KEY);
    expect(result.publicKey).not.toBe(privateKey);
    expect(JSON.stringify(result)).not.toContain(privateKey);
    expect(text.match(/^\[Peer\]$/gm)).toHaveLength(2);

    if (process.platform === "win32") {
      // Windows ignores POSIX modes: the writer still passes 0600, and the
      // protection is the user profile's ACL. Check the default target lies in it.
      const fromHome = relative(homedir(), defaultWireguardFile());
      expect(fromHome.startsWith("..") || isAbsolute(fromHome)).toBe(false);
    } else {
      // Linux (CI) honours the mode.
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the operator's private key when a peer is added later", () => {
    const file = tempFile();
    const first = writeWireguardConfig(file, hosts, { staging: wireguardKeyPair().publicKey });
    expect(readFileSync(file, "utf8").match(/^\[Peer\]$/gm)).toHaveLength(1);
    const privateBefore = values(readFileSync(file, "utf8"), "PrivateKey")[0];

    const second = writeWireguardConfig(file, hosts, { prod: wireguardKeyPair().publicKey });
    const text = readFileSync(file, "utf8");
    expect(second.publicKey).toBe(first.publicKey);
    expect(values(text, "PrivateKey")[0]).toBe(privateBefore);
    expect(text.match(/^\[Peer\]$/gm)).toHaveLength(2);
  });

  it("defaults to ~/.mykey/wireguard/mykey-ops.conf", () => {
    expect(defaultWireguardFile("/home/someone")).toBe(
      join("/home/someone", ".mykey", "wireguard", "mykey-ops.conf"),
    );
  });
});
