// Run 3.8 (P-57): the provisioner is unhealthy when its last sweep tick is
// older than three intervals, or when it never swept.
import { describe, expect, it } from "vitest";
import { isHealthy } from "@mykey/provisioner";

const NOW = Date.parse("2026-11-13T12:00:00Z");

describe("provisioner health", () => {
  it("healthy within three intervals, unhealthy after", () => {
    expect(isHealthy(new Date(NOW - 899_000).toISOString(), 300, NOW)).toBe(true);
    expect(isHealthy(new Date(NOW - 900_000).toISOString(), 300, NOW)).toBe(true);
    expect(isHealthy(new Date(NOW - 901_000).toISOString(), 300, NOW)).toBe(false);
  });

  it("no sweep yet, or an unreadable time, is unhealthy", () => {
    expect(isHealthy(null, 300, NOW)).toBe(false);
    expect(isHealthy("not a time", 300, NOW)).toBe(false);
  });
});
