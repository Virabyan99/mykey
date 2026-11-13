// Run 3.9 Task A (P-58, Doc 06 §6.2): the intent fingerprint of a mutation —
// HMAC-SHA-256 under the replay-fingerprint ring over the canonical JSON of
// who asked what on which target with which body (sorted keys, NFC strings).
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { intentFingerprint } from "@mykey/operations";

const ring = {
  current: "k2",
  keys: { k1: new Uint8Array(32).fill(1), k2: new Uint8Array(32).fill(2) },
};
const intent = {
  principalKind: "user",
  principalId: "11111111-1111-4111-8111-111111111111",
  action: "projects.create",
  target: "22222222-2222-4222-8222-222222222222",
  body: { name: "Payments" },
};

describe("intentFingerprint", () => {
  it("is 32 bytes and carries the current key id", () => {
    const { digest, keyId } = intentFingerprint(ring, intent);
    expect(digest).toHaveLength(32);
    expect(keyId).toBe("k2");
  });

  it("a fixed vector: the canonical text, written out by hand", () => {
    const text =
      '{"action":"projects.create","body":{"name":"Payments"},"principalId":"11111111-1111-4111-8111-111111111111","principalKind":"user","target":"22222222-2222-4222-8222-222222222222"}';
    const expected = createHmac("sha256", Buffer.from(ring.keys.k2)).update(text).digest();
    expect(intentFingerprint(ring, intent).digest.equals(expected)).toBe(true);
  });

  it("is equal for bodies that differ only in key order, and for the NFC form of a string", () => {
    const a = intentFingerprint(ring, { ...intent, body: { a: 1, b: { x: "é", y: 2 } } });
    const b = intentFingerprint(ring, { ...intent, body: { b: { y: 2, x: "é" }, a: 1 } });
    expect(a.digest.equals(b.digest)).toBe(true);
  });

  it("differs for another name, principal, action or target", () => {
    const base = intentFingerprint(ring, intent).digest;
    for (const changed of [
      { ...intent, body: { name: "payments" } },
      { ...intent, principalId: "33333333-3333-4333-8333-333333333333" },
      { ...intent, principalKind: "machine" },
      { ...intent, action: "projects.rename" },
      { ...intent, target: "44444444-4444-4444-8444-444444444444" },
    ]) {
      expect(intentFingerprint(ring, changed).digest.equals(base)).toBe(false);
    }
  });

  it("under a named older key it is that key's digest", () => {
    const old = intentFingerprint(ring, intent, "k1");
    expect(old.keyId).toBe("k1");
    expect(old.digest.equals(intentFingerprint(ring, intent).digest)).toBe(false);
  });
});
