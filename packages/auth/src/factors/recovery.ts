// Recovery codes (D-19): LIMITS.recovery.codeCount codes of 20 symbols from a
// 32-symbol alphabet (100 bits each), shown as four groups of five. Only
// HMAC-SHA-256(recovery key, enrollmentId || code) is stored.
import { createHmac, randomInt } from "node:crypto";
import { LIMITS } from "@mykey/contracts";
import { ringKey, type KeyRing } from "../keys.ts";

/** Crockford-style: no I, L, O, U, so a code read aloud or retyped is unambiguous. */
export const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 20;
const GROUP = 5;

export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < LIMITS.recovery.codeCount) {
    let code = "";
    for (let index = 0; index < CODE_LENGTH; index += 1) {
      code += RECOVERY_ALPHABET.charAt(randomInt(RECOVERY_ALPHABET.length));
    }
    codes.add(code);
  }
  return [...codes];
}

export function formatRecoveryCode(code: string): string {
  return (code.match(new RegExp(`.{1,${GROUP}}`, "g")) ?? []).join("-");
}

/** The code as stored, from what a person typed; null when it cannot be one. */
export function normalizeRecoveryCode(input: string): string | null {
  const code = input.toUpperCase().replaceAll(/[\s-]/g, "");
  // Every symbol of the alphabet is one ASCII character, so a valid code is exactly this.
  return new RegExp(`^[${RECOVERY_ALPHABET}]{${CODE_LENGTH}}$`).test(code) ? code : null;
}

export function recoveryVerifier(
  ring: KeyRing,
  enrollmentId: string,
  code: string,
  keyId: string = ring.current,
): Buffer {
  return createHmac("sha256", ringKey(ring, keyId))
    .update(`${enrollmentId}${code}`, "utf8")
    .digest();
}
