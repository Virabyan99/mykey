// Cloud tests against Cloudflare R2. They describe provider behaviour: a failure
// is a finding to record, never something to fix by weakening the assertion.
// Run: pnpm run test:cloud (refuses to start without credentials).
//
// Since Run 6.6 the fixture of Run 1.9 is gone (cleanup.ts, checkpoint
// run-6.6-cleanup-and-restore). Each run makes its own objects under
// probe/run-<epochMs>-<hex>/, which the bucket locks for 600 s, and deletes
// those of a run at least eleven minutes earlier, found by listing. No test is
// dated any more.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";
import {
  LOCK_RULES,
  TOKEN_PLAN,
  readEvidence,
  readLockRules,
} from "../../../infra/backup/retention-fixture/provision.ts";
import {
  deleteObjectsChecked,
  deleteOutcomes,
  loadR2ApiToken,
  loadR2Credentials,
  s3ClientFor,
} from "../../../infra/backup/retention-fixture/r2.ts";
import { FIXTURE_BUCKET, s3Failure } from "../../../infra/backup/retention-fixture/upload.ts";

const PROBE_LOCK_MS = 600_000;
/** A run's probe objects are deleted by a run at least this much later. */
const EARLIER_RUN_MS = 11 * 60_000;
const RUN_PREFIX = /^probe\/run-(\d{13})-[0-9a-f]{8}\/$/;
/** One line per run of the lock-expiry test (Run 6.6: two runs at least eleven minutes apart). */
const EXPIRY_LOG = "docs/evidence/session-6/run-6.6-lock-expiry.json";

const evidence = readEvidence();
if (evidence === undefined) throw new Error("no fixture evidence: run provision.ts first");
const uploader = s3ClientFor(loadR2Credentials("mykey-fixture-upload"));
const cleaner = s3ClientFor(loadR2Credentials("mykey-fixture-cleanup"));
const adminApiToken = loadR2ApiToken("mykey-r2-admin");

const startedAt = Date.now();
const runPrefix = `probe/run-${String(startedAt)}-${randomBytes(4).toString("hex")}/`;
/** This run's locked object: made in beforeAll, refused to change in the tests below. */
const lockedKey = `${runPrefix}locked.bin`;
let lockedEtag: string;

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

/** Every object key under probe/, grouped by run prefix. */
async function probeRuns(): Promise<Map<string, string[]>> {
  const runs = new Map<string, string[]>();
  let token: string | undefined;
  do {
    const page = await cleaner.send(
      new ListObjectsV2Command({
        Bucket: FIXTURE_BUCKET,
        Prefix: "probe/run-",
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) {
      const key = object.Key ?? "";
      const prefix = key.slice(0, key.indexOf("/", "probe/".length) + 1);
      runs.set(prefix, [...(runs.get(prefix) ?? []), key]);
    }
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return runs;
}

const LOCKED = { status: 409, code: "ObjectLockedByBucketPolicy" };

beforeAll(async () => {
  const put = await uploader.send(
    new PutObjectCommand({ Bucket: FIXTURE_BUCKET, Key: lockedKey, Body: randomBytes(1024) }),
  );
  lockedEtag = put.ETag ?? "";
  expect(lockedEtag).not.toBe("");
}, 60_000);

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

describe("R2 locked objects (this run's own, under probe/)", { timeout: 60_000 }, () => {
  it("overwrite of a locked object is denied", async () => {
    const before = await head(uploader, lockedKey);
    expect(before).toEqual({ status: 200, etag: lockedEtag });
    const answer = await refusal(
      uploader.send(
        new PutObjectCommand({ Bucket: FIXTURE_BUCKET, Key: lockedKey, Body: "overwrite\n" }),
      ),
    );
    expect(answer).toEqual(LOCKED);
    expect(await head(uploader, lockedKey)).toEqual(before);
  });

  it("delete of a locked object is denied", async () => {
    const answer = await refusal(
      cleaner.send(new DeleteObjectCommand({ Bucket: FIXTURE_BUCKET, Key: lockedKey })),
    );
    expect(answer).toEqual(LOCKED);
    expect(await head(cleaner, lockedKey)).toEqual({ status: 200, etag: lockedEtag });
  });

  it("bulk delete returns HTTP 200 with per-object errors", async () => {
    // The raw answer: HTTP 200 although one of the two objects was refused.
    const first = await putScratch();
    const raw = await cleaner.send(
      new DeleteObjectsCommand({
        Bucket: FIXTURE_BUCKET,
        Delete: { Objects: [{ Key: lockedKey }, { Key: first }], Quiet: false },
      }),
    );
    expect(raw.$metadata.httpStatusCode).toBe(200);
    expect(raw.Errors?.map((error) => [error.Key, error.Code])).toEqual([
      [lockedKey, "ObjectLockedByBucketPolicy"],
    ]);
    expect(deleteOutcomes([lockedKey, first], raw)).toEqual([
      { key: lockedKey, deleted: false, errorCode: "ObjectLockedByBucketPolicy" },
      { key: first, deleted: true },
    ]);

    // The checked helper says the same, and a HEAD confirms each outcome.
    const second = await putScratch();
    expect(await deleteObjectsChecked(cleaner, FIXTURE_BUCKET, [lockedKey, second])).toEqual([
      { key: lockedKey, deleted: false, errorCode: "ObjectLockedByBucketPolicy" },
      { key: second, deleted: true },
    ]);
    expect(await head(cleaner, lockedKey)).toEqual({ status: 200, etag: lockedEtag });
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

describe("R2 lock expiry", { timeout: 120_000 }, () => {
  it("probe objects of a run at least eleven minutes earlier are deleted; this run's are still refused", async () => {
    const runs = await probeRuns();
    const unknown = [...runs.keys()].filter((prefix) => !RUN_PREFIX.test(prefix));
    expect(unknown, "probe/run-* holds only run prefixes").toEqual([]);
    const earlier = [...runs.entries()].filter(([prefix]) => {
      const at = Number(RUN_PREFIX.exec(prefix)?.[1]);
      return startedAt - at >= EARLIER_RUN_MS;
    });

    const deleted: { prefix: string; objects: number; ageMinutes: number }[] = [];
    for (const [prefix, keys] of earlier) {
      const outcomes = await deleteObjectsChecked(cleaner, FIXTURE_BUCKET, keys);
      expect(
        outcomes.filter((o) => !o.deleted),
        prefix,
      ).toEqual([]);
      for (const key of keys) expect((await head(cleaner, key)).status, key).toBe(404);
      const ageMs = startedAt - Number(RUN_PREFIX.exec(prefix)?.[1]);
      deleted.push({ prefix, objects: keys.length, ageMinutes: Math.round(ageMs / 60_000) });
    }
    // The first run after a quiet spell finds nothing old enough: it says so,
    // and its own objects are the proof of the next run eleven minutes later.
    const log = existsSync(EXPIRY_LOG)
      ? (JSON.parse(readFileSync(EXPIRY_LOG, "utf8")) as unknown[])
      : [];
    log.push({
      run: runPrefix,
      startedAt: new Date(startedAt).toISOString(),
      lockMinutes: PROBE_LOCK_MS / 60_000,
      deleted,
      note:
        deleted.length === 0
          ? `no probe run at least 11 min older; the next run after ${new Date(startedAt + EARLIER_RUN_MS).toISOString()} deletes this one's`
          : "earlier runs' objects deleted after their lock and proven gone by HEAD",
    });
    writeFileSync(EXPIRY_LOG, `${JSON.stringify(log, null, 2)}\n`);

    // This run's object, inside its lock, is still refused.
    const answer = await refusal(
      cleaner.send(new DeleteObjectCommand({ Bucket: FIXTURE_BUCKET, Key: lockedKey })),
    );
    expect(answer).toEqual(LOCKED);
    expect((await head(cleaner, lockedKey)).status).toBe(200);
  });
});
