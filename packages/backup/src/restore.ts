// Run 6.7 Task B (P-124 steps 2 and 3, D-55): what a restore checks before it
// writes anything. A pair exists for a restore only with a signed
// eligible.json the trust anchor verifies, and its bundle.tar must be the very
// bundle that was verified (its SHA-256 is in the signed record). The KMS key
// the pair's OpenBao half is sealed with must be usable on this host (PO-22).
// globals.sql is read and compared with the inventory of roles, never executed:
// a role nobody listed stops the restore with its name.
import type { KeyObject } from "node:crypto";
import type { Readable } from "node:stream";
import { eligibilitySchema, pairPrefix, type Eligibility, type PairManifest } from "./manifest.ts";
import { verifyEligibility } from "./sign.ts";
import { bytesOf, type ObjectStore } from "./store.ts";

export interface Refusal {
  ok: false;
  cause: string;
}

/**
 * Reads `<prefix>eligible.json`, verifies it, then streams `<prefix>bundle.tar`
 * into `sink` (which answers the digest of what it wrote) and compares.
 */
export async function fetchEligiblePair(
  store: ObjectStore,
  prefix: string,
  trust: ReadonlyMap<string, KeyObject>,
  sink: (bundle: Readable) => Promise<{ sha256: string; bytes: number }>,
): Promise<{ ok: true; eligibility: Eligibility } | Refusal> {
  if ((await store.head(`${prefix}eligible.json`)) === null) {
    return { ok: false, cause: "no eligible.json: the pair was never verified" };
  }
  let record: unknown;
  try {
    record = JSON.parse(
      (await bytesOf(await store.get(`${prefix}eligible.json`))).toString("utf8"),
    );
  } catch {
    return { ok: false, cause: "eligible.json: format" };
  }
  const verified = verifyEligibility(record as Eligibility, trust);
  if (!verified.ok) return { ok: false, cause: `eligible.json: ${verified.cause}` };
  const eligibility = eligibilitySchema.parse(record);
  if (pairPrefix(eligibility.manifest) !== prefix) {
    return { ok: false, cause: "eligible.json names another pair" };
  }
  const written = await sink(await store.get(`${prefix}bundle.tar`));
  if (written.sha256 !== eligibility.verification.bundleSha256) {
    return { ok: false, cause: "bundle.tar is not the bundle that was verified" };
  }
  return { ok: true, eligibility };
}

/** The newest prefix of `pairs/<host>/` that holds an eligible.json, or null. */
export async function newestEligiblePrefix(
  store: ObjectStore,
  host: string,
): Promise<string | null> {
  const prefixes = (await store.list(`pairs/${host}/`))
    .map((o) => o.key)
    .filter((key) => key.endsWith("/eligible.json"))
    .map((key) => key.slice(0, -"eligible.json".length))
    .sort();
  return prefixes.at(-1) ?? null;
}

/** PO-22: the pair's KMS key must be usable here before anything is written. */
export async function preflightKms(
  manifest: PairManifest,
  probe: (kmsKeyId: string) => Promise<boolean>,
): Promise<{ ok: true } | Refusal> {
  const usable = await probe(manifest.keyRefs.kmsKeyId).catch(() => false);
  return usable
    ? { ok: true }
    : {
        ok: false,
        cause: `the pair's KMS key ${manifest.keyRefs.kmsKeyId} is not usable on this host`,
      };
}

/** The roles `CREATE ROLE` statements of globals.sql name that `known` does not hold, in order. */
export function globalsUnknownRoles(sql: string, known: readonly string[]): string[] {
  const unknown: string[] = [];
  for (const match of sql.matchAll(/^CREATE ROLE\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)/gm)) {
    const raw = match[1] ?? "";
    const name = raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
    if (!known.includes(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}
