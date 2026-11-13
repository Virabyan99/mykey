// The keys of the auth module and of the API (D-19, Run 3.2). Each lives in its
// own file "<ring>.k<n>.key" holding 32 random bytes in base64url. A ring may
// hold several keys during a rotation; the key with the greatest number is the
// current one (k10 after k9: M15).
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface KeyRing {
  current: string;
  /** Key id → 32 bytes. */
  keys: Readonly<Record<string, Uint8Array>>;
}

/** Every ring, created at once on a host (`host.ts <host> keys init`) so later runs never touch custody again. */
export const KEY_RINGS = [
  "cookie",
  "session-lookup",
  "seed-encryption",
  "recovery-verifier",
  "rate-limit",
  "reset-verifier",
  "replay-fingerprint",
  "cursor-mac",
] as const;

export type RingName = (typeof KEY_RINGS)[number];

export interface AuthKeys {
  /** Better Auth's cookie-signing secret. */
  cookieSecret: string;
  /** HMAC key of the stored session verifier (P-26). */
  sessionLookup: KeyRing;
  /** Encryption key of the TOTP seed JWE. */
  seedEncryption: KeyRing;
  /** HMAC key of the recovery-code verifiers. */
  recoveryVerifier: KeyRing;
  /** HMAC key of the rate-limit counter keys (Run 3.3). */
  rateLimit: KeyRing;
  /** HMAC key of the reset-token verifiers (Run 3.6). */
  resetVerifier: KeyRing;
  /** HMAC key of the intent fingerprints of replayable operations (Run 3.9). */
  replayFingerprint: KeyRing;
  /** HMAC key of list cursors (Run 3.9). */
  cursorMac: KeyRing;
}

const KEY_FILE = /^([a-z-]+)\.(k[1-9][0-9]{0,8})\.key$/;
const KEY_BYTES = 32;

/** The key of `ring` with id `keyId`; throws for an unknown id. */
export function ringKey(ring: KeyRing, keyId: string = ring.current): Uint8Array {
  const key = ring.keys[keyId];
  if (key === undefined) {
    throw new Error(
      keyId === ring.current ? "the key ring has no current key" : `unknown key id ${keyId}`,
    );
  }
  return key;
}

const keyNumber = (id: string): number => Number(id.slice(1));

function isRing(name: string): name is RingName {
  return (KEY_RINGS as readonly string[]).includes(name);
}

/** The rings of the key files in `directory`; a `.key` file with any other name is an error naming it. */
function readRings(directory: string): Map<RingName, Record<string, Uint8Array>> {
  const found = new Map<RingName, Record<string, Uint8Array>>(KEY_RINGS.map((name) => [name, {}]));
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".key")) continue;
    const [, ringName = "", keyId = ""] = KEY_FILE.exec(file) ?? [];
    const ring = isRing(ringName) ? found.get(ringName) : undefined;
    if (ring === undefined || keyId === "") {
      throw new Error(`${file}: not a key file name (<ring>.k<number>.key)`);
    }
    const path = join(directory, file);
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      throw new Error(`${file}: a key file must be readable by its owner only (mode 0600)`);
    }
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
    if (key.length !== KEY_BYTES) throw new Error(`${file}: a key must be ${KEY_BYTES} bytes`);
    ring[keyId] = new Uint8Array(key);
  }
  return found;
}

export function loadAuthKeys(directory: string): AuthKeys {
  const found = readRings(directory);
  const ringOf = (name: RingName): KeyRing => {
    const keys = found.get(name) ?? {};
    const ids = Object.keys(keys).sort((a, b) => keyNumber(a) - keyNumber(b));
    const current = ids.at(-1);
    if (current === undefined) throw new Error(`no key for ring ${name} in ${directory}`);
    return { current, keys };
  };
  const cookie = ringOf("cookie");
  return {
    cookieSecret: Buffer.from(ringKey(cookie)).toString("base64url"),
    sessionLookup: ringOf("session-lookup"),
    seedEncryption: ringOf("seed-encryption"),
    recoveryVerifier: ringOf("recovery-verifier"),
    rateLimit: ringOf("rate-limit"),
    resetVerifier: ringOf("reset-verifier"),
    replayFingerprint: ringOf("replay-fingerprint"),
    cursorMac: ringOf("cursor-mac"),
  };
}

/**
 * Creates `<ring>.k1.key` (32 random bytes, base64url, mode 0600) for every
 * ring of `rings` that has no key file yet; existing files are never touched.
 * Returns the names of the files it created — never a value.
 */
export function generateKeyFiles(
  directory: string,
  rings: readonly string[] = KEY_RINGS,
): string[] {
  const present = readRings(directory);
  const created: string[] = [];
  for (const ring of rings) {
    if (!isRing(ring)) throw new Error(`unknown ring ${ring}`);
    if (Object.keys(present.get(ring) ?? {}).length > 0) continue;
    const name = `${ring}.k1.key`;
    writeFileSync(join(directory, name), randomBytes(KEY_BYTES).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
    created.push(name);
  }
  return created;
}

/** A complete set of fresh in-memory keys, for an instance whose keys are thrown away. */
export function ephemeralKeys(): AuthKeys {
  const ring = (): KeyRing => ({ current: "k1", keys: { k1: new Uint8Array(randomBytes(32)) } });
  return {
    cookieSecret: randomBytes(32).toString("base64url"),
    sessionLookup: ring(),
    seedEncryption: ring(),
    recoveryVerifier: ring(),
    rateLimit: ring(),
    resetVerifier: ring(),
    replayFingerprint: ring(),
    cursorMac: ring(),
  };
}
