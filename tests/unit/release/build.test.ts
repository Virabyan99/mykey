// Run 5.7 Task B (P-98, D-44): the CLI release is the same bytes on every
// build of one commit, holds exactly three entries, carries a bundle that
// imports only `node:` modules, and an installer that carries the pinned sums.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRelease } from "../../../infra/release/cli/build-release.ts";

const lock = JSON.parse(readFileSync("infra/dependencies.lock.json", "utf8")) as {
  node: { version: string };
  binaries: Record<string, { version: string; asset: string; sha256: string }>;
};
const version = (JSON.parse(readFileSync("apps/cli/package.json", "utf8")) as { version: string })
  .version;
const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The entries of an uncompressed ustar archive: name, mode, size, data. */
function entriesOf(
  tar: Buffer,
): { name: string; mode: number; uid: number; mtime: number; data: Buffer }[] {
  const found = [];
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number): string =>
      header
        .subarray(start, start + length)
        .toString("latin1")
        .replace(/\0.*$/s, "")
        .trim();
    const size = parseInt(field(124, 12), 8);
    found.push({
      name: field(0, 100),
      mode: parseInt(field(100, 8), 8),
      uid: parseInt(field(108, 8), 8),
      mtime: parseInt(field(136, 12), 8),
      data: tar.subarray(at + 512, at + 512 + size),
    });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}

let first: string;
let second: string;

beforeAll(() => {
  first = mkdtempSync(join(tmpdir(), "mykey-release-a-"));
  second = mkdtempSync(join(tmpdir(), "mykey-release-b-"));
  buildRelease({ version, out: first });
  buildRelease({ version, out: second });
}, 120_000);

afterAll(() => {
  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
});

describe("the CLI release", () => {
  it("two builds of one commit give the same SHA256SUMS, over the archive and the installer", () => {
    const sums = readFileSync(join(first, "SHA256SUMS"), "utf8");
    expect(readFileSync(join(second, "SHA256SUMS"), "utf8")).toBe(sums);
    const archive = `mykey-cli-${version}.tgz`;
    expect(sums).toBe(
      [
        `${sha(readFileSync(join(first, archive)))}  ${archive}`,
        `${sha(readFileSync(join(first, "install.sh")))}  install.sh`,
        "",
      ].join("\n"),
    );
  });

  it("the archive holds exactly secrets.mjs, package.json and LICENSE, owned by 0, mtime 0", () => {
    const tgz = readFileSync(join(first, `mykey-cli-${version}.tgz`));
    expect(tgz[9]).toBe(3);
    const entries = entriesOf(gunzipSync(tgz));
    expect(entries.map((entry) => entry.name)).toEqual(["LICENSE", "package.json", "secrets.mjs"]);
    expect(entries.map((entry) => entry.mode)).toEqual([0o644, 0o644, 0o755]);
    expect(entries.every((entry) => entry.uid === 0 && entry.mtime === 0)).toBe(true);
    const manifest = JSON.parse(entries[1]?.data.toString("utf8") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      version,
      type: "module",
      bin: { secrets: "secrets.mjs" },
      engines: { node: lock.node.version },
    });
    const bundle = entries[2]?.data.toString("utf8") ?? "";
    const specifiers = [
      ...bundle.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm),
      ...bundle.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ...bundle.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1] ?? "");
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
  });

  it("install.sh carries the four Node sums of the lock file and the archive's own sum", () => {
    const script = readFileSync(join(first, "install.sh"), "utf8");
    for (const target of TARGETS) {
      const pin = lock.binaries[`node-${target}`];
      expect(pin?.version, target).toBe(lock.node.version);
      expect(script, target).toContain(pin?.sha256 ?? "missing");
    }
    expect(script).toContain(sha(readFileSync(join(first, `mykey-cli-${version}.tgz`))));
    expect(script).toContain(`VERSION='${version}'`);
    expect(script).not.toMatch(/@[A-Z0-9_]+@/);
  });

  it("install.sh has no sudo, no curl without --proto '=https', and parses with sh -n", () => {
    const script = readFileSync(join(first, "install.sh"), "utf8");
    const code = script
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/\bsudo\b/);
    for (const line of code.split("\n").filter((text) => /\bcurl\b/.test(text))) {
      expect(line).toContain("--proto '=https'");
    }
    const parsed = spawnSync("sh", ["-n", join(first, "install.sh")], { encoding: "utf8" });
    expect(parsed.status, parsed.stderr).toBe(0);
  });
});
