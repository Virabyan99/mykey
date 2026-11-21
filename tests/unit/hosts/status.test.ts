import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHostStatus } from "../../harness/staging.ts";

const base = {
  host: "staging",
  bootId: "6f1c2f0e-0000-4000-8000-000000000001",
  time: "2026-11-11T18:00:00.250Z",
  containers: {},
  sealed: null,
  sealType: null,
  kmsReachable: null,
  pendingRevert: [],
};

const at = Date.parse("2026-11-11T18:00:00.000Z");

describe("parseHostStatus", () => {
  it("keeps what the host measured about its clock, firewall and SSH listeners", () => {
    const status = parseHostStatus(
      JSON.stringify({
        ...base,
        chronyOffsetMs: 0.412,
        clockSynced: true,
        firewall: { loaded: true, sets: { dns: 1, ntp: 2, apt: 16, registry: 0 } },
        sshListen: ["10.77.2.1:22"],
      }),
      at,
      at + 100,
    );
    expect(status.chronyOffsetMs).toBe(0.412);
    expect(status.clockSynced).toBe(true);
    expect(status.firewall).toEqual({
      loaded: true,
      sets: { dns: 1, ntp: 2, apt: 16, registry: 0 },
    });
    expect(status.sshListen).toEqual(["10.77.2.1:22"]);
    // Host clock minus workstation clock at the middle of the request.
    expect(status.clockOffsetMs).toBe(200);
  });

  it("reports an unsynchronised clock as unknown, never as zero", () => {
    const status = parseHostStatus(
      JSON.stringify({ ...base, chronyOffsetMs: null, clockSynced: false }),
      at,
      at,
    );
    expect(status.chronyOffsetMs).toBeNull();
    expect(status.clockSynced).toBe(false);
  });

  it("reads the review count and the provisioner's health (Run 3.8)", () => {
    const status = parseHostStatus(
      JSON.stringify({ ...base, reviewOpen: 2, provisioner: "healthy" }),
      at,
      at,
    );
    expect(status.reviewOpen).toBe(2);
    expect(status.provisioner).toBe("healthy");
    const odd = parseHostStatus(
      JSON.stringify({ ...base, reviewOpen: -1, provisioner: "sleepy" }),
      at,
      at,
    );
    expect(odd.reviewOpen).toBeNull();
    expect(odd.provisioner).toBeNull();
  });

  it("reads the unresolved operations (Run 4.5)", () => {
    expect(
      parseHostStatus(JSON.stringify({ ...base, operationsUnresolved: 3 }), at, at)
        .operationsUnresolved,
    ).toBe(3);
    expect(
      parseHostStatus(JSON.stringify({ ...base, operationsUnresolved: "x" }), at, at)
        .operationsUnresolved,
    ).toBeNull();
  });

  it("says unknown for everything an older status.sh does not print", () => {
    const status = parseHostStatus(JSON.stringify(base), at, at);
    expect(status.operationsUnresolved).toBeNull();
    expect(status.reviewOpen).toBeNull();
    expect(status.provisioner).toBeNull();
    expect(status.chronyOffsetMs).toBeNull();
    expect(status.clockSynced).toBeNull();
    expect(status.firewall).toBeNull();
    expect(status.sshListen).toBeNull();
  });

  it("refuses a firewall report whose set count is not a number", () => {
    expect(() =>
      parseHostStatus(
        JSON.stringify({ ...base, firewall: { loaded: true, sets: { dns: "many" } } }),
        at,
        at,
      ),
    ).toThrow(/firewall/);
  });
});

// Run 2.7 finding: during a KMS outage the dropped handshake kept the check's
// container alive (openssl as PID 1 ignores SIGTERM), so status.sh and the
// heartbeat that runs it hung, and the probe would have seen a missing
// heartbeat instead of kms_unreachable.
describe("status.sh", () => {
  it("cannot hang on a container: every docker run has an init and a killing timeout", () => {
    const script = readFileSync(
      resolve(import.meta.dirname, "../../../infra/hosts/checks/status.sh"),
      "utf8",
    );
    const runs = script.split("\n").filter((line) => line.includes("docker run"));
    expect(runs.length).toBeGreaterThan(0);
    for (const line of runs) {
      expect(line).toMatch(/timeout -k \d+ \d+ docker run /);
      expect(line).toContain(" --init ");
    }
  });

  // Run 8.0 (P-149, Session 6 finding F): the audit block, run in a shell with
  // the host's commands stubbed. OpenBao's audit directory is one of the three
  // parts; a host without the container has not measured it.
  describe("the audit block", () => {
    const script = readFileSync(
      resolve(import.meta.dirname, "../../../infra/hosts/checks/status.sh"),
      "utf8",
    ).replaceAll("\r\n", "\n");
    const start = script.indexOf("# Audit (P-116)");
    const end = script.indexOf("# Certificates");
    const block = script.slice(start, end);

    function audit(openbao: "absent" | "writable" | "unwritable"): string {
      const stubs = [
        // the API's log holds no health_down line
        'docker() { case "$1" in',
        '  logs) echo \'{"event":"request"}\'; return 0 ;;',
        `  inspect) [ "${openbao}" != absent ] ;;`,
        `  exec) [ "${openbao}" = writable ] ;;`,
        "  *) return 1 ;;",
        "esac; }",
        "jq() { cat >/dev/null; }",
        "systemctl() { echo active; }",
        "pg_read() { echo f; }",
      ].join("\n");
      const out = spawnSync("bash", ["-c", `${stubs}\n${block}\necho "$audit_failing"`], {
        encoding: "utf8",
      });
      expect(out.status, out.stderr).toBe(0);
      return out.stdout.trim();
    }

    it("is a whole block of the script", () => {
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
    });

    it("status: with no OpenBao container the audit device is unknown, not healthy", () => {
      expect(audit("absent")).toBe("null");
    });

    it("control: with OpenBao's audit directory writable it is healthy, and failing when not", () => {
      expect(audit("writable")).toBe("false");
      expect(audit("unwritable")).toBe("true");
    });
  });

  it("reports the service gate as the host reads it (Run 3.1)", () => {
    for (const gate of ["open", "closed", "absent", "invalid"]) {
      expect(parseHostStatus(JSON.stringify({ ...base, gate }), at, at).gate).toBe(gate);
    }
    expect(parseHostStatus(JSON.stringify(base), at, at).gate).toBeNull();
    expect(parseHostStatus(JSON.stringify({ ...base, gate: "ajar" }), at, at).gate).toBeNull();
  });
});
