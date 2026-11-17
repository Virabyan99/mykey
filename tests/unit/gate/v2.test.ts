// Run 6.7 Task A (P-122, D-54): when a verification report may open the gate.
// Only a report of this host, incarnation and build, younger than 30 minutes,
// with every required check present and `ok`. Its hash is what the record names.
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@mykey/backup";
import {
  REQUIRED_CHECKS,
  gateRecordV2Schema,
  verificationReportSchema,
  type VerificationReport,
} from "@mykey/contracts";
import { mayOpen } from "@mykey/operations";
import { describe, expect, it } from "vitest";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const expected = {
  hostInstanceId: randomUUID(),
  backendIncarnation: randomUUID(),
  releaseBuild: "abcdef123456",
};

function report(
  kind: "restore" | "deploy",
  overrides: Partial<VerificationReport> = {},
): VerificationReport {
  return {
    format: "mykey-verification/1",
    host: "staging",
    hostInstanceId: expected.hostInstanceId,
    backendIncarnation: expected.backendIncarnation,
    releaseBuild: expected.releaseBuild,
    origin:
      kind === "restore"
        ? { kind: "restore", pairId: randomUUID() }
        : { kind: "fresh_install", id: randomUUID() },
    createdAt: new Date(NOW - 60_000).toISOString(),
    checks: REQUIRED_CHECKS[kind].map((id) => ({ id, state: "ok", observed: "synthetic" })),
    members: 1,
    ...overrides,
  };
}

describe("mayOpen (P-122)", () => {
  it.each(["restore", "deploy"] as const)(
    "opens for the right %s report, with its hash",
    (kind) => {
      const r = report(kind);
      expect(verificationReportSchema.parse(r)).toEqual(r);
      expect(mayOpen(r, expected, kind, NOW)).toEqual({
        ok: true,
        sha256: createHash("sha256").update(canonicalJson(r)).digest("hex"),
      });
    },
  );

  it.each([
    [
      "31 minutes old",
      { createdAt: new Date(NOW - 31 * 60_000).toISOString() },
      /older than 30 minutes/,
    ],
    ["from the future", { createdAt: new Date(NOW + 5 * 60_000).toISOString() }, /in the future/],
    ["of another host", { hostInstanceId: randomUUID() }, /host/],
    ["of another incarnation", { backendIncarnation: randomUUID() }, /incarnation/],
    ["of another build", { releaseBuild: "0123456789ab" }, /build/],
  ] as const)("refuses a report %s", (_name, overrides, cause) => {
    const result = mayOpen(report("restore", overrides), expected, "restore", NOW);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.cause).toMatch(cause);
  });

  it.each(["failed", "unknown"] as const)("refuses one %s check, naming it", (state) => {
    const r = report("restore");
    const id = r.checks[3]?.id ?? "";
    r.checks[3] = { id, state, observed: "synthetic" };
    const result = mayOpen(r, expected, "restore", NOW);
    expect(result).toEqual({ ok: false, cause: `check ${id} is ${state}` });
  });

  it("refuses a report with a required check missing, naming it", () => {
    const r = report("deploy");
    const missing = r.checks.pop();
    const result = mayOpen(r, expected, "deploy", NOW);
    expect(result).toEqual({ ok: false, cause: `check ${missing?.id ?? ""} is missing` });
  });

  it("refuses a deploy report for a restore (its checks are not the restore's)", () => {
    const result = mayOpen(report("deploy"), expected, "restore", NOW);
    expect(result.ok).toBe(false);
  });

  it("the record schema takes a v2 record and refuses a v1 one", () => {
    const v2 = {
      version: 2,
      state: "open",
      gateEpoch: 1,
      ...expected,
      origin: { kind: "restore", pairId: randomUUID() },
      reportSha256: "b".repeat(64),
      phase: "serving",
      writtenAt: new Date(NOW).toISOString(),
    };
    expect(gateRecordV2Schema.safeParse(v2).success).toBe(true);
    expect(gateRecordV2Schema.safeParse({ ...v2, version: 1 }).success).toBe(false);
  });

  it("the required checks are the plan's lists", () => {
    expect(REQUIRED_CHECKS.restore).toHaveLength(20);
    expect(REQUIRED_CHECKS.deploy).toEqual([
      "schema_revision",
      "openbao_readable",
      "incarnation_three_places",
      "control_row_idle",
      "journey_sign_in",
      "journey_reveal_digest",
      "journey_mutation_refused",
      "previous_gate_closed",
    ]);
  });
});
