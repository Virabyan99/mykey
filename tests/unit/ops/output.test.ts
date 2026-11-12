// Run 3.2 Task A (Review focus 3): an operator command's secret output goes to
// a 0600 file under a 0700 directory, and only its path is printed.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSecretFile } from "@mykey/ops";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("writeSecretFile", () => {
  it("creates the file 0600 under a 0700 directory and returns its path", () => {
    const home = mkdtempSync(join(tmpdir(), "mykey-ops-home-"));
    directories.push(home);
    const path = writeSecretFile("reset-link", "https://example.test/reset#t=x", { home });
    expect(path.startsWith(join(home, ".mykey", "out"))).toBe(true);
    expect(path).toMatch(/[0-9]{8}T[0-9]{6}Z-reset-link$/);
    expect(readFileSync(path, "utf8")).toBe("https://example.test/reset#t=x");
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    }
  });

  it("never overwrites an earlier file", () => {
    const home = mkdtempSync(join(tmpdir(), "mykey-ops-home-"));
    directories.push(home);
    const first = writeSecretFile("x", "1", { home });
    const second = writeSecretFile("x", "2", { home });
    expect(second).not.toBe(first);
    expect(readFileSync(first, "utf8")).toBe("1");
  });

  it("refuses a name that is not a plain word", () => {
    const home = mkdtempSync(join(tmpdir(), "mykey-ops-home-"));
    directories.push(home);
    expect(() => writeSecretFile("../escape", "x", { home })).toThrow();
  });
});
