// Run 6.4 Task A (P-116): every alert's text has one shape, names no address,
// path, token or certificate, and the test alert has its own fixed text.
import { describe, expect, it } from "vitest";
import { CONDITIONS } from "@mykey/probe/evaluate";
import { formatAlert, formatTestAlert } from "@mykey/probe/sinks";

const SHAPE = /^MyKey [a-z]+: [a-z_]+ (opened|reminder|resolved) \(since [0-9TZ:-]+ UTC\)$/;

describe("formatAlert", () => {
  it("has one shape for every condition and kind", () => {
    expect(CONDITIONS).toHaveLength(15);
    for (const condition of CONDITIONS) {
      for (const kind of ["opened", "reminder", "resolved"] as const) {
        const text = formatAlert({ host: "staging", condition, kind, sinceMs: 1_800_000_000_123 });
        expect(text, `${condition} ${kind}`).toMatch(SHAPE);
      }
    }
  });

  it("certificate_expiring names no certificate", () => {
    const text = formatAlert({
      host: "prod",
      condition: "certificate_expiring",
      kind: "opened",
      sinceMs: 1_800_000_000_000,
    });
    expect(text).toBe("MyKey prod: certificate_expiring opened (since 2027-01-15T08:00:00Z UTC)");
  });

  it("the on-demand test alert", () => {
    expect(formatTestAlert("staging")).toBe("MyKey staging: test_alert");
  });
});
