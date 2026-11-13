// Run 2.3 Task C: the keyed verifier stored in place of a session token (P-26),
// and the key files it is made with.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAuthKeys,
  sessionVerifier,
  sessionVerifierCandidates,
  type KeyRing,
} from "@mykey/auth";

const ring = (current: string, ...ids: string[]): KeyRing => ({
  current,
  keys: Object.fromEntries(ids.map((id) => [id, randomBytes(32)])),
});

describe("sessionVerifier", () => {
  const token = randomBytes(24).toString("base64url");

  it("is v1.<keyId>.<43 base64url characters> and never contains the token", () => {
    const keys = ring("k2", "k1", "k2");
    const verifier = sessionVerifier(keys, token);
    expect(verifier).toMatch(/^v1\.k2\.[A-Za-z0-9_-]{43}$/);
    expect(verifier).not.toContain(token);
  });

  it("is the same for the same token and key, and differs per key id", () => {
    const keys = ring("k2", "k1", "k2");
    expect(sessionVerifier(keys, token)).toBe(sessionVerifier(keys, token));
    expect(sessionVerifier(keys, token, "k1")).not.toBe(sessionVerifier(keys, token, "k2"));
    expect(sessionVerifier(keys, `${token}x`)).not.toBe(sessionVerifier(keys, token));
  });

  it("lists one candidate per key id, the current key first", () => {
    const keys = ring("k2", "k1", "k2", "k3");
    const candidates = sessionVerifierCandidates(keys, token);
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toBe(sessionVerifier(keys, token, "k2"));
    expect(new Set(candidates)).toEqual(
      new Set(["k1", "k2", "k3"].map((id) => sessionVerifier(keys, token, id))),
    );
  });

  it("refuses a ring without its current key, an unknown key id and an empty token", () => {
    expect(() => sessionVerifier(ring("k9", "k1"), token)).toThrow(/current/);
    expect(() => sessionVerifier(ring("k1", "k1"), token, "k7")).toThrow(/k7/);
    expect(() => sessionVerifier(ring("k1", "k1"), "")).toThrow(/token/);
  });
});

describe("loadAuthKeys", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  const write = (directory: string, name: string): void => {
    writeFileSync(join(directory, name), randomBytes(32).toString("base64url"), { mode: 0o600 });
  };

  it("reads every ring, and the greatest key id of a ring is its current key", () => {
    const directory = mkdtempSync(join(tmpdir(), "mykey-auth-keys-"));
    directories.push(directory);
    for (const name of [
      "cookie.k1.key",
      "session-lookup.k1.key",
      "session-lookup.k2.key",
      "seed-encryption.k1.key",
      "recovery-verifier.k1.key",
      // The four rings added in Run 3.2.
      "rate-limit.k1.key",
      "reset-verifier.k1.key",
      "replay-fingerprint.k1.key",
      "cursor-mac.k1.key",
    ])
      write(directory, name);
    const keys = loadAuthKeys(directory);
    expect(keys.sessionLookup.current).toBe("k2");
    expect(Object.keys(keys.sessionLookup.keys).sort()).toEqual(["k1", "k2"]);
    expect(keys.seedEncryption.keys.k1).toHaveLength(32);
    expect(keys.cookieSecret.length).toBeGreaterThanOrEqual(32);
  });

  it("throws when a ring is empty or a key is not 32 bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "mykey-auth-keys-"));
    directories.push(directory);
    for (const name of ["cookie.k1.key", "session-lookup.k1.key", "seed-encryption.k1.key"])
      write(directory, name);
    expect(() => loadAuthKeys(directory)).toThrow(/recovery-verifier/);
    writeFileSync(join(directory, "recovery-verifier.k1.key"), "short", { mode: 0o600 });
    expect(() => loadAuthKeys(directory)).toThrow(/32 bytes/);
  });
});
