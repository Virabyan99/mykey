// Run 6.4 Task B (P-117, FR-1.95, AC-1.49): the private status view on
// staging, and the absence of any diagnostic surface on the public name.
//  - `host.ts staging status --json` has every check with an observation time
//    younger than 120 s; KMS reachability and the seal state are two lines.
//  - The owner's session gets 404 for each diagnostic path through the
//    public name; the proxy has no dashboard port that answers from the VPN.
import { spawnSync } from "node:child_process";
import net from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadHosts, type StatusLine } from "@mykey/ops/remote";
import { publicRequest, stagingOwnerSession } from "../harness/staging-owner.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PATHS = [
  "/status",
  "/v1/status",
  "/v1/operator/status",
  "/metrics",
  "/debug",
  "/dashboard/",
  "/api/rawdata",
  "/v1/health/details",
];

describe("the operator status view (P-117)", () => {
  it("every check has an observation time younger than 120 s; KMS and seal are two lines", () => {
    const run = spawnSync(process.execPath, ["scripts/host.ts", "staging", "status", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 240_000,
    });
    expect(run.status, run.stderr.slice(-500)).toBe(0);
    const start = run.stdout.indexOf("{");
    const view = JSON.parse(run.stdout.slice(start)) as { lines: StatusLine[] };
    const now = Date.now();
    expect(view.lines.length).toBeGreaterThan(30);
    for (const line of view.lines) {
      expect(line.observedAt, line.check).not.toBeNull();
      expect(now - Date.parse(line.observedAt ?? ""), line.check).toBeLessThan(120_000);
      expect(line.state, `${line.check}: ${line.value}`).not.toBe("unknown");
    }
    const checks = view.lines.map((line) => line.check);
    expect(checks).toContain("sealed");
    expect(checks).toContain("kmsReachable");
    expect(checks).toContain("checks.diskLow");
    expect(checks).toContain("probe.open");
  }, 300_000);
});

describe("no diagnostic surface (P-117)", () => {
  it("the owner's session gets 404 for every diagnostic path through the public name", async () => {
    const { cookie } = await stagingOwnerSession();
    // Control: the same session reaches a product route.
    const control = await publicRequest("GET", "/v1/organizations", { cookie });
    expect(control.status, control.body).toBe(200);
    for (const path of PATHS) {
      const answer = await publicRequest("GET", path, { cookie });
      expect(answer.status, path).toBe(404);
    }
  }, 120_000);

  it("the proxy's dashboard port answers nothing from the VPN", async () => {
    const host = loadHosts().staging;
    // Control: SSH answers on the VPN address (the only listener there).
    expect(await connects(host.vpnIp, 22)).toBe(true);
    for (const port of [8080, 9000])
      expect(await connects(host.vpnIp, port), String(port)).toBe(false);
  }, 60_000);
});

function connects(address: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = net.connect({ host: address, port, timeout: 5_000 });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => {
      done(false);
    });
  });
}
