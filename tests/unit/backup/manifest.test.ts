// Run 6.5 Task C (P-119, D-52): the manifest of a pair, format mykey-pair/1.
// Exactly three artifacts; nothing in it is a secret: the backup password is
// named by reference (`<host>/<n>`), never carried.
import { randomUUID } from "node:crypto";
import {
  ARTIFACT_NAMES,
  PAIR_FORMAT,
  artifactsMatch,
  eligibilitySchema,
  pairManifestSchema,
  type PairManifest,
} from "@mykey/backup";
import { describe, expect, it } from "vitest";

function manifest(): PairManifest {
  return {
    format: PAIR_FORMAT,
    pairId: randomUUID(),
    host: "staging",
    hostInstanceId: randomUUID(),
    backendIncarnation: randomUUID(),
    captureStartedAt: "2026-11-17T03:00:01.000Z",
    boundary: { lastOperationId: null, executingOperations: 0, heldEffectSlots: 0 },
    schemaRevision: "0017_capture_barrier",
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

/** Every key of a value, at every depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
  }
  return [];
}

describe("the pair manifest", () => {
  it("accepts a whole manifest", () => {
    expect(pairManifestSchema.safeParse(manifest()).success).toBe(true);
    expect(ARTIFACT_NAMES).toEqual(["postgres.dump", "globals.sql", "openbao.snap"]);
  });

  it("refuses a fourth artifact, a missing one, a repeated one and a sha256 of the wrong length", () => {
    const fourth = manifest();
    fourth.artifacts.push({ name: "postgres.dump", bytes: 1, sha256: "d".repeat(64) });
    expect(pairManifestSchema.safeParse(fourth).success).toBe(false);
    const missing = manifest();
    missing.artifacts.pop();
    expect(pairManifestSchema.safeParse(missing).success).toBe(false);
    const repeated = manifest();
    repeated.artifacts[2] = { name: "globals.sql", bytes: 12, sha256: "c".repeat(64) };
    expect(pairManifestSchema.safeParse(repeated).success).toBe(false);
    const short = manifest();
    short.artifacts[0]!.sha256 = "a".repeat(63);
    expect(pairManifestSchema.safeParse(short).success).toBe(false);
  });

  it("refuses a boundary with an executing operation or a held slot, and an unknown field", () => {
    const executing = manifest();
    (executing.boundary as { executingOperations: number }).executingOperations = 1;
    expect(pairManifestSchema.safeParse(executing).success).toBe(false);
    const extra = { ...manifest(), password: "x" };
    expect(pairManifestSchema.safeParse(extra).success).toBe(false);
  });

  it("no field name looks like a secret but backupPassword, whose value is a reference", () => {
    const names = keysOf(manifest()).filter((key) => /password|secret|token|private/i.test(key));
    expect(names).toEqual(["backupPassword"]);
    const literal = manifest();
    literal.keyRefs.backupPassword = "correct horse battery staple";
    expect(pairManifestSchema.safeParse(literal).success).toBe(false);
  });

  it("artifactsMatch compares a listing with the manifest: missing, changed and extra files", () => {
    const m = manifest();
    const listing = Object.fromEntries(
      m.artifacts.map((a) => [a.name, { bytes: a.bytes, sha256: a.sha256 }]),
    );
    expect(artifactsMatch(m, listing)).toEqual({ ok: true, problems: [] });
    expect(
      artifactsMatch(m, { ...listing, "globals.sql": { bytes: 11, sha256: "e".repeat(64) } }),
    ).toEqual({ ok: false, problems: ["changed: globals.sql"] });
    const rest = { ...listing };
    delete rest["openbao.snap"];
    expect(artifactsMatch(m, { ...rest, "x.bin": { bytes: 1, sha256: "f".repeat(64) } })).toEqual({
      ok: false,
      problems: ["missing: openbao.snap", "extra: x.bin"],
    });
  });

  it("an eligibility record carries the manifest, the verification and a 30-day window", () => {
    const record = {
      manifest: manifest(),
      verification: {
        bundleSha256: "d".repeat(64),
        downloadedSha256: "d".repeat(64),
        resticCheck: "read-data",
        verifiedAt: "2026-11-17T03:04:00.000Z",
      },
      eligibleUntil: "2026-12-17T03:00:01.000Z",
      signature: { alg: "ed25519", keyId: "k1", value: "AAAA" },
    };
    expect(eligibilitySchema.safeParse(record).success).toBe(true);
    expect(
      eligibilitySchema.safeParse({
        ...record,
        verification: { ...record.verification, downloadedSha256: "e".repeat(64) },
      }).success,
      "a download that differs from the upload is no verification",
    ).toBe(false);
  });
});
