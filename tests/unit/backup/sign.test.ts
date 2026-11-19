// Run 6.5 Task C (P-119, D-52): the eligibility record of a pair is signed
// with the host's Ed25519 key over its canonical JSON; the public key is
// committed under infra/hosts/backup/trust/ (the independent trust anchor).
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  loadTrust,
  signEligibility,
  verifyEligibility,
  type Eligibility,
  type PairManifest,
} from "@mykey/backup";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function manifest(): PairManifest {
  return {
    format: "mykey-pair/1",
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

function body(): Omit<Eligibility, "signature"> {
  return {
    manifest: manifest(),
    verification: {
      bundleSha256: "d".repeat(64),
      downloadedSha256: "d".repeat(64),
      resticCheck: "read-data",
      verifiedAt: "2026-11-17T03:04:00.000Z",
    },
    eligibleUntil: "2026-12-17T03:00:01.000Z",
  };
}

function trustDir(host: string, keys: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "mykey-trust-"));
  directories.push(directory);
  for (const [keyId, pem] of Object.entries(keys)) {
    writeFileSync(join(directory, `${host}-${keyId}.pub`), pem);
  }
  return directory;
}

const pair = () => generateKeyPairSync("ed25519");
const pem = (key: ReturnType<typeof pair>["publicKey"]) =>
  key.export({ format: "pem", type: "spki" }).toString();

describe("canonicalJson", () => {
  it("is stable under key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: "s" } }).toString()).toBe(
      canonicalJson({ a: { c: "s", d: [1, { x: 1, y: 2 }] }, b: 1 }).toString(),
    );
    expect(canonicalJson({ b: 1, a: 2 }).toString()).toBe('{"a":2,"b":1}');
  });

  it("rejects NaN, undefined and a Date", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: new Date() })).toThrow();
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow();
  });
});

describe("the signature", () => {
  it("verifies with the right key", () => {
    const keys = pair();
    const signed = signEligibility(body(), keys.privateKey, "k1");
    expect(signed.signature.alg).toBe("ed25519");
    expect(
      verifyEligibility(
        signed,
        loadTrust(trustDir("staging", { k1: pem(keys.publicKey) }), "staging"),
      ),
    ).toEqual({ ok: true });
  });

  it("fails after one changed byte of the manifest", () => {
    const keys = pair();
    const signed = signEligibility(body(), keys.privateKey, "k1");
    const trust = loadTrust(trustDir("staging", { k1: pem(keys.publicKey) }), "staging");
    const changed = structuredClone(signed);
    changed.manifest.artifacts[0]!.bytes += 1;
    expect(verifyEligibility(changed, trust)).toEqual({ ok: false, cause: "signature" });
    const renamed = structuredClone(signed);
    renamed.manifest.releaseBuild = "c5c037e41947";
    expect(verifyEligibility(renamed, trust)).toEqual({ ok: false, cause: "signature" });
  });

  it("fails with another key", () => {
    const signed = signEligibility(body(), pair().privateKey, "k1");
    const trust = loadTrust(trustDir("staging", { k1: pem(pair().publicKey) }), "staging");
    expect(verifyEligibility(signed, trust)).toEqual({ ok: false, cause: "signature" });
  });

  it("fails with a key id that is not in the trust directory, or another host's", () => {
    const keys = pair();
    const signed = signEligibility(body(), keys.privateKey, "k2");
    expect(
      verifyEligibility(
        signed,
        loadTrust(trustDir("staging", { k1: pem(keys.publicKey) }), "staging"),
      ),
    ).toEqual({ ok: false, cause: "unknown_key" });
    expect(
      verifyEligibility(
        signed,
        loadTrust(trustDir("prod", { k2: pem(keys.publicKey) }), "staging"),
      ),
    ).toEqual({ ok: false, cause: "unknown_key" });
  });

  it("refuses a record that is not an eligibility record", () => {
    const keys = pair();
    const trust = loadTrust(trustDir("staging", { k1: pem(keys.publicKey) }), "staging");
    const signed = signEligibility(body(), keys.privateKey, "k1");
    const broken = { ...signed, eligibleUntil: 5 } as unknown as Eligibility;
    expect(verifyEligibility(broken, trust)).toEqual({ ok: false, cause: "format" });
  });
});
