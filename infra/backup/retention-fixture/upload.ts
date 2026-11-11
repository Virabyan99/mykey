// Builds the retention fixture and uploads it to R2, which starts its lock clocks.
// Run once, after provision.ts: node infra/backup/retention-fixture/upload.ts
//
// Three pairs go under pairs/ (locked four days), two under probe/ (locked ten
// minutes) and two unlocked control objects under scratch/. Every object is
// recorded in docs/evidence/session-1/retention-fixture.json with the upload
// time R2 itself reports. Synthetic data only.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { buildPair, ensureResticPassword } from "./build-pair.ts";
import {
  readEvidence,
  writeEvidence,
  type Checkpoint,
  type FixtureObject,
  type LockRule,
} from "./provision.ts";
import { loadR2Credentials, s3ClientFor } from "./r2.ts";

export const FIXTURE_BUCKET = "mykey-retention-fixture";

export interface PlannedPair {
  pairId: string;
  prefix: "pairs/" | "probe/";
  captureTime: string;
}

const HOUR = 3_600_000;

/**
 * What the fixture holds. Capture times are staggered so that "the oldest
 * eligible pair" is well defined and differs from the upload order of clocks.
 */
export function fixturePlan(now: Date): { pairs: PlannedPair[]; controls: string[] } {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  return {
    pairs: [
      { pairId: `pair-${day}-1`, prefix: "pairs/", captureTime: at(2 * HOUR) },
      { pairId: `pair-${day}-2`, prefix: "pairs/", captureTime: at(HOUR) },
      { pairId: `pair-${day}-3`, prefix: "pairs/", captureTime: at(0) },
      { pairId: `probe-${day}-1`, prefix: "probe/", captureTime: at(HOUR / 2) },
      { pairId: `probe-${day}-2`, prefix: "probe/", captureTime: at(0) },
    ],
    controls: ["scratch/control-1.txt", "scratch/control-2.txt"],
  };
}

/** The enabled lock rule whose prefix covers the key, if any. */
export function lockRuleFor(key: string, rules: LockRule[]): LockRule | undefined {
  return rules.find((rule) => rule.enabled && key.startsWith(rule.prefix));
}

/** When the lock of an object ends: the upload time R2 reports plus the rule's age. */
export function lockExpiresAt(uploadedAt: string, maxAgeSeconds: number): string {
  return new Date(new Date(uploadedAt).getTime() + maxAgeSeconds * 1000).toISOString();
}

/** The HTTP status and error code of a refused S3 call. */
export function s3Failure(error: unknown): { status: number | null; code: string } {
  const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return { status: failure.$metadata?.httpStatusCode ?? null, code: failure.name ?? "Unknown" };
}

async function upload(): Promise<void> {
  const evidence = readEvidence();
  if (evidence === undefined) throw new Error("run provision.ts first: no evidence file");
  if (evidence.objects.length > 0) {
    throw new Error("the fixture is already uploaded; its clocks must not be restarted");
  }
  const rules = evidence.buckets.find((bucket) => bucket.name === FIXTURE_BUCKET)?.lockRules ?? [];
  if (rules.length !== 2) throw new Error("the fixture bucket does not have its two lock rules");

  const uploader = s3ClientFor(loadR2Credentials("mykey-fixture-upload"));
  const cleaner = s3ClientFor(loadR2Credentials("mykey-fixture-cleanup"));
  const operations: Record<string, number> = {};
  const send = async <T>(client: S3Client, command: object): Promise<T> => {
    const name = command.constructor.name.replace(/Command$/, "");
    operations[name] = (operations[name] ?? 0) + 1;
    return (await client.send(command as never)) as T;
  };

  const listed = await send<{ KeyCount?: number }>(
    uploader,
    new ListObjectsV2Command({ Bucket: FIXTURE_BUCKET, MaxKeys: 1 }),
  );
  if ((listed.KeyCount ?? 0) > 0) throw new Error("the fixture bucket is not empty");

  const plan = fixturePlan(new Date());
  const work = mkdtempSync(join(tmpdir(), "mykey-fixture-"));
  try {
    const passwordFile = ensureResticPassword();
    const uploads: { key: string; body: Buffer; type: string; pair: PlannedPair | null }[] = [];
    const pairBytes: Record<string, { bundleBytes: number; manifestBytes: number }> = {};
    const sums = new Map<string, string>();
    for (const planned of plan.pairs) {
      const built = buildPair({
        pairId: planned.pairId,
        captureTime: new Date(planned.captureTime),
        outDir: work,
        passwordFile,
      });
      const bundle = readFileSync(built.bundlePath);
      const manifest = readFileSync(built.manifestPath);
      const base = `${planned.prefix}${planned.pairId}/`;
      uploads.push(
        { key: `${base}bundle.tar`, body: bundle, type: "application/x-tar", pair: planned },
        { key: `${base}manifest.json`, body: manifest, type: "application/json", pair: planned },
      );
      pairBytes[planned.pairId] = { bundleBytes: bundle.length, manifestBytes: manifest.length };
      sums.set(`${base}bundle.tar`, built.manifest.bundleSha256);
      console.log(`built ${planned.pairId}: bundle ${String(bundle.length)} bytes`);
    }
    plan.controls.forEach((key, index) => {
      uploads.push({
        key,
        body: Buffer.from(
          `MyKey retention fixture, synthetic control object ${String(index + 1)}.\n`,
        ),
        type: "text/plain",
        pair: null,
      });
    });

    const objects: FixtureObject[] = [];
    for (const item of uploads) {
      await send(
        uploader,
        new PutObjectCommand({
          Bucket: FIXTURE_BUCKET,
          Key: item.key,
          Body: item.body,
          ContentType: item.type,
        }),
      );
      const head = await send<{ ContentLength?: number; ETag?: string; LastModified?: Date }>(
        uploader,
        new HeadObjectCommand({ Bucket: FIXTURE_BUCKET, Key: item.key }),
      );
      if (head.LastModified === undefined || head.ETag === undefined) {
        throw new Error(`${item.key}: R2 returned no LastModified or ETag`);
      }
      const uploadedAt = head.LastModified.toISOString();
      const rule = lockRuleFor(item.key, rules);
      objects.push({
        key: item.key,
        bytes: head.ContentLength ?? -1,
        etag: head.ETag,
        uploadedAt,
        captureTime: item.pair?.captureTime ?? null,
        pairId: item.pair?.pairId ?? null,
        lockRule: rule?.id ?? null,
        lockExpiresAt:
          rule === undefined ? null : lockExpiresAt(uploadedAt, rule.condition.maxAgeSeconds),
      });
      console.log(`uploaded ${item.key} at ${uploadedAt}`);
    }

    // One verification download: the oldest pair's bundle comes back byte for byte.
    const oldestPair = plan.pairs.find((pair) => pair.prefix === "pairs/");
    const firstProbe = plan.pairs.find((pair) => pair.prefix === "probe/");
    if (oldestPair === undefined || firstProbe === undefined) throw new Error("empty plan");
    const verifyKey = `pairs/${oldestPair.pairId}/bundle.tar`;
    const fetched = await send<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }>(
      uploader,
      new GetObjectCommand({ Bucket: FIXTURE_BUCKET, Key: verifyKey }),
    );
    if (fetched.Body === undefined) throw new Error(`${verifyKey}: download has no body`);
    const bytes = await fetched.Body.transformToByteArray();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== sums.get(verifyKey)) throw new Error(`${verifyKey}: download differs`);

    // Inside its ten-minute lock, a probe object cannot be deleted.
    const probeKey = `probe/${firstProbe.pairId}/manifest.json`;
    let probeDenied: { key: string; status: number | null; code: string; at: string };
    try {
      await send(cleaner, new DeleteObjectCommand({ Bucket: FIXTURE_BUCKET, Key: probeKey }));
      probeDenied = {
        key: probeKey,
        status: 204,
        code: "NOT DENIED",
        at: new Date().toISOString(),
      };
    } catch (error) {
      probeDenied = { key: probeKey, ...s3Failure(error), at: new Date().toISOString() };
    }
    console.log(`delete of ${probeKey} inside its lock: ${probeDenied.code}`);

    const expiry = (prefix: string): string | null =>
      objects
        .flatMap((object) =>
          object.key.startsWith(prefix) && object.lockExpiresAt !== null
            ? [object.lockExpiresAt]
            : [],
        )
        .sort()
        .at(-1) ?? null;
    const checkpoints: Checkpoint[] = [
      {
        id: "probe-expiry",
        what: "After the probe lock has passed, a probe/ object can be deleted while a pairs/ object uploaded at the same time is still refused.",
        notBefore: expiry("probe/"),
        status: "pending",
      },
      {
        id: "pairs-lock-session-gate",
        what: "At the first session gate on or after this time: repeat the refused delete on a pairs/ object before the lock ends, or record that the lock has ended after it.",
        notBefore: expiry("pairs/"),
        status: "pending",
      },
      {
        id: "run-6.6-cleanup-and-restore",
        what: "Run 6.6: clean up the fixture objects whose lock has ended and restore the oldest eligible pair.",
        notBefore: expiry("pairs/"),
        status: "pending",
      },
    ];

    writeEvidence({
      ...evidence,
      upload: {
        bucket: FIXTURE_BUCKET,
        uploadToken: "mykey-fixture-upload",
        cleanupToken: "mykey-fixture-cleanup",
        resticVersion: "0.19.1",
        pairBytes,
        operations,
        verificationDownload: { key: verifyKey, bytes: bytes.length, sha256Matches: true },
        probeDeleteInsideLock: probeDenied,
      },
      objects,
      checkpoints,
    });
    if (probeDenied.code !== "ObjectLockedByBucketPolicy") {
      throw new Error(`delete of ${probeKey} inside its lock answered ${probeDenied.code}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  upload().then(
    () => {
      console.log("fixture uploaded.");
    },
    (error: unknown) => {
      console.error(`upload failed: ${error instanceof Error ? error.message : "unknown error"}`);
      process.exit(1);
    },
  );
}
