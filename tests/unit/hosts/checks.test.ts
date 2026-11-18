// Run 6.4 Task B (P-116, M-3): the host's checks. status.sh is a shell
// script on the host; this test keeps its numbers equal to the contracts and
// its sources the ones the plan names.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "@mykey/contracts";
import { describe, expect, it } from "vitest";

const checks = join(import.meta.dirname, "..", "..", "..", "infra", "hosts", "checks");
const status = readFileSync(join(checks, "status.sh"), "utf8");
const heartbeat = readFileSync(join(checks, "heartbeat.sh"), "utf8");

describe("status.sh's checks (P-116)", () => {
  it("counts credentials within LIMITS.machineToken.expiryWarningSeconds of expiry", () => {
    expect(status).toContain(
      `effective_expires_at <= now() + interval '${String(LIMITS.machineToken.expiryWarningSeconds)} seconds'`,
    );
  });

  it("counts unresolved operations with the query file the integration test runs (M-3)", () => {
    expect(status).toContain('<"$CHECKS_DIR/sql/operations-unresolved.sql"');
    expect(readFileSync(join(checks, "sql", "operations-unresolved.sql"), "utf8")).toContain(
      "interval '600 seconds'",
    );
  });

  // Run 6.9: staging reported "invalid" for its v2 record after the first deploy.
  it("reads a gate record of version 1 or 2 as its state", () => {
    expect(status).toContain(
      `jq -r 'if (.state == "open" or .state == "closed") and (.version == 1 or .version == 2) then .state else "invalid" end'`,
    );
  });

  it("reads the firewall from nft, and the drill flag only reports it unloaded", () => {
    expect(status).toContain("nft list table inet mykey");
    expect(status).toContain('[ -e "$HOOKS/firewall-unloaded" ] && firewall_check=false');
  });

  it("names every check of heartbeat version 2", () => {
    for (const key of [
      "sealed",
      "kmsReachable",
      "reviewOpen",
      "operationsUnresolved",
      "firewallLoaded",
      "diskLow",
      "auditFailing",
      "backup",
      "certificates",
      "credentialExpiring",
      "unitsFailed",
    ]) {
      expect(status).toContain(`${key}: $${key}`);
    }
    expect(status).toContain("{captureSince: $s}");
    expect(status).toContain('{"captureSince":null}');
  });

  it("heartbeat.sh sends version 2 with status.sh's checks", () => {
    expect(heartbeat).toContain("{v: 2, bootId: .bootId, observedAt: .time, checks: .checks}");
  });
});
