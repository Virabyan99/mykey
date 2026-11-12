// Run 3.2 Task A: eight key rings, key ids by number (M15), and the generator
// that creates the files of rings that have none.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEY_RINGS, generateKeyFiles, loadAuthKeys } from "@mykey/auth";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fresh(): string {
  const directory = mkdtempSync(join(tmpdir(), "mykey-keys-"));
  directories.push(directory);
  return directory;
}

const write = (directory: string, name: string): void => {
  writeFileSync(join(directory, name), randomBytes(32).toString("base64url"), { mode: 0o600 });
};

describe("key rings", () => {
  it("has the eight rings of Session 3", () => {
    expect(KEY_RINGS).toEqual([
      "cookie",
      "session-lookup",
      "seed-encryption",
      "recovery-verifier",
      "rate-limit",
      "reset-verifier",
      "replay-fingerprint",
      "cursor-mac",
    ]);
  });

  it("k10 is current over k9", () => {
    const directory = fresh();
    generateKeyFiles(directory);
    write(directory, "rate-limit.k9.key");
    write(directory, "rate-limit.k10.key");
    const keys = loadAuthKeys(directory);
    expect(keys.rateLimit.current).toBe("k10");
    expect(Object.keys(keys.rateLimit.keys).sort()).toEqual(["k1", "k10", "k9"]);
  });

  it.each([
    ["rate-limit.k01.key"],
    ["rate-limit.K2.key"],
    ["rate-limit.key2.key"],
    ["rate-limit.k0.key"],
  ])("refuses the file name %s, naming it", (name) => {
    const directory = fresh();
    generateKeyFiles(directory);
    write(directory, name);
    expect(() => loadAuthKeys(directory)).toThrow(name);
  });

  it("a missing ring is named", () => {
    const directory = fresh();
    generateKeyFiles(directory);
    rmSync(join(directory, "cursor-mac.k1.key"));
    expect(() => loadAuthKeys(directory)).toThrow(/cursor-mac/);
  });

  it("exposes every ring", () => {
    const directory = fresh();
    generateKeyFiles(directory);
    const keys = loadAuthKeys(directory);
    for (const ring of [
      keys.sessionLookup,
      keys.seedEncryption,
      keys.recoveryVerifier,
      keys.rateLimit,
      keys.resetVerifier,
      keys.replayFingerprint,
      keys.cursorMac,
    ]) {
      expect(ring.current).toBe("k1");
      expect(ring.keys.k1).toHaveLength(32);
    }
    expect(keys.cookieSecret.length).toBeGreaterThanOrEqual(43);
  });
});

describe("generateKeyFiles", () => {
  it("creates a k1 file for every ring that has none, 32 random bytes, and returns the names", () => {
    const directory = fresh();
    const created = generateKeyFiles(directory);
    expect(created.sort()).toEqual(KEY_RINGS.map((ring) => `${ring}.k1.key`).sort());
    for (const name of created) {
      const bytes = Buffer.from(readFileSync(join(directory, name), "utf8").trim(), "base64url");
      expect(bytes, name).toHaveLength(32);
      if (process.platform !== "win32") {
        expect(statSync(join(directory, name)).mode & 0o777, name).toBe(0o600);
      }
    }
    // Every value differs.
    const values = created.map((name) => readFileSync(join(directory, name), "utf8"));
    expect(new Set(values).size).toBe(values.length);
  });

  it("leaves existing rings untouched and creates only the missing ones", () => {
    const directory = fresh();
    write(directory, "cookie.k3.key");
    const before = readFileSync(join(directory, "cookie.k3.key"), "utf8");
    const created = generateKeyFiles(directory);
    expect(created).not.toContain("cookie.k1.key");
    expect(created).toHaveLength(KEY_RINGS.length - 1);
    expect(readFileSync(join(directory, "cookie.k3.key"), "utf8")).toBe(before);
    expect(generateKeyFiles(directory)).toEqual([]);
    expect(readdirSync(directory)).toHaveLength(KEY_RINGS.length);
  });

  it("returns names only, never a value", () => {
    const directory = fresh();
    const created = generateKeyFiles(directory);
    for (const name of created) expect(name).toMatch(/^[a-z-]+\.k[0-9]+\.key$/);
  });
});
