// Run 10.2 Task B (P-177, D-77): `probe.ts secrets --host <host>` puts one
// host's existing heartbeat back after a reinstall. It makes no token, writes
// no Worker secret and touches no other host: the bare `secrets` makes new
// tokens for both hosts, production included, and the owner must then set
// PROBE_READ_TOKEN again.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heartbeatInstallPlan } from "../../../scripts/probe.ts";

const TOKEN = "heartbeat-token-of-the-test";

function homeWith(host: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "mykey-probe-"));
  if (host !== null) {
    mkdirSync(join(home, ".mykey", "secrets", "probe"), { recursive: true });
    writeFileSync(join(home, ".mykey", "secrets", "probe", `heartbeat-${host}`), `${TOKEN}\n`);
  }
  return home;
}

describe("probe.ts secrets --host", () => {
  it("plans one host: its heartbeat file from the token already on the workstation, the units, no Worker secret, and no command for production", () => {
    const plan = heartbeatInstallPlan("staging", homeWith("staging"));
    expect(plan.host).toBe("staging");
    expect(plan.curlConfig).toMatch(/^url = "https:\/\/[^"]+\/v1\/heartbeat\/staging"\n/);
    expect(plan.curlConfig).toContain(`header = "Authorization: Bearer ${TOKEN}"`);
    const all = plan.commands.join("\n");
    expect(all).toContain("/etc/mykey/secrets/heartbeat/curl.conf");
    expect(all).toContain("systemctl enable --now mykey-heartbeat.timer");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toMatch(/\bprod\b/);
    expect(Object.keys(plan).sort()).toEqual(["commands", "curlConfig", "host"]);
  });

  it("refuses without a token on the workstation, and makes none", () => {
    const home = homeWith(null);
    expect(() => heartbeatInstallPlan("staging", home)).toThrow(/no heartbeat token for staging/);
    expect(existsSync(join(home, ".mykey", "secrets", "probe", "heartbeat-staging"))).toBe(false);
  });
});
