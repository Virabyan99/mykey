// `ops pair --step manifest|upload|verify --pair <id>` (Run 6.5, P-119, D-52):
// the pair's steps that need the database, the bucket or the signing key, run
// by backup.sh in the ops image. Each works in <pairScratch>/<pairId>/:
//
//   manifest  begin.json + facts + artifacts/ → manifest.json (mykey-pair/1)
//   upload    bundle.tar → pairs/<host>/<captureUtc>-<pairId>/bundle.tar, read
//             back into downloaded.tar; upload.json holds both digests. A
//             read-back that differs exits 1 (the pair stays a candidate).
//   verify    the read-back copy, Restic's check of it (check.status,
//             check.log) and its restored artifacts (restore/out/artifacts)
//             must all agree with the manifest; then, with the pair's row
//             locked, eligible.json is signed and written and the pair is
//             eligible — or it is ineligible (deadline, access_reduction).
//
// `ops pair --step retention [--delete-orphans <prefix>]` (Run 6.6, P-121,
// D-53): run daily by mykey-pair-retention. Plans and applies retention for
// the host. Exit 1 when a delete claimed a key that is still there, or when an
// object stays refused three days after its lock should have ended.
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ARTIFACT_NAMES,
  ELIGIBLE_DAYS,
  PAIR_FORMAT,
  artifactsMatch,
  canonicalJson,
  lockEndsAt,
  pairIdOf,
  planRetention,
  pairManifestSchema,
  pairPrefix,
  signEligibility,
  type PairManifest,
} from "@mykey/backup";
import { LIMITS } from "@mykey/contracts";
import { createPool, listPairs } from "@mykey/db";
import { applyRetention, settlePair } from "@mykey/operations/operator";
import { EXIT, type OpsCommand, type OpsIo } from "../cli.ts";

const STEPS = ["manifest", "upload", "verify", "retention"] as const;
/** A refusal this long after the lock should have ended is an alert, not patience. */
const REFUSAL_GRACE_MS = 3 * 86_400_000;
const ORPHAN_PREFIX = /^pairs\/[a-z0-9-]+\/[^/]+\/$/;
type Step = (typeof STEPS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FACT_KEYS = [
  "host_instance_id",
  "backend_incarnation",
  "release_build",
  "kms_key_id",
  "seal_name",
  "tool_openbao",
  "tool_postgres",
  "tool_restic",
] as const;

class Refused extends Error {}

async function fileDigest(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function listing(
  directory: string,
): Promise<Record<string, { bytes: number; sha256: string }>> {
  const result: Record<string, { bytes: number; sha256: string }> = {};
  for (const name of readdirSync(directory)) result[name] = await fileDigest(join(directory, name));
  return result;
}

function readFacts(path: string): Record<(typeof FACT_KEYS)[number], string> {
  const facts: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([a-z_]+)=([A-Za-z0-9._:@/+-]{1,200})$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) facts[match[1]] = match[2];
  }
  for (const key of FACT_KEYS) {
    if (facts[key] === undefined) throw new Refused(`facts: ${key} is missing or malformed`);
  }
  return facts;
}

function readManifest(dir: string): PairManifest {
  return pairManifestSchema.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
}

async function manifestStep(io: OpsIo, dir: string, pairId: string): Promise<void> {
  const pairs = io.env.pairs;
  if (pairs === undefined || io.env.database === undefined) throw new Refused("not configured");
  const begun = JSON.parse(readFileSync(join(dir, "begin.json"), "utf8")) as {
    pairId: string;
    captureStartedAt: string;
    boundary: PairManifest["boundary"];
  };
  if (begun.pairId !== pairId) throw new Refused("begin.json names another pair");
  const facts = readFacts(join(dir, "facts"));
  const found = await listing(join(dir, "artifacts"));
  const pool = createPool(io.env.database, { max: 1 });
  let schemaRevision: string;
  try {
    const latest = await pool.query<{ name: string }>(
      "SELECT name FROM meta.schema_migration ORDER BY name DESC LIMIT 1",
    );
    schemaRevision = (latest.rows[0]?.name ?? "").replace(/\.sql$/, "");
  } finally {
    await pool.end();
  }
  const parsed = pairManifestSchema.safeParse({
    format: PAIR_FORMAT,
    pairId,
    host: pairs.host,
    hostInstanceId: facts.host_instance_id,
    backendIncarnation: facts.backend_incarnation,
    captureStartedAt: begun.captureStartedAt,
    boundary: begun.boundary,
    schemaRevision,
    releaseBuild: facts.release_build,
    artifacts: ARTIFACT_NAMES.map((name) => {
      const artifact = found[name];
      if (artifact === undefined) throw new Refused(`artifacts: ${name} is missing`);
      return { name, ...artifact };
    }),
    keyRefs: {
      kmsKeyId: facts.kms_key_id,
      sealName: facts.seal_name,
      backupPassword: `${pairs.host}/1`,
      signingKeyId:
        pairs.signing?.keyId ??
        ((): never => {
          throw new Refused("manifest: no signing key (MYKEY_PAIR_SIGNER)");
        })(),
    },
    tools: {
      postgres: facts.tool_postgres,
      openbao: facts.tool_openbao,
      restic: facts.tool_restic,
    },
  });
  if (!parsed.success) {
    throw new Refused(`manifest: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const extra = Object.keys(found).filter(
    (name) => !(ARTIFACT_NAMES as readonly string[]).includes(name),
  );
  if (extra.length > 0) throw new Refused(`artifacts: unexpected ${extra.join(", ")}`);
  writeFileSync(join(dir, "manifest.json"), canonicalJson(parsed.data));
  io.stdout.write(`manifest ${pairId}\n`);
}

async function uploadStep(io: OpsIo, dir: string, pairId: string): Promise<void> {
  const pairs = io.env.pairs;
  if (pairs === undefined) throw new Refused("not configured");
  const manifest = readManifest(dir);
  if (manifest.pairId !== pairId) throw new Refused("manifest.json names another pair");
  const bundle = join(dir, "bundle.tar");
  const sent = await fileDigest(bundle);
  const key = `${pairPrefix(manifest)}bundle.tar`;
  await pairs.store.put(key, createReadStream(bundle), sent);
  // Read back what the bucket holds, into the copy that is checked and restored.
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    await pairs.store.get(key),
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        bytes += chunk.length;
        done(null, chunk);
      },
    }),
    createWriteStream(join(dir, "downloaded.tar")),
  );
  const downloaded = hash.digest("hex");
  writeFileSync(
    join(dir, "upload.json"),
    JSON.stringify({ key, bundleSha256: sent.sha256, downloadedSha256: downloaded, bytes }),
  );
  if (downloaded !== sent.sha256 || bytes !== sent.bytes) {
    throw new Refused("upload: the bundle read back differs from the one sent");
  }
  io.stdout.write(`uploaded ${pairId} (${String(sent.bytes)} bytes)\n`);
}

async function verifyStep(io: OpsIo, dir: string, pairId: string): Promise<boolean> {
  const pairs = io.env.pairs;
  if (pairs === undefined || io.env.database === undefined) throw new Refused("not configured");
  const signing = pairs.signing;
  if (signing === undefined) throw new Refused("verify: no signing key (MYKEY_PAIR_SIGNER)");
  const manifest = readManifest(dir);
  if (manifest.pairId !== pairId) throw new Refused("manifest.json names another pair");
  const uploaded = JSON.parse(readFileSync(join(dir, "upload.json"), "utf8")) as {
    key: string;
    bundleSha256: string;
    downloadedSha256: string;
  };
  const copy = await fileDigest(join(dir, "downloaded.tar"));
  if (
    copy.sha256 !== uploaded.bundleSha256 ||
    uploaded.downloadedSha256 !== uploaded.bundleSha256
  ) {
    throw new Refused("verify: the read-back copy differs from the bundle sent");
  }
  const checkStatus = existsSync(join(dir, "check.status"))
    ? readFileSync(join(dir, "check.status"), "utf8").trim()
    : "";
  const checkLog = existsSync(join(dir, "check.log"))
    ? readFileSync(join(dir, "check.log"), "utf8")
    : "";
  if (checkStatus !== "0" || !checkLog.includes("no errors were found")) {
    throw new Refused("verify: restic check --read-data did not pass");
  }
  const restored = artifactsMatch(
    manifest,
    await listing(join(dir, "restore", "out", "artifacts")),
  );
  if (!restored.ok)
    throw new Refused(`verify: restored artifacts: ${restored.problems.join(", ")}`);

  const prefix = pairPrefix(manifest);
  const pool = createPool(io.env.database, { max: LIMITS.db.opsPool });
  try {
    const settled = await settlePair(pool, pairId, async ({ captureStartedAt }) => {
      const eligibleUntil = new Date(captureStartedAt.getTime() + ELIGIBLE_DAYS * 86_400_000);
      const record = signEligibility(
        {
          manifest,
          verification: {
            bundleSha256: uploaded.bundleSha256,
            downloadedSha256: copy.sha256,
            resticCheck: "read-data",
            verifiedAt: new Date().toISOString(),
          },
          eligibleUntil: eligibleUntil.toISOString(),
        },
        signing.key,
        signing.keyId,
      );
      const body = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await pairs.store.put(`${prefix}eligible.json`, body, {
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      });
      return {
        objectKey: prefix,
        manifestSha256: createHash("sha256").update(canonicalJson(manifest)).digest("hex"),
        artifactHashes: Object.fromEntries(manifest.artifacts.map((a) => [a.name, a.sha256])),
        eligibleUntil,
      };
    });
    if (settled.kind === "eligible") {
      io.stdout.write(`eligible ${pairId}\n`);
      return true;
    }
    if (settled.kind === "ineligible") {
      io.stdout.write(`ineligible ${pairId} (${settled.reason})\n`);
      // A pair crossed by an access reduction is the barrier working; a missed
      // deadline is a failed job.
      return settled.reason === "access_reduction";
    }
    io.stderr.write(`verify: pair ${pairId} is ${settled.status}, not a candidate\n`);
    return false;
  } finally {
    await pool.end();
  }
}

async function retentionStep(io: OpsIo, deleteOrphans: string | undefined): Promise<boolean> {
  const pairs = io.env.pairs;
  if (pairs === undefined || io.env.database === undefined) throw new Refused("not configured");
  const { store, host } = pairs;
  const pool = createPool(io.env.database, { max: LIMITS.db.opsPool });
  try {
    const now = new Date();
    const rows = await listPairs(pool, host);
    const objects = await store.list(`pairs/${host}/`);
    if (deleteOrphans !== undefined) {
      const plan = planRetention(rows, objects, host, now);
      if (!ORPHAN_PREFIX.test(deleteOrphans) || !plan.orphans.includes(deleteOrphans)) {
        throw new Refused(`retention: ${deleteOrphans} is not an orphan of ${host}`);
      }
      const keys = objects.filter((o) => o.key.startsWith(deleteOrphans)).map((o) => o.key);
      const outcomes = await store.deleteChecked(keys);
      let ok = true;
      for (const o of outcomes) {
        if (!o.deleted || (await store.head(o.key)) !== null) {
          io.stderr.write(`retention: ${o.key} not deleted (${o.errorCode ?? "still present"})\n`);
          ok = false;
        }
      }
      io.stdout.write(`orphan ${deleteOrphans}: ${String(keys.length)} object(s)\n`);
      return ok;
    }
    const plan = planRetention(rows, objects, host, now);
    const result = await applyRetention({ pool, store, host, now: () => now }, plan);
    for (const id of result.expired) io.stdout.write(`ineligible ${id} (deadline)\n`);
    for (const id of result.closed) io.stdout.write(`expired ${id}\n`);
    for (const orphan of plan.orphans) io.stdout.write(`orphan ${orphan} (not deleted)\n`);
    io.stdout.write(
      result.deleted.length === 0 && result.closed.length === 0
        ? `retention ${host}: nothing to delete (${String(plan.keep.length)} kept)\n`
        : `retention ${host}: ${String(result.deleted.length)} object(s) deleted, ${String(plan.keep.length)} pair(s) kept\n`,
    );
    let ok = true;
    for (const key of result.stillPresent) {
      io.stderr.write(`retention: ${key} still present after a delete that answered success\n`);
      ok = false;
    }
    for (const { key, code } of result.refused) {
      const row = rows.find((r) => r.id === pairIdOf(key));
      const overdue =
        row !== undefined && now.getTime() > lockEndsAt(row).getTime() + REFUSAL_GRACE_MS;
      io.stderr.write(
        `retention: ${key} refused (${code})${overdue ? ", 3 days after its lock" : ""}\n`,
      );
      if (overdue) ok = false;
    }
    if (result.uploadsAborted > 0) {
      io.stdout.write(`aborted ${String(result.uploadsAborted)} stale upload(s)\n`);
    }
    return ok;
  } finally {
    await pool.end();
  }
}

export const pairCommand: OpsCommand = {
  flags: ["step", "pair", "delete-orphans"],
  summary:
    "a pair after its capture: --step manifest|upload|verify --pair <id>; retention: --step retention [--delete-orphans <prefix>]",
  async run(flags, io) {
    const step = flags.step as Step | undefined;
    const pairId = flags.pair;
    if (step === "retention") {
      try {
        return (await retentionStep(io, flags["delete-orphans"])) ? EXIT.ok : EXIT.failed;
      } catch (error) {
        io.stderr.write(
          error instanceof Refused
            ? `${error.message}\n`
            : `pair retention failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
        );
        return EXIT.failed;
      }
    }
    if (step === undefined || !STEPS.includes(step) || pairId === undefined || !UUID.test(pairId)) {
      io.stderr.write("pair: --step manifest|upload|verify --pair <uuid>, or --step retention\n");
      return EXIT.usage;
    }
    if (io.env.pairScratch === undefined || io.env.pairs === undefined) {
      io.stderr.write("pair: runs as a host job (backup.sh)\n");
      return EXIT.failed;
    }
    const dir = join(io.env.pairScratch, pairId);
    try {
      if (step === "manifest") await manifestStep(io, dir, pairId);
      else if (step === "upload") await uploadStep(io, dir, pairId);
      else return (await verifyStep(io, dir, pairId)) ? EXIT.ok : EXIT.failed;
      return EXIT.ok;
    } catch (error) {
      io.stderr.write(
        error instanceof Refused
          ? `${error.message}\n`
          : `pair ${step} failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    }
  },
};
