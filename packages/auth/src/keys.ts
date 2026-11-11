// The keys of the auth module (D-19). Each lives in its own file
// "<ring>.<keyId>.key" holding 32 random bytes in base64url. A ring may hold
// several keys during a rotation; the greatest key id is the current one.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface KeyRing {
  current: string;
  /** Key id → 32 bytes. */
  keys: Readonly<Record<string, Uint8Array>>;
}

export interface AuthKeys {
  /** Better Auth's cookie-signing secret. */
  cookieSecret: string;
  /** HMAC key of the stored session verifier (P-26). */
  sessionLookup: KeyRing;
  /** Encryption key of the TOTP seed JWE. */
  seedEncryption: KeyRing;
  /** HMAC key of the recovery-code verifiers. */
  recoveryVerifier: KeyRing;
}

const RINGS = ["cookie", "session-lookup", "seed-encryption", "recovery-verifier"] as const;
type RingName = (typeof RINGS)[number];
const KEY_FILE = /^([a-z-]+)\.([A-Za-z0-9_-]{1,32})\.key$/;
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

export function loadAuthKeys(directory: string): AuthKeys {
  const found = new Map<RingName, Record<string, Uint8Array>>(RINGS.map((name) => [name, {}]));
  for (const file of readdirSync(directory)) {
    const match = KEY_FILE.exec(file);
    if (match === null) continue;
    const [, ringName, keyId] = match as unknown as [string, string, string];
    const ring = found.get(ringName as RingName);
    if (ring === undefined) continue;
    const path = join(directory, file);
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      throw new Error(`${file}: a key file must be readable by its owner only (mode 0600)`);
    }
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
    if (key.length !== KEY_BYTES) throw new Error(`${file}: a key must be ${KEY_BYTES} bytes`);
    ring[keyId] = new Uint8Array(key);
  }
  const ringOf = (name: RingName): KeyRing => {
    const keys = found.get(name) ?? {};
    const ids = Object.keys(keys).sort();
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
  };
}
