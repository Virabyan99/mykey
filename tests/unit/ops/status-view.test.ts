// Run 6.4 Task B (P-117, FR-1.95, AC-1.49): the private status view. Every
// field of the host's report has a line; a check observed more than 180 s ago,
// or null, is unknown; no line holds a secret path, a token or an address.
import { describe, expect, it } from "vitest";
import {
  certificateWarningMs,
  formatStatusView,
  parseHostStatus,
  statusView,
  type HostStatus,
  type ProbeState,
} from "@mykey/ops/remote";
import { certificateThresholdMs } from "@mykey/probe/evaluate";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function report(ageMs = 10_000, checks: Record<string, unknown> | null = null): string {
  return JSON.stringify({
    host: "staging",
    bootId: "b0d1e8f0-0000-4000-8000-000000000000",
    time: iso(NOW - ageMs),
    chronyOffsetMs: 0.2,
    clockSynced: true,
    containers: {
      "mykey-api-1": {
        state: "running",
        pid: 10,
        startedAt: iso(NOW - 3_600_000),
        imageId: "sha256:aa",
      },
    },
    sealed: false,
    sealType: "kmip",
    kmsReachable: true,
    pendingRevert: [],
    firewall: { loaded: true, sets: { kms: 2 } },
    sshListen: ["10.8.0.1:22"],
    gate: "open",
    reviewOpen: 0,
    operationsUnresolved: 0,
    provisioner: "healthy",
    checks: checks ?? {
      sealed: false,
      kmsReachable: true,
      reviewOpen: 0,
      operationsUnresolved: 0,
      firewallLoaded: true,
      diskLow: false,
      auditFailing: false,
      captureSince: null,
      backup: { expected: true, newestEligibleCaptureAt: iso(NOW - 3_600_000) },
      certificates: [
        {
          name: "public",
          notBefore: iso(NOW - 10 * 86_400_000),
          notAfter: iso(NOW + 80 * 86_400_000),
        },
      ],
      credentialExpiring: 0,
      unitsFailed: [],
    },
  });
}
const status = (text: string): HostStatus => parseHostStatus(text, NOW, NOW);
const probe: ProbeState = { evaluatedAt: NOW - 30_000, lastHeartbeatAt: NOW - 20_000, open: [] };

describe("statusView (P-117)", () => {
  it("every field of the report and of its checks has a line, and the probe has three", () => {
    const host = status(report());
    const checks = statusView(host, probe, NOW).map((line) => line.check);
    for (const key of Object.keys(host).filter((name) => name !== "checks"))
      expect(checks).toContain(key);
    for (const key of Object.keys(host.checks ?? {})) expect(checks).toContain(`checks.${key}`);
    expect(checks.filter((name) => name.startsWith("probe."))).toEqual([
      "probe.evaluatedAt",
      "probe.heartbeat",
      "probe.open",
    ]);
    expect(statusView(host, probe, NOW).every((line) => line.state === "ok")).toBe(true);
  });

  it("KMS reachability and the seal state are two lines", () => {
    const lines = statusView(status(report()), probe, NOW);
    expect(lines.find((line) => line.check === "sealed")?.value).toBe("false");
    expect(lines.find((line) => line.check === "kmsReachable")?.value).toBe("true");
  });

  it("a report observed more than 180 s ago is unknown on every line", () => {
    const lines = statusView(status(report(181_000)), probe, NOW).filter(
      (line) => !line.check.startsWith("probe."),
    );
    expect(lines.every((line) => line.state === "unknown")).toBe(true);
    expect(
      statusView(status(report(179_000)), probe, NOW).every((line) => line.state === "ok"),
    ).toBe(true);
  });

  it("a null check is unknown, an absent captureSince too; no probe state is unknown", () => {
    const nulls = JSON.parse(report()) as { checks: Record<string, unknown> };
    for (const key of Object.keys(nulls.checks)) nulls.checks[key] = null;
    delete nulls.checks.captureSince;
    const lines = statusView(status(JSON.stringify(nulls)), null, NOW);
    for (const line of lines.filter(
      (l) => l.check.startsWith("checks.") || l.check.startsWith("probe."),
    )) {
      expect(line.state, line.check).toBe("unknown");
    }
  });

  it("bad readings are bad: a frozen capture, a stale backup, a certificate within its threshold, a failed unit, an open alert", () => {
    const text = report(10_000, {
      ...(JSON.parse(report()) as { checks: Record<string, unknown> }).checks,
      captureSince: iso(NOW - 700_000),
      backup: { expected: true, newestEligibleCaptureAt: null },
      certificates: [
        {
          name: "kms-client",
          notBefore: iso(NOW - 25 * 86_400_000),
          notAfter: iso(NOW + 5 * 86_400_000),
        },
      ],
      unitsFailed: ["mykey-backup.service"],
    });
    const lines = statusView(status(text), { ...probe, open: ["unit_failed"] }, NOW);
    const state = (check: string) => lines.find((line) => line.check === check)?.state;
    for (const check of [
      "checks.captureSince",
      "checks.backup",
      "checks.certificates",
      "checks.unitsFailed",
      "probe.open",
    ]) {
      expect(state(check), check).toBe("bad");
    }
  });

  it("no line holds a path under /etc/mykey/secrets, a token or an address", () => {
    const text = formatStatusView(statusView(status(report()), probe, NOW));
    expect(text).not.toMatch(/\/etc\/mykey\/secrets/);
    expect(text).not.toMatch(/\b[0-9]{1,3}(\.[0-9]{1,3}){3}\b/);
    // OpenBao's token shapes (hvs., hvb., legacy s. + 24) and an Authorization value.
    expect(text).not.toMatch(/\bhv[sbr]\.|(^|[^A-Za-z])s\.[A-Za-z0-9]{24}\b|Bearer/);
  });

  it("uses the probe's certificate threshold", () => {
    for (const days of [10, 30, 60, 61, 90, 365]) {
      const notBefore = iso(NOW);
      const notAfter = iso(NOW + days * 86_400_000);
      expect(certificateWarningMs(notBefore, notAfter)).toBe(
        certificateThresholdMs(notBefore, notAfter),
      );
    }
  });
});
