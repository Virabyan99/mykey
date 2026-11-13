// Run 3.1 Task D (P-43): the gate record. Open only for the exact valid record
// naming this host; every other case is closed, with its cause. Real files in
// a temporary directory outside the repository.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readGate } from "@mykey/api";

const directory = mkdtempSync(join(tmpdir(), "mykey-gate-unit-"));
const host = randomUUID();
let counter = 0;

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    state: "open",
    gateEpoch: 7,
    hostInstanceId: host,
    writtenAt: "2026-11-12T10:00:00.000Z",
    ...overrides,
  };
}

function file(content: string | Buffer): string {
  counter += 1;
  const path = join(directory, `gate-${String(counter)}.json`);
  writeFileSync(path, content);
  return path;
}

describe("readGate", () => {
  it("is open for the exact valid record of this host", () => {
    expect(readGate(file(JSON.stringify(record())), host)).toEqual({ open: true, gateEpoch: 7 });
  });

  it.each([
    ["state closed", JSON.stringify(record({ state: "closed" })), "closed"],
    ["another host", JSON.stringify(record({ hostInstanceId: randomUUID() })), "host"],
    ["version 2", JSON.stringify(record({ version: 2 })), "version"],
    ["an extra field", JSON.stringify(record({ release: "x" })), "invalid"],
    [
      "a missing field",
      JSON.stringify({ version: 1, state: "open", hostInstanceId: host }),
      "invalid",
    ],
    ["another state", JSON.stringify(record({ state: "half-open" })), "invalid"],
    ["an empty file", "", "invalid"],
    ["invalid JSON", "{", "invalid"],
    ["a JSON array", "[]", "invalid"],
    [
      "4,097 bytes",
      `${JSON.stringify(record())}${" ".repeat(4097 - JSON.stringify(record()).length)}`,
      "invalid",
    ],
  ])("is closed for %s, cause %s", (_name, content, cause) => {
    expect(readGate(file(content), host)).toEqual({ open: false, cause });
  });

  it("accepts exactly 4,096 bytes (control of the size limit)", () => {
    const text = JSON.stringify(record());
    expect(readGate(file(`${text}${" ".repeat(4096 - text.length)}`), host)).toEqual({
      open: true,
      gateEpoch: 7,
    });
  });

  it("is closed when there is no file", () => {
    expect(readGate(join(directory, "absent.json"), host)).toEqual({
      open: false,
      cause: "missing",
    });
  });

  it("is closed for a directory", () => {
    const path = join(directory, "a-directory");
    mkdirSync(path);
    expect(readGate(path, host)).toEqual({ open: false, cause: "invalid" });
  });

  it("is closed for a symbolic link to a valid record", () => {
    const target = file(JSON.stringify(record()));
    const link = join(directory, "link.json");
    symlinkSync(target, link);
    expect(readGate(target, host).open).toBe(true);
    expect(readGate(link, host)).toEqual({ open: false, cause: "invalid" });
  });

  it("is closed when the file cannot be read", () => {
    const path = file(JSON.stringify(record()));
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(
      readGate(path, host, {
        openSync: () => {
          throw denied;
        },
      }),
    ).toEqual({ open: false, cause: "unreadable" });
  });
});
