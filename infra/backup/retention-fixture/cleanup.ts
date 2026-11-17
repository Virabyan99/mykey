// Run 6.6 Task A (P-121): the end of the retention fixture, run once by hand.
//
//   node infra/backup/retention-fixture/cleanup.ts
//
// 1. Downloads the oldest pair (pairs/pair-20261111-1), checks the bundle's
//    digest against its manifest, runs `restic check --read-data` with the
//    fixture's password and restores it: the three synthetic files must come
//    back with their sizes and globals.sql with the builder's text.
// 2. Deletes every object of the bucket (probe/ and scratch/ included) with the
//    verified bulk delete, then proves each gone with HEAD.
// 3. Writes checkpoint run-6.6-cleanup-and-restore as observed, with the
//    outcome per object, and records that the fixture holds no object.
// The bucket and its lock rules stay for the cloud tests.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesOf, loadR2Credentials, r2Store } from "@mykey/backup";
import {
  GLOBALS_SQL,
  resticInBundle,
  resticPasswordFile,
  type PairManifest,
} from "./build-pair.ts";
import { readEvidence, writeEvidence } from "./provision.ts";
import { FIXTURE_BUCKET } from "./upload.ts";

const OLDEST = "pairs/pair-20261111-1";
const MIB = 1024 * 1024;

const evidence = readEvidence();
if (evidence === undefined) throw new Error("no fixture evidence");
const checkpoint = evidence.checkpoints.find((c) => c.id === "run-6.6-cleanup-and-restore");
if (checkpoint === undefined) throw new Error("no checkpoint run-6.6-cleanup-and-restore");
if (checkpoint.status === "observed") throw new Error("the fixture was already cleaned up");

const store = r2Store(loadR2Credentials("mykey-fixture-cleanup"), FIXTURE_BUCKET);
const work = mkdtempSync(join(tmpdir(), "mykey-fixture-end-"));
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

try {
  // 1. The oldest pair restores.
  const manifest = JSON.parse(
    (await bytesOf(await store.get(`${OLDEST}/manifest.json`))).toString("utf8"),
  ) as PairManifest;
  const bundle = await bytesOf(await store.get(`${OLDEST}/bundle.tar`));
  const bundlePath = join(work, "bundle.tar");
  writeFileSync(bundlePath, bundle);
  if (sha(bundle) !== manifest.bundleSha256 || bundle.length !== manifest.bundleBytes) {
    throw new Error("the downloaded bundle differs from its manifest");
  }
  const password = resticPasswordFile();
  resticInBundle(bundlePath, password, ["check", "--read-data"]);
  const out = join(work, "out");
  mkdirSync(out);
  resticInBundle(bundlePath, password, ["restore", "latest", "--target", "/out"], { out });
  const restored = join(out, "source");
  const sizes = Object.fromEntries(
    ["globals.sql", "pg.dump", "raft.snap"].map((name) => [
      name,
      statSync(join(restored, name)).size,
    ]),
  );
  const globalsEqual = readFileSync(join(restored, "globals.sql"), "utf8") === GLOBALS_SQL;
  if (sizes["pg.dump"] !== MIB || sizes["raft.snap"] !== MIB || !globalsEqual) {
    throw new Error(`the restored files are not the fixture's: ${JSON.stringify(sizes)}`);
  }
  process.stdout.write(`restored ${OLDEST}: bundle digest equal, check --read-data passed\n`);

  // 2. Every object goes, verified.
  const keys = (await store.list("")).map((o) => o.key).sort();
  const outcomes = await store.deleteChecked(keys);
  const after: Record<string, boolean> = {};
  for (const key of keys) after[key] = (await store.head(key)) === null;
  const refused = outcomes.filter((o) => !o.deleted);
  const still = keys.filter((key) => !after[key]);
  process.stdout.write(
    `deleted ${String(outcomes.length - refused.length)} of ${String(keys.length)}; refused ${String(refused.length)}; still present ${String(still.length)}\n`,
  );

  // 3. Checkpoint 3.
  checkpoint.status = "observed";
  checkpoint.observed = {
    script: "infra/backup/retention-fixture/cleanup.ts",
    at: new Date().toISOString(),
    restore: {
      pair: OLDEST,
      bundleBytes: bundle.length,
      bundleSha256Matches: true,
      resticCheck: "read-data passed",
      restoredSizes: sizes,
      globalsSqlEqual: globalsEqual,
    },
    objects: keys.map((key) => ({
      key,
      deleted: outcomes.find((o) => o.key === key)?.deleted ?? false,
      errorCode: outcomes.find((o) => o.key === key)?.errorCode ?? null,
      headAfter: after[key] === true ? 404 : 200,
    })),
  };
  evidence.objects = evidence.objects.filter((o) => still.includes(o.key));
  writeEvidence(evidence);
  if (refused.length > 0 || still.length > 0) process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
