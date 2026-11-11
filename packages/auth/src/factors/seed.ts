// The TOTP seed at rest: 20 random bytes, stored only as a compact JWE
// (`dir`, `A256GCM`) whose protected header binds it to its user and its
// enrollment (D-19). The header is authenticated by GCM, so a ciphertext moved
// to another row does not decrypt there.
import { CompactEncrypt, compactDecrypt } from "jose";
import { ringKey, type KeyRing } from "../keys.ts";

export const SEED_BYTES = 20;
const PURPOSE = "totp-seed";

export interface SeedBinding {
  userId: string;
  enrollmentId: string;
}

export async function encryptSeed(
  ring: KeyRing,
  seed: Uint8Array,
  bind: SeedBinding,
): Promise<string> {
  if (seed.length !== SEED_BYTES) throw new Error(`a TOTP seed must be ${SEED_BYTES} bytes`);
  return new CompactEncrypt(seed)
    .setProtectedHeader({
      alg: "dir",
      enc: "A256GCM",
      kid: ring.current,
      purpose: PURPOSE,
      sub: bind.userId,
      enr: bind.enrollmentId,
    })
    .encrypt(ringKey(ring));
}

export async function decryptSeed(
  ring: KeyRing,
  jwe: string,
  bind: SeedBinding,
): Promise<Uint8Array> {
  const { plaintext, protectedHeader } = await compactDecrypt(
    jwe,
    (header) => {
      if (typeof header.kid !== "string") throw new Error("the seed has no key id");
      return ringKey(ring, header.kid);
    },
    { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] },
  );
  if (
    protectedHeader.purpose !== PURPOSE ||
    protectedHeader.sub !== bind.userId ||
    protectedHeader.enr !== bind.enrollmentId
  ) {
    throw new Error("the seed belongs to another user or enrollment");
  }
  if (plaintext.length !== SEED_BYTES) throw new Error("the seed has the wrong length");
  return plaintext;
}
