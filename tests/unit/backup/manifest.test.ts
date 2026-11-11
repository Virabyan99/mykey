// Run 2.9: the manifest of a paired backup and the check of its artifacts.
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_NAMES,
  buildManifest,
  verifyArtifacts,
  type PairManifest,
} from "../../../infra/backup/pair-spike/manifest.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function pairDirectory(): { directory: string; manifest: PairManifest } {
  const directory = mkdtempSync(join(tmpdir(), "mykey-pair-"));
  directories.push(directory);
  const artifacts = {} as PairManifest["artifacts"];
  for (const name of ARTIFACT_NAMES) {
    const bytes = Buffer.from(`synthetic ${name} ${randomUUID()}`);
    writeFileSync(join(directory, name), bytes);
    artifacts[name] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  }
  const manifest = buildManifest({
    pairId: randomUUID(),
    captureStartedAt: "2026-11-12T10:00:00.000Z",
    captureFinishedAt: "2026-11-12T10:00:20.000Z",
    captureEpoch: "3",
    releaseCommit: "a".repeat(40),
    schemaRevision: `0003_auth_base ${"b".repeat(64)}`,
    versions: { postgres: "18.6", openbao: "2.7.2", restic: "0.19.1" },
    seal: { type: "kmip", keyIds: ["synthetic-key-id"] },
    namespaces: ["org-00000000-0000-4000-8000-000000000001"],
    boundary: { lastOperationId: null, executingOperations: 0, heldEffectSlots: 0 },
    artifacts,
    rolesChecksum: "c".repeat(64),
  });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, manifest };
}

describe("buildManifest", () => {
  it("marks the pair synthetic and names its format", () => {
    const { manifest } = pairDirectory();
    expect(manifest.format).toBe("mykey-pair-spike/1");
    expect(manifest.synthetic).toBe(true);
  });

  it("refuses a boundary with executing operations or held slots, and malformed hashes", () => {
    const { manifest } = pairDirectory();
    const input = Object.fromEntries(
      Object.entries(manifest).filter(([key]) => key !== "format" && key !== "synthetic"),
    ) as Omit<PairManifest, "format" | "synthetic">;
    expect(() =>
      buildManifest({ ...input, boundary: { ...input.boundary, executingOperations: 1 as 0 } }),
    ).toThrow(/boundary/);
    expect(() =>
      buildManifest({ ...input, boundary: { ...input.boundary, heldEffectSlots: 2 as 0 } }),
    ).toThrow(/boundary/);
    expect(() => buildManifest({ ...input, rolesChecksum: "xyz" })).toThrow(/rolesChecksum/);
    expect(() => buildManifest({ ...input, pairId: "not-a-uuid" })).toThrow(/pairId/);
  });
});

describe("verifyArtifacts", () => {
  it("passes for the files the manifest describes (control)", async () => {
    const { directory, manifest } = pairDirectory();
    expect(await verifyArtifacts(manifest, directory)).toEqual({ ok: true, problems: [] });
  });

  it("reports a changed byte, a missing file and an extra file", async () => {
    const { directory, manifest } = pairDirectory();
    writeFileSync(join(directory, "globals.sql"), "synthetic globals.sql changed");
    rmSync(join(directory, "openbao.snap"));
    writeFileSync(join(directory, "extra.bin"), "x");
    const result = await verifyArtifacts(manifest, directory);
    expect(result.ok).toBe(false);
    expect(result.problems.sort()).toEqual([
      "changed: globals.sql",
      "extra: extra.bin",
      "missing: openbao.snap",
    ]);
  });
});
