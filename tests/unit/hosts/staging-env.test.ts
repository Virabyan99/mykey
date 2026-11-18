// ~/.mykey/hosts.json and the preflight of `pnpm run test:staging`: a missing
// file, key or VPN is a failure that names what is missing, never a skip.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stagingPreflight } from "../../../scripts/require-staging-env.ts";
import { hostsFile, loadHosts, sshPaths } from "../../harness/staging.ts";

const homes: string[] = [];

const VALID = {
  region: "test-region",
  staging: {
    name: "staging",
    publicIp: "192.0.2.50",
    vpnIp: "10.77.2.1",
    hostname: "staging.example.test",
    sshUser: "ubuntu",
  },
  prod: {
    name: "prod",
    publicIp: "192.0.2.48",
    vpnIp: "10.77.1.1",
    hostname: "prod.example.test",
    sshUser: "ubuntu",
  },
};

/** A temporary home with the given ~/.mykey files. */
function home(files: { hosts?: unknown; key?: boolean; knownHosts?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "mykey-home-"));
  homes.push(dir);
  mkdirSync(join(dir, ".mykey", "ssh"), { recursive: true });
  if (files.hosts !== undefined) {
    const text = typeof files.hosts === "string" ? files.hosts : JSON.stringify(files.hosts);
    writeFileSync(hostsFile(dir), text);
  }
  // Placeholders only: the preflight checks that the files exist, never their content.
  if (files.key === true) writeFileSync(sshPaths(dir).key, "placeholder");
  if (files.knownHosts === true) writeFileSync(sshPaths(dir).knownHosts, "placeholder");
  return dir;
}

const unreachable = () => Promise.resolve(false);
const reachable = () => Promise.resolve(true);

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadHosts", () => {
  it("returns the hosts of a valid file", () => {
    expect(loadHosts(hostsFile(home({ hosts: VALID })))).toEqual(VALID);
  });

  // Run 6.8 (P-125, D-56): the drill host is a third entry; production is lent to it.
  it("reads a drill entry and a lent mark; a drill entry is optional", () => {
    const drill = { ...VALID.prod, name: "drill", hostname: "drill.example.test" };
    const hosts = loadHosts(
      hostsFile(home({ hosts: { ...VALID, prod: { ...VALID.prod, lent: true }, drill } })),
    );
    expect(hosts.drill).toEqual(drill);
    expect(hosts.prod.lent).toBe(true);
    expect(hosts.staging.lent).toBeUndefined();
    expect(loadHosts(hostsFile(home({ hosts: VALID }))).drill).toBeUndefined();
    expect(() =>
      loadHosts(hostsFile(home({ hosts: { ...VALID, prod: { ...VALID.prod, lent: "yes" } } }))),
    ).toThrow(/prod\.lent/);
    expect(() =>
      loadHosts(hostsFile(home({ hosts: { ...VALID, drill: { ...drill, name: "prod" } } }))),
    ).toThrow(/drill\.name/);
  });

  it("throws naming the file when it is missing", () => {
    expect(() => loadHosts(hostsFile(home({})))).toThrow(/hosts\.json is missing/);
  });

  it("throws when the file is not JSON", () => {
    expect(() => loadHosts(hostsFile(home({ hosts: "{" })))).toThrow(/hosts\.json/);
  });

  it.each([
    ["region", { ...VALID, region: undefined }],
    ["staging", { ...VALID, staging: undefined }],
    ["staging.vpnIp", { ...VALID, staging: { ...VALID.staging, vpnIp: undefined } }],
    ["staging.vpnIp", { ...VALID, staging: { ...VALID.staging, vpnIp: "10.77.2" } }],
    ["prod.publicIp", { ...VALID, prod: { ...VALID.prod, publicIp: "example.test" } }],
    ["prod.hostname", { ...VALID, prod: { ...VALID.prod, hostname: "" } }],
    ["prod.sshUser", { ...VALID, prod: { ...VALID.prod, sshUser: "root" } }],
    ["prod.name", { ...VALID, prod: { ...VALID.prod, name: "staging" } }],
  ])("throws naming the field %s", (field, content) => {
    expect(() => loadHosts(hostsFile(home({ hosts: content })))).toThrow(field);
  });
});

describe("stagingPreflight", () => {
  it("names ~/.mykey/hosts.json when it is missing", async () => {
    const problems = await stagingPreflight({
      home: home({ key: true, knownHosts: true }),
      probe: reachable,
    });
    expect(problems.join("\n")).toContain("hosts.json");
  });

  it("names the SSH key and the known-hosts file when they are missing", async () => {
    const problems = await stagingPreflight({ home: home({ hosts: VALID }), probe: reachable });
    expect(problems.join("\n")).toContain("mykey_ops_ed25519");
    expect(problems.join("\n")).toContain("known_hosts");
  });

  it("names the staging VPN address when it does not answer on port 22 within 5 s", async () => {
    const asked: [string, number, number][] = [];
    const problems = await stagingPreflight({
      home: home({ hosts: VALID, key: true, knownHosts: true }),
      probe: (address, port, timeoutMs) => {
        asked.push([address, port, timeoutMs]);
        return unreachable();
      },
    });
    expect(asked).toEqual([["10.77.2.1", 22, 5000]]);
    expect(problems).toEqual([
      "staging VPN address 10.77.2.1 does not answer on port 22 within 5 s",
    ]);
  });

  it("reports nothing when everything is in place", async () => {
    const problems = await stagingPreflight({
      home: home({ hosts: VALID, key: true, knownHosts: true }),
      probe: reachable,
    });
    expect(problems).toEqual([]);
  });
});
