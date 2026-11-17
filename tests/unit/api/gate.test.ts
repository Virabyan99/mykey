// Run 3.1 Task D (P-43), version 2 since Run 6.7 (P-122, D-54): the gate
// record. `all` only for the exact valid open, serving record of this host,
// incarnation and build; `verification` for closed + verifying with the same
// three; everything else `none`, with its cause. Real files in a temporary
// directory outside the repository.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readGate } from "@mykey/api";

const directory = mkdtempSync(join(tmpdir(), "mykey-gate-unit-"));
const expect3 = {
  hostInstanceId: randomUUID(),
  backendIncarnation: randomUUID(),
  releaseBuild: "abcdef123456",
};
let counter = 0;

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    state: "open",
    gateEpoch: 7,
    hostInstanceId: expect3.hostInstanceId,
    backendIncarnation: expect3.backendIncarnation,
    origin: { kind: "fresh_install", id: randomUUID() },
    releaseBuild: expect3.releaseBuild,
    reportSha256: "a".repeat(64),
    phase: "serving",
    writtenAt: "2026-11-17T10:00:00.000Z",
    ...overrides,
  };
}

function file(content: string | Buffer): string {
  counter += 1;
  const path = join(directory, `gate-${String(counter)}.json`);
  writeFileSync(path, content);
  return path;
}

const reading = (path: string) => {
  const { admits, cause } = readGate(path, expect3);
  return { admits, cause };
};

describe("readGate (v2)", () => {
  it("admits all for the exact open, serving record of this host, incarnation and build", () => {
    const result = readGate(file(JSON.stringify(record())), expect3);
    expect(result.admits).toBe("all");
    expect(result.cause).toBeNull();
    expect(result.record?.gateEpoch).toBe(7);
  });

  it("admits verification for closed + verifying with the same three", () => {
    expect(
      reading(
        file(JSON.stringify(record({ state: "closed", phase: "verifying", reportSha256: null }))),
      ),
    ).toEqual({ admits: "verification", cause: "closed" });
  });

  it.each([
    ["state closed, serving", record({ state: "closed" }), "closed"],
    ["open but verifying", record({ phase: "verifying" }), "closed"],
    ["another host", record({ hostInstanceId: randomUUID() }), "host"],
    ["another incarnation", record({ backendIncarnation: randomUUID() }), "incarnation"],
    ["another build", record({ releaseBuild: "0123456789ab" }), "build"],
    [
      "another incarnation, closed + verifying",
      record({ state: "closed", phase: "verifying", backendIncarnation: randomUUID() }),
      "incarnation",
    ],
    [
      "a v1 record",
      {
        version: 1,
        state: "open",
        gateEpoch: 7,
        hostInstanceId: expect3.hostInstanceId,
        writtenAt: "2026-11-12T10:00:00.000Z",
      },
      "version",
    ],
    ["version 3", record({ version: 3 }), "version"],
    ["an extra field", record({ release: "x" }), "invalid"],
    [
      "a missing field",
      { version: 2, state: "open", hostInstanceId: expect3.hostInstanceId },
      "invalid",
    ],
    ["another state", record({ state: "half-open" }), "invalid"],
    ["another origin", record({ origin: { kind: "copy" } }), "invalid"],
    ["a bad report hash", record({ reportSha256: "x" }), "invalid"],
  ])("admits none for %s, cause %s", (_name, value, cause) => {
    expect(reading(file(JSON.stringify(value)))).toEqual({ admits: "none", cause });
  });

  it.each([
    ["an empty file", ""],
    ["invalid JSON", "{"],
    ["a JSON array", "[]"],
    [
      "4,097 bytes",
      `${JSON.stringify(record())}${" ".repeat(4097 - JSON.stringify(record()).length)}`,
    ],
  ])("admits none for %s, cause invalid", (_name, content) => {
    expect(reading(file(content))).toEqual({ admits: "none", cause: "invalid" });
  });

  it("accepts exactly 4,096 bytes (control of the size limit)", () => {
    const text = JSON.stringify(record());
    expect(reading(file(`${text}${" ".repeat(4096 - text.length)}`)).admits).toBe("all");
  });

  it("admits none when there is no file", () => {
    expect(reading(join(directory, "absent.json"))).toEqual({ admits: "none", cause: "missing" });
  });

  it("admits none for a directory", () => {
    const path = join(directory, "a-directory");
    mkdirSync(path);
    expect(reading(path)).toEqual({ admits: "none", cause: "invalid" });
  });

  it("admits none for a symbolic link to a valid record", () => {
    const target = file(JSON.stringify(record()));
    const link = join(directory, "link.json");
    symlinkSync(target, link);
    expect(reading(target).admits).toBe("all");
    expect(reading(link)).toEqual({ admits: "none", cause: "invalid" });
  });

  it("admits none when the file cannot be read", () => {
    const path = file(JSON.stringify(record()));
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const result = readGate(path, expect3, {
      openSync: () => {
        throw denied;
      },
    });
    expect([result.admits, result.cause]).toEqual(["none", "unreadable"]);
  });
});
