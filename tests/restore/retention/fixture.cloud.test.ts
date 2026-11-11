// Cloud tests against Cloudflare R2. They describe provider behaviour: a failure
// is a finding to record, never something to fix by weakening the assertion.
// Run: pnpm run test:cloud (refuses to start without credentials).
import { randomBytes } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  LOCK_RULES,
  TOKEN_PLAN,
  readEvidence,
  readLockRules,
  type FixtureObject,
} from "../../../infra/backup/retention-fixture/provision.ts";
import {
  deleteObjectsChecked,
  deleteOutcomes,
  loadR2ApiToken,
  loadR2Credentials,
  s3ClientFor,
} from "../../../infra/backup/retention-fixture/r2.ts";
import { FIXTURE_BUCKET, s3Failure } from "../../../infra/backup/retention-fixture/upload.ts";

const HOUR = 3_600_000;

const evidence = readEvidence();
if (evidence === undefined || evidence.objects.length === 0) {
  throw new Error("no uploaded fixture is recorded: run provision.ts and upload.ts first");
}
const uploader = s3ClientFor(loadR2Credentials("mykey-fixture-upload"));
const cleaner = s3ClientFor(loadR2Credentials("mykey-fixture-cleanup"));
const adminApiToken = loadR2ApiToken("mykey-r2-admin");

const under = (prefix: string): FixtureObject[] =>
  evidence.objects.filter((object) => object.key.startsWith(prefix));

/**
 * A recorded pairs/ object whose lock still has at least an hour to run. The
 * refusal tests try to overwrite and delete it; once the lock has ended they
 * would destroy the fixture, so they refuse to run instead.
 */
function lockedPairObject(name: "bundle.tar" | "manifest.json"): FixtureObject {
  // The newest pair, so the oldest eligible pair is never the one at risk.
  const candidate = under("pairs/")
    .filter((object) => object.key.endsWith(`/${name}`))
    .sort((a, b) => (a.captureTime ?? "").localeCompare(b.captureTime ?? ""))
    .at(-1);
  if (candidate?.lockExpiresAt == null) throw new Error("no pairs/ object is recorded");
  if (Date.now() > new Date(candidate.lockExpiresAt).getTime() - HOUR) {
    throw new Error(
      `the pairs/ lock ends at ${candidate.lockExpiresAt}: this test must not touch the fixture ` +
        "now. Record checkpoint pairs-lock-session-gate; Run 6.6 cleans the fixture up.",
    );
  }
  return candidate;
}

async function head(client: S3Client, key: string): Promise<{ status: number; etag?: string }> {
  try {
    const answer = await client.send(new HeadObjectCommand({ Bucket: FIXTURE_BUCKET, Key: key }));
    return {
      status: answer.$metadata.httpStatusCode ?? 0,
      ...(answer.ETag === undefined ? {} : { etag: answer.ETag }),
    };
  } catch (error) {
    return { status: s3Failure(error).status ?? 0 };
  }
}

async function refusal(action: Promise<unknown>): Promise<{ status: number | null; code: string }> {
  try {
    await action;
    return { status: 200, code: "NOT DENIED" };
  } catch (error) {
    return s3Failure(error);
  }
}

async function putScratch(): Promise<string> {
  const key = `scratch/test-${randomBytes(6).toString("hex")}.txt`;
  await uploader.send(
    new PutObjectCommand({ Bucket: FIXTURE_BUCKET, Key: key, Body: "synthetic test object\n" }),
  );
  return key;
}

const LOCKED = { status: 409, code: "ObjectLockedByBucketPolicy" };

describe("R2 lock rules", { timeout: 60_000 }, () => {
  it("production pairs rule reads back as 30 days", async () => {
    const rules = await readLockRules(adminApiToken, evidence.accountId, "mykey-prod-pairs");
    expect(rules).toEqual([
      {
        id: "pairs-30d",
        enabled: true,
        prefix: "pairs/",
        condition: { type: "Age", maxAgeSeconds: 2_592_000 },
      },
    ]);
  });

  it("fixture rules read back as configured", async () => {
    const rules = await readLockRules(adminApiToken, evidence.accountId, FIXTURE_BUCKET);
    expect([...rules].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      LOCK_RULES["mykey-retention-fixture"],
    );
    expect(rules.map((rule) => [rule.id, rule.condition.maxAgeSeconds])).toEqual(
      expect.arrayContaining([
        ["fixture-pairs-4d", 345_600],
        ["fixture-probe-10m", 600],
      ]),
    );
  });

  it("object tokens cannot change the lock rule", () => {
    // The token value exists only while provision.ts creates it, so the attempt
    // is made there and recorded; this test reads the record.
    const objectTokens = TOKEN_PLAN.filter((token) => token.bucket !== undefined);
    expect(objectTokens).toHaveLength(7);
    for (const token of objectTokens) {
      const attempt = evidence.lockChangeAttempts.find((entry) => entry.token === token.name);
      expect(attempt, token.name).toBeDefined();
      expect(attempt, token.name).toMatchObject({
        bucket: token.bucket,
        verifiedActive: true,
        denied: true,
      });
      expect([401, 403], token.name).toContain(attempt?.status);
      expect(Number.isNaN(new Date(attempt?.deniedAt ?? "").getTime()), token.name).toBe(false);
    }
  });
});

describe("R2 locked objects", { timeout: 60_000 }, () => {
  it("overwrite of a locked object is denied", async () => {
    const target = lockedPairObject("bundle.tar");
    const before = await head(uploader, target.key);
    expect(before).toEqual({ status: 200, etag: target.etag });

    const answer = await refusal(
      uploader.send(
        new PutObjectCommand({ Bucket: FIXTURE_BUCKET, Key: target.key, Body: "overwrite\n" }),
      ),
    );
    expect(answer).toEqual(LOCKED);
    expect(await head(uploader, target.key)).toEqual(before);
  });

  it("delete of a locked object is denied", async () => {
    const target = lockedPairObject("bundle.tar");
    const answer = await refusal(
      cleaner.send(new DeleteObjectCommand({ Bucket: FIXTURE_BUCKET, Key: target.key })),
    );
    expect(answer).toEqual(LOCKED);
    expect(await head(cleaner, target.key)).toEqual({ status: 200, etag: target.etag });
  });

  it("bulk delete returns HTTP 200 with per-object errors", async () => {
    const locked = lockedPairObject("manifest.json");

    // The raw answer: HTTP 200 although one of the two objects was refused.
    const first = await putScratch();
    const raw = await cleaner.send(
      new DeleteObjectsCommand({
        Bucket: FIXTURE_BUCKET,
        Delete: { Objects: [{ Key: locked.key }, { Key: first }], Quiet: false },
      }),
    );
    expect(raw.$metadata.httpStatusCode).toBe(200);
    expect(raw.Errors?.map((error) => [error.Key, error.Code])).toEqual([
      [locked.key, "ObjectLockedByBucketPolicy"],
    ]);
    expect(deleteOutcomes([locked.key, first], raw)).toEqual([
      { key: locked.key, deleted: false, errorCode: "ObjectLockedByBucketPolicy" },
      { key: first, deleted: true },
    ]);

    // The checked helper says the same, and a HEAD confirms each outcome.
    const second = await putScratch();
    expect(await deleteObjectsChecked(cleaner, FIXTURE_BUCKET, [locked.key, second])).toEqual([
      { key: locked.key, deleted: false, errorCode: "ObjectLockedByBucketPolicy" },
      { key: second, deleted: true },
    ]);
    expect(await head(cleaner, locked.key)).toEqual({ status: 200, etag: locked.etag });
    expect((await head(cleaner, first)).status).toBe(404);
    expect((await head(cleaner, second)).status).toBe(404);
  });

  it("failed multipart upload is cleaned up", async () => {
    const key = `scratch/multipart-${randomBytes(6).toString("hex")}.bin`;
    const created = await uploader.send(
      new CreateMultipartUploadCommand({ Bucket: FIXTURE_BUCKET, Key: key }),
    );
    const uploadId = created.UploadId;
    expect(uploadId).toBeTruthy();
    // What a clean-up job sees: it knows the listing, not the id the uploader was given.
    let listedId: string | undefined;
    try {
      await uploader.send(
        new UploadPartCommand({
          Bucket: FIXTURE_BUCKET,
          Key: key,
          UploadId: uploadId,
          PartNumber: 1,
          Body: randomBytes(64 * 1024),
        }),
      );
      const open = await cleaner.send(
        new ListMultipartUploadsCommand({ Bucket: FIXTURE_BUCKET, Prefix: key }),
      );
      expect(open.Uploads?.map((upload) => upload.Key)).toEqual([key]);
      listedId = open.Uploads?.[0]?.UploadId;
      // Finding (11 Nov 2026): R2 writes the id of one upload as a different string
      // each time it reports it, so ids cannot be compared; each of them works.
      expect(listedId).toBeTruthy();
    } finally {
      await cleaner.send(
        new AbortMultipartUploadCommand({
          Bucket: FIXTURE_BUCKET,
          Key: key,
          UploadId: listedId ?? uploadId,
        }),
      );
    }
    const after = await uploader.send(
      new ListMultipartUploadsCommand({ Bucket: FIXTURE_BUCKET, Prefix: key }),
    );
    expect(after.Uploads ?? []).toEqual([]);
    expect((await head(uploader, key)).status).toBe(404);
  });
});

describe("R2 lock expiry", { timeout: 60_000 }, () => {
  it("probe lock expires", async () => {
    // Inside the lock, upload.ts tried to delete a probe object and was refused.
    expect(evidence.upload?.probeDeleteInsideLock).toMatchObject(LOCKED);

    // The first probe pair is the one this test deletes; the second is left for Run 6.6.
    const firstProbe = under("probe/")
      .map((object) => object.pairId ?? "")
      .sort()[0];
    const probes = under(`probe/${firstProbe ?? ""}/`);
    expect(probes).toHaveLength(2);
    const expiry = Math.max(
      ...probes.map((object) => new Date(object.lockExpiresAt ?? "").getTime()),
    );
    const present: FixtureObject[] = [];
    for (const object of probes) {
      if ((await head(cleaner, object.key)).status === 200) present.push(object);
    }

    if (present.length > 0) {
      if (Date.now() < expiry + 5000) {
        throw new Error(
          `the probe lock has not ended yet: run this test again after ${new Date(expiry).toISOString()}`,
        );
      }
      for (const object of present) {
        const answer = await cleaner.send(
          new DeleteObjectCommand({ Bucket: FIXTURE_BUCKET, Key: object.key }),
        );
        console.log(
          `probe-expiry: deleted ${object.key} at ${new Date().toISOString()} ` +
            `(HTTP ${String(answer.$metadata.httpStatusCode)}; lock ended ${String(object.lockExpiresAt)})`,
        );
      }
    } else {
      // An earlier run of this test deleted them; that run must be on record.
      const checkpoint = evidence.checkpoints.find((entry) => entry.id === "probe-expiry");
      expect(checkpoint?.status).toBe("observed");
    }
    for (const object of probes) {
      expect((await head(cleaner, object.key)).status, object.key).toBe(404);
    }

    // A pairs/ object uploaded in the same minutes is still refused.
    const pair = lockedPairObject("bundle.tar");
    const answer = await refusal(
      cleaner.send(new DeleteObjectCommand({ Bucket: FIXTURE_BUCKET, Key: pair.key })),
    );
    expect(answer).toEqual(LOCKED);
    expect((await head(cleaner, pair.key)).status).toBe(200);
  });
});
