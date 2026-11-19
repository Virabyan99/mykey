// Run 6.9 Task A (P-127): a host release says pass for each scan or it does
// not parse. There is no other value to write.
import { describe, expect, it } from "vitest";
import { releaseSchema } from "../../../infra/release/release-schema.ts";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const valid = {
  format: "mykey-host-release/1",
  version: "0.6.0",
  commit: "c96b83d0123456789abcdef0123456789abcdef0",
  builtAt: "2026-11-18T12:00:00.000Z",
  images: [
    { name: "api", imageId: digest("a"), archive: "api.tar", archiveSha256: "1".repeat(64) },
    {
      name: "provisioner",
      imageId: digest("b"),
      archive: "provisioner.tar",
      archiveSha256: "2".repeat(64),
    },
    { name: "ops", imageId: digest("c"), archive: "ops.tar", archiveSha256: "3".repeat(64) },
  ],
  baseDigests: { node: digest("d") },
  migrations: { last: "0018_incarnation" },
  scans: { secrets: "pass", dependencies: "pass", images: "pass" },
};

describe("release.json (P-127)", () => {
  it("a complete release parses", () => {
    expect(releaseSchema.parse(valid)).toEqual(valid);
  });

  it("a scan that is not pass does not parse", () => {
    for (const scan of ["secrets", "dependencies", "images"] as const) {
      for (const value of ["fail", "skipped", "", null]) {
        const copy = structuredClone(valid) as unknown as { scans: Record<string, unknown> };
        copy.scans[scan] = value;
        expect(releaseSchema.safeParse(copy).success, `${scan}=${String(value)}`).toBe(false);
      }
    }
  });

  it("each of the three images exactly once, by image id, with its archive's digest", () => {
    const missing = structuredClone(valid);
    missing.images.pop();
    expect(releaseSchema.safeParse(missing).success).toBe(false);
    const twice = structuredClone(valid);
    twice.images[2] = { ...twice.images[1]! };
    expect(releaseSchema.safeParse(twice).success).toBe(false);
    const byTag = structuredClone(valid);
    byTag.images[0]!.imageId = "mykey-api:0.6.0";
    expect(releaseSchema.safeParse(byTag).success).toBe(false);
    const extra = { ...structuredClone(valid), signedBy: "nobody" };
    expect(releaseSchema.safeParse(extra).success).toBe(false);
  });

  it("a version is three numbers; a commit is 40 hex", () => {
    expect(releaseSchema.safeParse({ ...valid, version: "0.6" }).success).toBe(false);
    expect(releaseSchema.safeParse({ ...valid, commit: "c96b83d" }).success).toBe(false);
  });
});
