// What the database stores in place of a session token (P-26):
// "v1.<keyId>.<base64url(HMAC-SHA-256(lookup key, raw token))>". There is no
// ciphertext copy; a stored row cannot be turned back into a usable token.
import { createHmac } from "node:crypto";
import { ringKey, type KeyRing } from "./keys.ts";

export function sessionVerifier(ring: KeyRing, rawToken: string, keyId?: string): string {
  if (rawToken === "") throw new Error("a session token must not be empty");
  const id = keyId ?? ring.current;
  const mac = createHmac("sha256", ringKey(ring, id)).update(rawToken, "utf8").digest("base64url");
  return `v1.${id}.${mac}`;
}

/** One verifier per key of the ring, the current key first: the values a lookup may match. */
export function sessionVerifierCandidates(ring: KeyRing, rawToken: string): string[] {
  ringKey(ring);
  const others = Object.keys(ring.keys)
    .filter((id) => id !== ring.current)
    .sort();
  return [ring.current, ...others].map((id) => sessionVerifier(ring, rawToken, id));
}
