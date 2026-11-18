// Run 6.8: what the drill's first report found. A check's `observed` is at
// most 2000 characters (the report schema), and a long one (sixteen
// organizations that differ) made the report impossible to write. A journey
// that throws says what was thrown, not only the class.
import { describe, expect, it } from "vitest";
import { clipObserved, verifyJourney } from "@mykey/ops";

describe("the restore report's observed text", () => {
  it("keeps a short text and clips a long one under 2000 characters, saying how much was cut", () => {
    expect(clipObserved("3 missing")).toBe("3 missing");
    const long = "organization x: policy:provisioner; ".repeat(200);
    const clipped = clipObserved(long);
    expect(clipped.length).toBeLessThanOrEqual(2000);
    expect(clipped.startsWith("organization x: policy:provisioner;")).toBe(true);
    expect(clipped).toMatch(/\(\+\d+ characters\)$/);
  });

  it("a journey that throws answers unknown with the error's message", async () => {
    const result = await verifyJourney({
      request: () => Promise.reject(new TypeError("fetch failed: socket hang up")),
      cookieOf: () => null,
      owner: { email: "o@example.invalid", resetToken: "t", newPassword: "p" },
      totp: () => Promise.resolve({ code: "000000" }),
      reveal: { path: "/x", sha256: "0" },
      mutation: { method: "POST", path: "/y", body: {} },
    });
    expect(result.checks.journey_owner_enrolled?.state).toBe("unknown");
    expect(result.checks.journey_owner_enrolled?.observed).toBe(
      "TypeError: fetch failed: socket hang up",
    );
  });
});
