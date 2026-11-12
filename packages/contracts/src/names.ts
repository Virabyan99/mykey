// Name and value rules (Doc 04 §3–§4, Doc 06 §11). Validators return a rule
// name only: nothing they return or throw ever contains the input.
import { LIMITS } from "./limits.ts";

export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
export const ENVIRONMENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export type NameCheck<R extends string> = { ok: true; value: string } | { ok: false; rule: R };

export function checkSecretName(input: string): NameCheck<"pattern" | "reserved_prefix"> {
  if (!SECRET_NAME_PATTERN.test(input)) return { ok: false, rule: "pattern" };
  if (input.startsWith(LIMITS.secret.reservedPrefix)) return { ok: false, rule: "reserved_prefix" };
  return { ok: true, value: input };
}

export function checkEnvironmentName(input: string): NameCheck<"pattern"> {
  if (!ENVIRONMENT_NAME_PATTERN.test(input)) return { ok: false, rule: "pattern" };
  return { ok: true, value: input };
}

/** The accepted value is the NFC form; length is counted in code points after normalising. */
export function checkProjectName(
  input: string,
): NameCheck<"length" | "control_character" | "whitespace_only"> {
  if (!input.isWellFormed()) return { ok: false, rule: "control_character" };
  const value = input.normalize("NFC");
  const codePoints = Array.from(value).length;
  if (
    codePoints < LIMITS.project.nameMinCodePoints ||
    codePoints > LIMITS.project.nameMaxCodePoints
  ) {
    return { ok: false, rule: "length" };
  }
  if (/\p{Cc}/u.test(value)) return { ok: false, rule: "control_character" };
  if (/^[\s\p{White_Space}]+$/u.test(value)) return { ok: false, rule: "whitespace_only" };
  return { ok: true, value };
}

const utf8 = new TextEncoder();

export function checkSecretValue(
  value: string,
): { ok: true; byteLength: number } | { ok: false; rule: "too_large" | "nul" | "ill_formed" } {
  if (!value.isWellFormed()) return { ok: false, rule: "ill_formed" };
  if (value.includes("\0")) return { ok: false, rule: "nul" };
  // A string of n UTF-16 units is at most 3n UTF-8 bytes; skip encoding hopeless inputs.
  if (value.length > LIMITS.secret.valueMaxBytes) return { ok: false, rule: "too_large" };
  const byteLength = utf8.encode(value).length;
  if (byteLength > LIMITS.secret.valueMaxBytes) return { ok: false, rule: "too_large" };
  return { ok: true, byteLength };
}

/** The password rule (P-46, D-27): 12 to 1,024 code points, at most 1,024 bytes of UTF-8. */
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
    utf8.encode(value).length > LIMITS.body.passwordMaxBytes
  ) {
    return { ok: false, reason: "too_long" };
  }
  return { ok: true };
}
