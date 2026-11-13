// Run 3.3 Task A (P-48): the key of a rate-limit row is
// HMAC-SHA-256(rate key, scope ‖ 0x00 ‖ subject) — no row holds an address,
// an e-mail or a user id. The fixed vectors were computed outside this code
// (Python's hmac module) and pin the construction.
import { describe, expect, it } from "vitest";
import { throttleDigest } from "@mykey/auth";

const key = new Uint8Array(32).fill(1);

describe("throttleDigest", () => {
  it("equals fixed vectors for a fixed key", () => {
    expect(throttleDigest(key, "src:password", "203.0.113.9").toString("hex")).toBe(
      "48c2d30cfcf5db7e807559419e1fcc5226a5c2c97c9cde2386db16ef5009db22",
    );
    expect(throttleDigest(key, "fail:password", "owner@mykey.invalid").toString("hex")).toBe(
      "04a429392391f3cfc70c8093c44507e5c71b214ab2370d28948e49d23bc44ba3",
    );
  });

  it("is 32 bytes and differs by scope and by subject", () => {
    const a = throttleDigest(key, "src:password", "x");
    expect(a).toHaveLength(32);
    expect(throttleDigest(key, "src:factor", "x").equals(a)).toBe(false);
    expect(throttleDigest(key, "src:password", "y").equals(a)).toBe(false);
  });

  it("separates scope and subject, so moving the boundary changes the key", () => {
    expect(
      throttleDigest(key, "src:passwordx", "y").equals(throttleDigest(key, "src:password", "xy")),
    ).toBe(false);
  });
});
