// TOTP (RFC 6238) through otpauth: SHA-1, LIMITS.totp.digits digits,
// LIMITS.totp.stepSeconds seconds, LIMITS.totp.skewSteps steps either side.
import { timingSafeEqual } from "node:crypto";
import { LIMITS } from "@mykey/contracts";
import * as OTPAuth from "otpauth";

const { digits, stepSeconds, skewSteps } = LIMITS.totp;
const CODE = new RegExp(`^\\d{${digits}}$`);

export function stepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / stepSeconds);
}

const hotp = (seed: Uint8Array) =>
  new OTPAuth.HOTP({
    algorithm: "SHA1",
    digits,
    secret: new OTPAuth.Secret({ buffer: Uint8Array.from(seed).buffer }),
  });

/** The code of an absolute step (tests and enrollment use it). */
export function codeAt(seed: Uint8Array, step: number): string {
  return hotp(seed).generate({ counter: step });
}

/**
 * The step a code belongs to: steps −1, 0, +1 around `now`, compared in that
 * fixed order and in constant time per comparison. Whether a step was used
 * before is decided by the database, not here.
 */
export function matchStep(seed: Uint8Array, code: string, now: Date): number | null {
  if (!CODE.test(code)) return null;
  const current = stepAt(now);
  const given = Buffer.from(code, "utf8");
  let found: number | null = null;
  for (let delta = -skewSteps; delta <= skewSteps; delta += 1) {
    const step = current + delta;
    const expected = Buffer.from(codeAt(seed, step), "utf8");
    if (timingSafeEqual(expected, given) && found === null) found = step;
  }
  return found;
}

export function otpauthUri(seed: Uint8Array, account: string): { secret: string; uri: string } {
  const secret = new OTPAuth.Secret({ buffer: Uint8Array.from(seed).buffer });
  const totp = new OTPAuth.TOTP({
    issuer: "MyKey",
    label: account,
    algorithm: "SHA1",
    digits,
    period: stepSeconds,
    secret,
  });
  return { secret: secret.base32, uri: totp.toString() };
}
