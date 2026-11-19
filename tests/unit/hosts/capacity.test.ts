// Run 6.3 Task C (P-115): the host's capacity record uses the thresholds of
// LIMITS.disk. status.sh holds them as shell variables; this test keeps them
// equal, and names the volumes it measures.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "@mykey/contracts";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "infra", "hosts", "checks", "status.sh"),
  "utf8",
);
const variable = (name: string): number =>
  Number(new RegExp(`^${name}=([0-9]+)$`, "m").exec(script)?.[1]);

describe("status.sh's capacity record (P-115)", () => {
  it("uses the thresholds of LIMITS.disk", () => {
    expect(variable("DISK_MIN_FREE_PERCENT")).toBe(LIMITS.disk.minFreeBytesPercent);
    expect(variable("DISK_MIN_FREE_BYTES")).toBe(
      LIMITS.disk.minFreeBytes + LIMITS.disk.auditReserveBytes,
    );
    expect(variable("DISK_MIN_INODES_PERCENT")).toBe(LIMITS.disk.minFreeInodesPercent);
  });

  it("measures the PostgreSQL data, OpenBao data and audit, the Docker root and the rotated audit files", () => {
    const names = [...script.matchAll(/^measure ([a-z-]+) /gm)].map((match) => match[1]).sort();
    expect(names).toEqual(["bao-audit", "bao-rotated", "docker", "openbao", "postgres"]);
  });

  it("writes the record atomically into the gate directory, world-readable", () => {
    expect(script).toContain("mktemp /etc/mykey/gate/.capacity.");
    expect(script).toContain(
      'chmod 0644 "$capacity_tmp" && mv -f "$capacity_tmp" /etc/mykey/gate/capacity.json',
    );
  });
});
