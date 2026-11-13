// The stored form of a reset token (Run 3.6, D-30): HMAC-SHA-256(reset key,
// token). The token itself is never stored. Used by the operator's initiation
// and by the API's completion, so it lives outside the operator entry point.
import { createHmac } from "node:crypto";
import { ringKey, type KeyRing } from "../keys.ts";

export function resetVerifier(ring: KeyRing, token: string, keyId: string = ring.current): Buffer {
  return createHmac("sha256", ringKey(ring, keyId)).update(token, "utf8").digest();
}
