// Run 6.7 Task B (P-124 steps 2 and 3, D-55): what a restore refuses before it
// writes anything — a pair that was never made eligible, one signed by a key
// the trust anchor does not hold, a bundle that is not the verified one, a
// manifest whose KMS key this host cannot use — and globals.sql, compared with
// the inventory of roles and never executed.
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  directoryStore,
  fetchEligiblePair,
  globalsUnknownRoles,
  newestEligiblePrefix,
  pairPrefix,
  preflightKms,
  signEligibility,
  type ObjectStore,
  type PairManifest,
} from "@mykey/backup";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function manifest(captureStartedAt = "2026-11-17T03:00:01.000Z"): PairManifest {
  return {
    format: "mykey-pair/1",
    pairId: randomUUID(),
    host: "staging",
    hostInstanceId: randomUUID(),
    backendIncarnation: randomUUID(),
    captureStartedAt,
    boundary: { lastOperationId: null, executingOperations: 0, heldEffectSlots: 0 },
    schemaRevision: "0018_incarnation",
    releaseBuild: "c5c037e41946",
    artifacts: [
      { name: "postgres.dump", bytes: 10, sha256: "a".repeat(64) },
      { name: "globals.sql", bytes: 11, sha256: "b".repeat(64) },
      { name: "openbao.snap", bytes: 12, sha256: "c".repeat(64) },
    ],
    keyRefs: {
      kmsKeyId: "kms-key-1",
      sealName: "staging-seal",
      backupPassword: "staging/1",
      signingKeyId: "k1",
    },
    tools: { postgres: "18", openbao: "2.7.2", restic: "0.19.1" },
  };
}

const put = (store: ObjectStore, key: string, body: Buffer) =>
  store.put(key, body, { bytes: body.length, sha256: sha(body) });

/** A pair in a directory store: bundle.tar and (unless told) a signed eligible.json. */
async function storedPair(opts: {
  signer: KeyObject;
  keyId?: string;
  eligible?: boolean;
  captureStartedAt?: string;
  store?: ObjectStore;
}) {
  const root = mkdtempSync(join(tmpdir(), "mykey-restore-"));
  directories.push(root);
  const store = opts.store ?? directoryStore(root);
  const m = manifest(opts.captureStartedAt);
  const prefix = pairPrefix(m);
  const bundle = Buffer.from(`bundle of ${m.pairId}`);
  await put(store, `${prefix}bundle.tar`, bundle);
  if (opts.eligible !== false) {
    const record = signEligibility(
      {
        manifest: m,
        verification: {
          bundleSha256: sha(bundle),
          downloadedSha256: sha(bundle),
          resticCheck: "read-data",
          verifiedAt: "2026-11-17T03:04:00.000Z",
        },
        eligibleUntil: "2026-12-17T03:00:01.000Z",
      },
      opts.signer,
      opts.keyId ?? "k1",
    );
    await put(store, `${prefix}eligible.json`, Buffer.from(JSON.stringify(record)));
  }
  return { store, prefix, manifest: m, bundle };
}

const keys = () => generateKeyPairSync("ed25519");
const sink = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const all = Buffer.concat(chunks);
  return { sha256: sha(all), bytes: all.length };
};

describe("fetchEligiblePair (P-124 step 2)", () => {
  it("a signed pair whose bundle is the verified one is accepted", async () => {
    const k = keys();
    const p = await storedPair({ signer: k.privateKey });
    const result = await fetchEligiblePair(p.store, p.prefix, new Map([["k1", k.publicKey]]), sink);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.eligibility.manifest.pairId).toBe(p.manifest.pairId);
  });

  it("a bundle with one changed byte is refused with its cause", async () => {
    const k = keys();
    const p = await storedPair({ signer: k.privateKey });
    const changed = Buffer.from(p.bundle);
    changed[0] = (changed[0] ?? 0) ^ 1;
    await put(p.store, `${p.prefix}bundle.tar`, changed);
    expect(
      await fetchEligiblePair(p.store, p.prefix, new Map([["k1", k.publicKey]]), sink),
    ).toEqual({
      ok: false,
      cause: "bundle.tar is not the bundle that was verified",
    });
  });

  it("an eligible.json signed by an unknown key is refused with its cause", async () => {
    const k = keys();
    const other = keys();
    const p = await storedPair({ signer: other.privateKey, keyId: "k9" });
    expect(
      await fetchEligiblePair(p.store, p.prefix, new Map([["k1", k.publicKey]]), sink),
    ).toEqual({
      ok: false,
      cause: "eligible.json: unknown_key",
    });
    const forged = await storedPair({ signer: other.privateKey, keyId: "k1" });
    expect(
      await fetchEligiblePair(forged.store, forged.prefix, new Map([["k1", k.publicKey]]), sink),
    ).toEqual({ ok: false, cause: "eligible.json: signature" });
  });

  it("a prefix without eligible.json is refused with its cause", async () => {
    const k = keys();
    const p = await storedPair({ signer: k.privateKey, eligible: false });
    expect(
      await fetchEligiblePair(p.store, p.prefix, new Map([["k1", k.publicKey]]), sink),
    ).toEqual({
      ok: false,
      cause: "no eligible.json: the pair was never verified",
    });
  });

  it("the newest eligible pair of a host is chosen; a newer one without eligible.json is not", async () => {
    const k = keys();
    const older = await storedPair({
      signer: k.privateKey,
      captureStartedAt: "2026-11-15T03:00:01.000Z",
    });
    const newer = await storedPair({
      signer: k.privateKey,
      captureStartedAt: "2026-11-16T03:00:01.000Z",
      store: older.store,
    });
    await storedPair({
      signer: k.privateKey,
      captureStartedAt: "2026-11-17T03:00:01.000Z",
      eligible: false,
      store: older.store,
    });
    expect(await newestEligiblePrefix(older.store, "staging")).toBe(newer.prefix);
    expect(await newestEligiblePrefix(older.store, "drill")).toBeNull();
  });
});

describe("preflightKms (P-124 step 2, PO-22)", () => {
  it("a manifest whose KMS key is not usable here stops the restore, naming the key", async () => {
    const m = manifest();
    expect(await preflightKms(m, () => Promise.resolve(true))).toEqual({ ok: true });
    expect(await preflightKms(m, () => Promise.resolve(false))).toEqual({
      ok: false,
      cause: "the pair's KMS key kms-key-1 is not usable on this host",
    });
    expect(await preflightKms(m, () => Promise.reject(new Error("unreachable")))).toEqual({
      ok: false,
      cause: "the pair's KMS key kms-key-1 is not usable on this host",
    });
  });
});

describe("globalsUnknownRoles (P-124 step 3)", () => {
  const known = ["postgres", "migration_owner", "api_runtime", "provisioner_runtime"];
  it("names every role globals.sql creates that the inventory does not hold", () => {
    const sql = [
      "--",
      "-- PostgreSQL database cluster dump",
      "CREATE ROLE api_runtime;",
      "ALTER ROLE api_runtime WITH NOSUPERUSER INHERIT NOCREATEROLE LOGIN PASSWORD 'SCRAM-SHA-256$x';",
      'CREATE ROLE "intruder";',
      "CREATE ROLE postgres;",
      "CREATE ROLE helper WITH LOGIN;",
    ].join("\n");
    expect(globalsUnknownRoles(sql, known)).toEqual(["intruder", "helper"]);
    expect(globalsUnknownRoles("CREATE ROLE migration_owner;\n", known)).toEqual([]);
  });
});
