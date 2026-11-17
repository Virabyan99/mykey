// Run 6.2 Task B (P-112): the audit archive's bucket as the job uses it,
// through the job's own token (`mykey-audit-archive-upload`) and the
// ObjectStore of @mykey/backup, under the prefix `probe/` (lock 600 s). Cloud
// tests describe provider behaviour: a failure is a finding to record, never
// something to fix by weakening the assertion.
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { bytesOf, loadR2Credentials, r2Store } from "@mykey/backup";

const store = r2Store(loadR2Credentials("mykey-audit-archive-upload"), "mykey-audit-archive");
const base = `probe/${new Date().toISOString().slice(0, 10)}/${randomBytes(6).toString("hex")}`;
const body = gzipSync(Buffer.from(`${JSON.stringify({ id: randomBytes(8).toString("hex") })}\n`));
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const manifest = Buffer.from(
  `${JSON.stringify({ format: "mykey-audit-segment/1", sha256: sha(body) })}\n`,
);

describe("the audit archive's bucket (P-112)", { timeout: 60_000 }, () => {
  it("put, read back, compare: segment and manifest", async () => {
    await store.put(`${base}/segment-0000000001.ndjson.gz`, body, {
      bytes: body.length,
      sha256: sha(body),
    });
    await store.put(`${base}/segment-0000000001.manifest.json`, manifest, {
      bytes: manifest.length,
      sha256: sha(manifest),
    });
    const back = await bytesOf(await store.get(`${base}/segment-0000000001.ndjson.gz`));
    expect(sha(back)).toBe(sha(body));
    expect((await store.head(`${base}/segment-0000000001.manifest.json`))?.bytes).toBe(
      manifest.length,
    );
  });

  it("a body that does not match the declared sha256 is refused", async () => {
    const other = Buffer.from("not the body");
    const error = await store
      .put(`${base}/mismatch.bin`, other, { bytes: other.length, sha256: sha(body) })
      .then(
        () => null,
        (caught: unknown) => caught as { name?: string; $metadata?: { httpStatusCode?: number } },
      );
    expect(error).not.toBeNull();
    expect(error?.$metadata?.httpStatusCode).toBe(400);
    expect(await store.head(`${base}/mismatch.bin`)).toBeNull();
  });

  it("an overwrite of a segment within its lock is refused with 409", async () => {
    const changed = Buffer.concat([body, Buffer.from([0])]);
    const error = await store
      .put(`${base}/segment-0000000001.ndjson.gz`, changed, {
        bytes: changed.length,
        sha256: sha(changed),
      })
      .then(
        () => null,
        (caught: unknown) => caught as { name?: string; $metadata?: { httpStatusCode?: number } },
      );
    expect(error?.$metadata?.httpStatusCode).toBe(409);
    expect(error?.name).toBe("ObjectLockedByBucketPolicy");
    const back = await bytesOf(await store.get(`${base}/segment-0000000001.ndjson.gz`));
    expect(sha(back)).toBe(sha(body));
  });

  it("list returns the manifest and the segment", async () => {
    const listed = await store.list(`${base}/`);
    expect(listed.map((entry) => entry.key)).toEqual([
      `${base}/segment-0000000001.manifest.json`,
      `${base}/segment-0000000001.ndjson.gz`,
    ]);
  });
});
