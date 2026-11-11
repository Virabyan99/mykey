// Run 2.3 Task D: the TOTP seed is stored only as a JWE bound to its user and enrollment.
import { randomBytes, randomUUID } from "node:crypto";
import { decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import { decryptSeed, encryptSeed, type KeyRing } from "@mykey/auth";

const ring = (...ids: string[]): KeyRing => ({
  current: [...ids].sort().at(-1) ?? "k1",
  keys: Object.fromEntries(ids.map((id) => [id, new Uint8Array(randomBytes(32))])),
});

describe("seed encryption", () => {
  const seed = new Uint8Array(randomBytes(20));
  const bind = { userId: randomUUID(), enrollmentId: randomUUID() };

  it("is a compact JWE, dir with A256GCM, whose header names key, purpose, user and enrollment", async () => {
    const keys = ring("k1");
    const jwe = await encryptSeed(keys, seed, bind);
    expect(jwe.split(".")).toHaveLength(5);
    // `dir`: no encrypted key part.
    expect(jwe.split(".")[1]).toBe("");
    expect(decodeProtectedHeader(jwe)).toEqual({
      alg: "dir",
      enc: "A256GCM",
      kid: "k1",
      purpose: "totp-seed",
      sub: bind.userId,
      enr: bind.enrollmentId,
    });
    expect(Buffer.from(await decryptSeed(keys, jwe, bind))).toEqual(Buffer.from(seed));
  });

  it("refuses another user, another enrollment and a removed key", async () => {
    const keys = ring("k1");
    const jwe = await encryptSeed(keys, seed, bind);
    await expect(decryptSeed(keys, jwe, { ...bind, userId: randomUUID() })).rejects.toThrow();
    await expect(decryptSeed(keys, jwe, { ...bind, enrollmentId: randomUUID() })).rejects.toThrow();
    const rotated = ring("k2");
    await expect(decryptSeed(rotated, jwe, bind)).rejects.toThrow(/k1/);
    // Control: a ring that still holds k1 next to a newer key decrypts.
    const both: KeyRing = { current: "k2", keys: { ...keys.keys, ...rotated.keys } };
    expect(Buffer.from(await decryptSeed(both, jwe, bind))).toEqual(Buffer.from(seed));
  });

  it("refuses a seed that is not 20 bytes", async () => {
    await expect(encryptSeed(ring("k1"), new Uint8Array(10), bind)).rejects.toThrow(/20 bytes/);
  });
});
