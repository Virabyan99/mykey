import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPair,
  ensureResticPassword,
  resticInBundle,
  type BuiltPair,
} from "../../../infra/backup/retention-fixture/build-pair.ts";

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("retention fixture pair", () => {
  let work: string;
  let passwordFile: string;
  let pair: BuiltPair;
  const captureTime = new Date("2026-11-10T09:30:00.000Z");

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "mykey-pair-"));
    // A synthetic password made for this test only.
    passwordFile = ensureResticPassword(join(work, "secrets", "restic-password"));
    pair = buildPair({
      pairId: "p-test-1",
      captureTime,
      outDir: join(work, "out"),
      passwordFile,
    });
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("writes one bundle and one manifest, and nothing else", () => {
    expect(readdirSync(pair.directory).sort()).toEqual(["bundle.tar", "manifest.json"]);
    expect(pair.directory).toBe(join(work, "out", "p-test-1"));
  });

  it("describes the bundle truthfully in the manifest", () => {
    const manifest = JSON.parse(readFileSync(pair.manifestPath, "utf8")) as unknown;
    expect(manifest).toEqual(pair.manifest);
    expect(pair.manifest).toEqual({
      pairId: "p-test-1",
      captureTime: "2026-11-10T09:30:00.000Z",
      bundleSha256: sha256(pair.bundlePath),
      bundleBytes: statSync(pair.bundlePath).size,
      resticVersion: "0.19.1",
      synthetic: true,
    });
    // Two files of 1 MiB random bytes cannot compress below 2 MiB.
    expect(pair.manifest.bundleBytes).toBeGreaterThan(2 * 1024 * 1024);
  });

  it("holds three synthetic files of the stated sizes", () => {
    expect(pair.files.map((file) => [file.name, file.bytes])).toEqual([
      ["globals.sql", pair.files[0]!.bytes],
      ["pg.dump", 1024 * 1024],
      ["raft.snap", 1024 * 1024],
    ]);
    expect(pair.files[0]!.bytes).toBeLessThan(1024);
  });

  it("restores from the bundle alone to the same bytes", () => {
    const target = join(work, "restore");
    mkdirSync(target);
    resticInBundle(pair.bundlePath, passwordFile, ["restore", "latest", "--target", "/out"], {
      out: target,
    });
    for (const file of pair.files) {
      expect(sha256(join(target, "source", file.name)), file.name).toBe(file.sha256);
    }
  });

  it("stamps the snapshot with the capture time, not the build time", () => {
    const output = resticInBundle(pair.bundlePath, passwordFile, ["snapshots", "--json"]);
    const snapshots = JSON.parse(output) as { time: string; hostname: string }[];
    expect(snapshots).toHaveLength(1);
    expect(new Date(snapshots[0]!.time).toISOString()).toBe("2026-11-10T09:30:00.000Z");
    expect(snapshots[0]!.hostname).toBe("mykey-fixture");
  });

  it("cannot be read with another password", () => {
    const other = join(work, "other-password");
    writeFileSync(other, randomBytes(32).toString("base64url"));
    expect(() => resticInBundle(pair.bundlePath, other, ["snapshots", "--json"])).toThrow(
      /restic snapshots failed/,
    );
  });

  it("refuses a pair id that is not a plain name, and an existing pair", () => {
    const options = { captureTime, outDir: join(work, "out"), passwordFile };
    expect(() => buildPair({ ...options, pairId: "../escape" })).toThrow(/pair id/);
    expect(() => buildPair({ ...options, pairId: "p-test-1" })).toThrow(/already exists/);
  });
});

describe("ensureResticPassword", () => {
  it("generates the password once and never replaces it", () => {
    const home = mkdtempSync(join(tmpdir(), "mykey-restic-pw-"));
    try {
      const file = join(home, "retention-fixture", "restic-password");
      expect(ensureResticPassword(file)).toBe(file);
      const first = readFileSync(file, "utf8");
      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(ensureResticPassword(file)).toBe(file);
      expect(readFileSync(file, "utf8")).toBe(first);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
