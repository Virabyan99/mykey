// Run 6.5 Task C (P-119, P-120, D-52): one pair, end to end, with the real
// commands in backup.sh's order — capture begin, the three artifacts, pair
// manifest, capture record, Restic pack, pair upload (read back), Restic check
// and restore, pair verify — against the local stack, the pinned Restic image
// and a directory standing in for R2.
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
  bytesOf,
  directoryStore,
  eligibilitySchema,
  verifyEligibility,
  type ObjectStore,
} from "@mykey/backup";
import { findPair, markEligible, markIneligible } from "@mykey/db";
import { runOps, type OpsEnv } from "@mykey/ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baoFetch, pgDumpToFile, pgGlobalsToFile } from "../../harness/stack.ts";
import { restic, tarIn } from "../../harness/restic.ts";
import { prepareDatabase, run, type TestDatabase } from "../database/setup.ts";

let db: TestDatabase;
let work: string;
let signing: { privateKey: KeyObject; publicKey: KeyObject };

beforeAll(async () => {
  db = await prepareDatabase({ migrate: true });
  work = mkdtempSync(join(tmpdir(), "mykey-pair-test-"));
  signing = generateKeyPairSync("ed25519");
}, 300_000);

afterAll(async () => {
  rmSync(work, { recursive: true, force: true });
  await db.drop();
});

/** Changes one byte in the middle of a buffer. */
function flip(bytes: Buffer): void {
  const at = Math.floor(bytes.length / 2);
  bytes.writeUInt8((bytes.readUInt8(at) ^ 0x01) & 0xff, at);
}

interface Run {
  scratch: string;
  store: ObjectStore;
  storeRoot: string;
  password: string;
  env: OpsEnv;
}

function newRun(wrap?: (store: ObjectStore) => ObjectStore): Run {
  const base = mkdtempSync(join(work, "run-"));
  const scratch = join(base, "scratch");
  const storeRoot = join(base, "bucket");
  mkdirSync(scratch);
  mkdirSync(storeRoot);
  const password = join(base, "restic-password");
  writeFileSync(password, randomBytes(24).toString("hex"));
  const plain = directoryStore(storeRoot);
  const store = wrap === undefined ? plain : wrap(plain);
  return {
    scratch,
    store,
    storeRoot,
    password,
    env: {
      database: db.targets.maintenance,
      pairScratch: scratch,
      pairs: { store, host: "local", signing: { key: signing.privateKey, keyId: "k1" } },
    },
  };
}

async function ops(r: Run, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  const code = await runOps(argv, { stdin: new PassThrough(), stdout, stderr, env: r.env });
  return { code, out, err };
}

/** begin → artifacts → manifest → record: the frozen part and the release. */
async function capture(r: Run, during?: () => Promise<void>): Promise<string> {
  const begun = await ops(r, ["capture", "--step", "begin", "--owner", "backup"]);
  expect(begun.code, begun.err).toBe(0);
  const { pairId } = JSON.parse(begun.out) as { pairId: string };
  const dir = join(r.scratch, pairId);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeFileSync(join(dir, "begin.json"), begun.out);
  await pgDumpToFile(db.stack, db.database, join(dir, "artifacts", "postgres.dump"));
  await pgGlobalsToFile(db.stack, join(dir, "artifacts", "globals.sql"));
  const snapshot = await baoFetch(db.stack, "/v1/sys/storage/raft/snapshot");
  expect(snapshot.status).toBe(200);
  writeFileSync(
    join(dir, "artifacts", "openbao.snap"),
    new Uint8Array(await snapshot.arrayBuffer()),
  );
  if (during !== undefined) await during();
  writeFileSync(
    join(dir, "facts"),
    [
      "host_instance_id=local-instance",
      "backend_incarnation=local-cluster",
      "release_build=000000000000",
      "kms_key_id=local-kms",
      "seal_name=static",
      "tool_openbao=2.7.2",
      "tool_postgres=18.6",
      "tool_restic=0.19.1",
      "",
    ].join("\n"),
  );
  const manifest = await ops(r, ["pair", "--step", "manifest", "--pair", pairId]);
  expect(manifest.code, manifest.err).toBe(0);
  const recorded = await ops(r, [
    "capture",
    "--step",
    "record",
    "--owner",
    "backup",
    "--pair",
    pairId,
    "--manifest",
    join(dir, "manifest.json"),
  ]);
  expect(recorded.code, recorded.err).toBe(0);
  return pairId;
}

/** Pack into the pair's own repository and upload; the upload's exit code. */
async function packAndUpload(r: Run, pairId: string): Promise<number> {
  const dir = join(r.scratch, pairId);
  mkdirSync(join(dir, "repo"));
  const paths = { repo: join(dir, "repo"), password: r.password };
  expect((await restic(paths, ["init"])).code).toBe(0);
  const backup = await restic({ ...paths, artifacts: join(dir, "artifacts") }, [
    "backup",
    "--host",
    "mykey",
    "/artifacts",
  ]);
  expect(backup.code, backup.output).toBe(0);
  await tarIn(dir, ["-C", "/d", "-cf", "/d/bundle.tar", "repo"]);
  rmSync(join(dir, "repo"), { recursive: true, force: true });
  return (await ops(r, ["pair", "--step", "upload", "--pair", pairId])).code;
}

/** Unpack the read-back copy, check it with --read-data, restore it; then verify. */
async function checkAndVerify(
  r: Run,
  pairId: string,
  damage?: (repo: string) => void,
): Promise<{ code: number; out: string; err: string }> {
  const dir = join(r.scratch, pairId);
  mkdirSync(join(dir, "restore", "out"), { recursive: true });
  await tarIn(dir, ["-C", "/d/restore", "-xf", "/d/downloaded.tar"]);
  const repo = join(dir, "restore", "repo");
  damage?.(repo);
  const check = await restic({ repo, password: r.password }, ["check", "--read-data"]);
  writeFileSync(join(dir, "check.log"), check.output);
  writeFileSync(join(dir, "check.status"), `${String(check.code)}\n`);
  await restic({ repo, password: r.password, out: join(dir, "restore", "out") }, [
    "restore",
    "latest",
    "--target",
    "/out",
  ]);
  return ops(r, ["pair", "--step", "verify", "--pair", pairId]);
}

async function status(pairId: string): Promise<{ status: string; reason: string | null }> {
  const pair = await findPair(db.pool("superuser"), pairId);
  return { status: pair?.status ?? "absent", reason: pair?.invalidReason ?? null };
}

function storedKeys(root: string): string[] {
  const keys: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else keys.push(`${prefix}${name}`);
    }
  };
  walk(root, "");
  return keys.sort();
}

describe("a pair, end to end", () => {
  it("upload then verify makes the pair eligible with eligible_until = capture + 30 days and writes system.backup_eligible", async () => {
    const r = newRun();
    const pairId = await capture(r);
    expect(await packAndUpload(r, pairId)).toBe(0);
    const verified = await checkAndVerify(r, pairId);
    expect(verified.code, verified.err).toBe(0);
    expect(verified.out).toBe(`eligible ${pairId}\n`);

    const pair = await findPair(db.pool("superuser"), pairId);
    expect(pair?.status).toBe("eligible");
    expect(pair?.eligibleUntil?.getTime()).toBe(
      (pair?.captureStartedAt.getTime() ?? 0) + 30 * 86_400_000,
    );
    const keys = storedKeys(r.storeRoot);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(new RegExp(`^pairs/local/\\d{8}T\\d{6}Z-${pairId}/bundle\\.tar$`));
    expect(keys[1]?.replace(/eligible\.json$/, "")).toBe(keys[0]?.replace(/bundle\.tar$/, ""));
    expect(pair?.objectKey).toBe(keys[0]?.replace(/bundle\.tar$/, ""));

    const record = eligibilitySchema.parse(
      JSON.parse((await bytesOf(await r.store.get(keys[1] ?? ""))).toString("utf8")),
    );
    expect(verifyEligibility(record, new Map([["k1", signing.publicKey]]))).toEqual({ ok: true });
    expect(record.manifest.pairId).toBe(pairId);
    expect(record.eligibleUntil).toBe(pair?.eligibleUntil?.toISOString());

    const audits = await run<{ action: string; outcome: string }>(
      db.pool("superuser"),
      "SELECT action, outcome FROM audit.event WHERE target_id = $1 ORDER BY occurred_at, id",
      [pairId],
    );
    expect(audits).toContainEqual({ action: "system.backup_eligible", outcome: "success" });
    expect(readdirSync(join(r.scratch, pairId))).not.toContain("in");
  }, 300_000);

  it("a bundle that reads back with one changed byte stays candidate and the job exits 1", async () => {
    const r = newRun((store) => ({
      ...store,
      async get(key) {
        const bytes = await bytesOf(await store.get(key));
        if (key.endsWith("bundle.tar")) flip(bytes);
        return Readable.from([bytes]);
      },
    }));
    const pairId = await capture(r);
    expect(await packAndUpload(r, pairId)).toBe(1);
    expect(await status(pairId)).toEqual({ status: "candidate", reason: null });
    expect(storedKeys(r.storeRoot).filter((key) => key.endsWith("eligible.json"))).toEqual([]);
  }, 300_000);

  it("restic check failing stays candidate", async () => {
    const r = newRun();
    const pairId = await capture(r);
    expect(await packAndUpload(r, pairId)).toBe(0);
    const verified = await checkAndVerify(r, pairId, (repo) => {
      const data = join(repo, "data");
      const dirs = readdirSync(data);
      const file = dirs
        .map((sub) => readdirSync(join(data, sub)).map((name) => join(data, sub, name)))
        .flat()
        .sort((a, b) => statSync(b).size - statSync(a).size)[0];
      if (file === undefined) throw new Error("no pack file");
      chmodSync(file, 0o644); // restic writes its pack files read-only
      const bytes = readFileSync(file);
      flip(bytes);
      writeFileSync(file, bytes);
    });
    expect(verified.code).toBe(1);
    expect(verified.err).toMatch(/restic check/);
    expect(await status(pairId)).toEqual({ status: "candidate", reason: null });
    expect(storedKeys(r.storeRoot).filter((key) => key.endsWith("eligible.json"))).toEqual([]);
  }, 300_000);

  it("a pair whose capture window holds an invalidation becomes ineligible, not eligible", async () => {
    const r = newRun();
    const pairId = await capture(r, async () => {
      const api = await db.pool("api_runtime").connect();
      try {
        await api.query("BEGIN");
        await api.query("SELECT app.capture_invalidate('sign_out')");
        await api.query("COMMIT");
      } finally {
        api.release();
      }
    });
    expect(await packAndUpload(r, pairId)).toBe(0);
    const verified = await checkAndVerify(r, pairId);
    expect(verified.code, verified.err).toBe(0);
    expect(verified.out).toBe(`ineligible ${pairId} (access_reduction)\n`);
    expect(await status(pairId)).toEqual({ status: "ineligible", reason: "access_reduction" });
    expect(storedKeys(r.storeRoot).filter((key) => key.endsWith("eligible.json"))).toEqual([]);
  }, 300_000);

  it("two hours and one second after the capture a candidate is ineligible (deadline)", async () => {
    const r = newRun();
    const pairId = await capture(r);
    expect(await packAndUpload(r, pairId)).toBe(0);
    await db
      .pool("superuser")
      .query(
        "UPDATE app.backup_pair SET capture_started_at = now() - interval '2 hours 1 second' WHERE id = $1",
        [pairId],
      );
    const verified = await checkAndVerify(r, pairId);
    expect(verified.code).toBe(1);
    expect(await status(pairId)).toEqual({ status: "ineligible", reason: "deadline" });
    expect(storedKeys(r.storeRoot).filter((key) => key.endsWith("eligible.json"))).toEqual([]);
  }, 300_000);

  it("markEligible is refused for an ineligible pair", async () => {
    const r = newRun();
    const pairId = await capture(r);
    expect(await markIneligible(db.pool("maintenance"), pairId, "verification")).toBe(true);
    expect(
      await markEligible(db.pool("maintenance"), pairId, {
        objectKey: "x/",
        manifestSha256: "0".repeat(64),
        artifactHashes: {},
        eligibleUntil: new Date(),
      }),
    ).toBe(false);
    expect(await status(pairId)).toEqual({ status: "ineligible", reason: "verification" });
  }, 300_000);
});
