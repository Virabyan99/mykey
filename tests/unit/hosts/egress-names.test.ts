// The names the host firewall resolves into its egress sets (P-30).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EGRESS_PURPOSES, parseEgressNames } from "../../../scripts/host.ts";

const FILE = resolve(import.meta.dirname, "../../../infra/hosts/firewall/egress-names.conf");
const text = readFileSync(FILE, "utf8");

describe("infra/hosts/firewall/egress-names.conf", () => {
  const entries = parseEgressNames(text);

  it("parses", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("has exactly the purposes acme, kms, r2, probe, apt and registry", () => {
    expect([...EGRESS_PURPOSES].sort()).toEqual(["acme", "apt", "kms", "probe", "r2", "registry"]);
    expect([...new Set(entries.map((entry) => entry.purpose))].sort()).toEqual(
      [...EGRESS_PURPOSES].sort(),
    );
  });

  it("holds no bare IP address and no wildcard", () => {
    for (const { name } of entries) {
      expect(name).not.toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
      expect(name).not.toContain(":");
      expect(name).not.toContain("*");
    }
  });

  it("is stored with LF line endings", () => {
    expect(text).not.toContain("\r");
  });

  it("names the R2 endpoint of the account, not a placeholder", () => {
    const r2 = entries.filter((entry) => entry.purpose === "r2").map((entry) => entry.name);
    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatch(/^[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/);
  });

  it("names every host a Docker Hub pull was seen to use (run-2.5.md)", () => {
    const registry = entries
      .filter((entry) => entry.purpose === "registry")
      .map((entry) => entry.name);
    // Blobs were served from CloudFront on 11 Nov 2026, not from the Cloudflare name.
    expect(registry.sort()).toEqual([
      "auth.docker.io",
      "production.cloudflare.docker.com",
      "production.cloudfront.docker.com",
      "registry-1.docker.io",
    ]);
  });

  it("keeps the registry set current for the whole maintenance window", () => {
    const script = readFileSync(resolve(FILE, "../mykey-egress.sh"), "utf8");
    // A CDN changes its addresses within a minute; one resolution at the start is not enough.
    expect(script).toMatch(/--unit=mykey-maint-refresh/);
    expect(script).toMatch(/systemctl stop mykey-maint-refresh\.service/);
    expect(script).toMatch(/^maint-loop\) maint_loop ;;$/m);
  });
});

describe("parseEgressNames", () => {
  it("accepts comments and blank lines", () => {
    expect(parseEgressNames("# names\n\nacme acme-v02.api.letsencrypt.org\n")).toEqual([
      { purpose: "acme", name: "acme-v02.api.letsencrypt.org" },
    ]);
  });

  it.each([
    ["a wildcard", "registry *.docker.io"],
    ["a bare IPv4 address", "apt 192.0.2.10"],
    ["an IPv6 address", "apt 2001:db8::1"],
    ["an unknown purpose", "smtp mail.example.test"],
    ["a third field", "apt archive.ubuntu.com extra"],
    ["a missing name", "apt"],
    ["a label with an underscore", "apt bad_name.example.test"],
    ["a single label", "apt localhost"],
  ])("rejects %s and names the line", (_what, line) => {
    expect(() => parseEgressNames(`# header\n${line}\n`)).toThrow(/line 2/);
  });
});
