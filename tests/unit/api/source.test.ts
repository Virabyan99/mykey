// Run 3.3 Task A (P-47): the request source. Only the configured edge's
// X-Forwarded-For is believed, and only when it holds exactly one address.
import { describe, expect, it } from "vitest";
import { requestSource } from "@mykey/api";

const EDGE = "10.78.1.2";

describe("requestSource", () => {
  it.each([
    ["203.0.113.9", "203.0.113.9"],
    ["2001:db8::1", "2001:db8::1"],
    [" 203.0.113.9 ", "203.0.113.9"],
  ])("believes the edge's single address %j", (forwarded, expected) => {
    expect(requestSource(EDGE, forwarded, EDGE)).toBe(expected);
  });

  it("treats an IPv4-mapped IPv6 peer as its IPv4 form", () => {
    expect(requestSource(`::ffff:${EDGE}`, "203.0.113.9", EDGE)).toBe("203.0.113.9");
    expect(requestSource("::ffff:198.51.100.7", undefined, EDGE)).toBe("198.51.100.7");
  });

  it.each([
    ["two values", "203.0.113.9, 198.51.100.1"],
    ["an empty value", ""],
    ["unknown", "unknown"],
    ["a value with a port", "203.0.113.9:4711"],
    ["a bracketed address with a port", "[2001:db8::1]:443"],
    ["300 characters", "1".repeat(300)],
    ["a host name", "client.example.test"],
  ])("falls back to the peer for %s", (_name, forwarded) => {
    expect(requestSource(EDGE, forwarded, EDGE)).toBe(EDGE);
  });

  it("ignores the header when the peer is not the edge", () => {
    expect(requestSource("198.51.100.7", "203.0.113.9", EDGE)).toBe("198.51.100.7");
  });

  it("ignores the header when no edge is configured", () => {
    expect(requestSource("198.51.100.7", "203.0.113.9", null)).toBe("198.51.100.7");
  });

  it("answers 'unknown' without a peer", () => {
    expect(requestSource(undefined, undefined, null)).toBe("unknown");
  });
});
