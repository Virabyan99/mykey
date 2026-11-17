// Run 6.5 (P-119, D-52): the eligibility record is signed with the host's
// Ed25519 key over its canonical JSON. The public keys are committed under
// infra/hosts/backup/trust/<host>-<keyId>.pub: the trust anchor a restore
// checks against does not come from the bucket it is checking.
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eligibilitySchema, type Eligibility } from "./manifest.ts";

/**
 * JSON with object keys sorted at every depth and no whitespace. Refuses what
 * JSON cannot carry exactly: undefined, NaN, the infinities, and any object
 * that is not a plain object or an array (a Date would become a string).
 */
export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(canonical(value, "$"), "utf8");
}

function canonical(value: unknown, at: string): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: ${at} is not a finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonical(item, `${at}[${String(index)}]`)).join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner, `${at}.${key}`)}`)
      .join(",")}}`;
  }
  throw new Error(`canonicalJson: ${at} cannot be carried (${typeof value})`);
}

export function signEligibility(
  body: Omit<Eligibility, "signature">,
  key: KeyObject,
  keyId: string,
): Eligibility {
  const value = sign(null, canonicalJson(body), key).toString("base64");
  return { ...body, signature: { alg: "ed25519", keyId, value } };
}

export function verifyEligibility(
  record: Eligibility,
  trust: ReadonlyMap<string, KeyObject>,
): { ok: true } | { ok: false; cause: "unknown_key" | "signature" | "format" } {
  const parsed = eligibilitySchema.safeParse(record);
  if (!parsed.success) return { ok: false, cause: "format" };
  const { signature, ...body } = parsed.data;
  const key = trust.get(signature.keyId);
  if (key === undefined) return { ok: false, cause: "unknown_key" };
  const good = verify(null, canonicalJson(body), key, Buffer.from(signature.value, "base64"));
  return good ? { ok: true } : { ok: false, cause: "signature" };
}

/** The public keys of one host, by key id, from `<dir>/<host>-<keyId>.pub` (PEM, SPKI). */
export function loadTrust(directory: string, host: string): ReadonlyMap<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const prefix = `${host}-`;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(".pub")) continue;
    const keyId = name.slice(prefix.length, -".pub".length);
    if (!/^[A-Za-z0-9_]{1,64}$/.test(keyId)) continue;
    const key = createPublicKey(readFileSync(join(directory, name)));
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error(`trust: ${name} is not an Ed25519 key`);
    keys.set(keyId, key);
  }
  return keys;
}
