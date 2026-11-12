// The password rule (P-46): 12 to 1,024 characters (code points) and at most
// 1,024 bytes of UTF-8 (LIMITS.body.passwordMaxBytes). Checked by the product
// wherever a password is set: bootstrap, change, reset.
import { LIMITS } from "@mykey/contracts";

export const PASSWORD_MIN_CHARACTERS = 12;
export const PASSWORD_MAX_CHARACTERS = 1024;

export type PasswordCheck = { ok: true } | { ok: false; reason: "too_short" | "too_long" };

export function checkPassword(value: string): PasswordCheck {
  // Code points, not UTF-16 units: an astral character counts once.
  let characters = 0;
  for (const point of value) characters += point === "" ? 0 : 1;
  if (characters < PASSWORD_MIN_CHARACTERS) return { ok: false, reason: "too_short" };
  if (
    characters > PASSWORD_MAX_CHARACTERS ||
    Buffer.byteLength(value, "utf8") > LIMITS.body.passwordMaxBytes
  ) {
    return { ok: false, reason: "too_long" };
  }
  return { ok: true };
}
