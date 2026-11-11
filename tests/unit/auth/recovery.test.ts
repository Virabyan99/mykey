// Run 2.3 Task D: recovery codes and their stored verifiers.
import { randomBytes, randomUUID } from "node:crypto";
import { LIMITS } from "@mykey/contracts";
import { describe, expect, it } from "vitest";
import {
  RECOVERY_ALPHABET,
  formatRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  recoveryVerifier,
  type KeyRing,
} from "@mykey/auth";

const ring: KeyRing = { current: "k1", keys: { k1: new Uint8Array(randomBytes(32)) } };

describe("recovery codes", () => {
  it("are ten different codes of 20 symbols from a 32-symbol alphabet (100 bits)", () => {
    expect(new Set(RECOVERY_ALPHABET).size).toBe(32);
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(LIMITS.recovery.codeCount);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(new RegExp(`^[${RECOVERY_ALPHABET}]{20}$`));
    }
  });

  it("are shown as four groups of five and read back from any spacing or case", () => {
    const [code] = generateRecoveryCodes();
    if (code === undefined) throw new Error("no code");
    const shown = formatRecoveryCode(code);
    expect(shown).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
    expect(normalizeRecoveryCode(shown)).toBe(code);
    expect(normalizeRecoveryCode(` ${shown.toLowerCase().replaceAll("-", " ")} `)).toBe(code);
    expect(normalizeRecoveryCode("not a code")).toBeNull();
  });

  it("are stored as a 32-byte verifier that differs per enrollment and per key", () => {
    const [code] = generateRecoveryCodes();
    if (code === undefined) throw new Error("no code");
    const enrollment = randomUUID();
    const verifier = recoveryVerifier(ring, enrollment, code);
    expect(verifier).toHaveLength(32);
    expect(recoveryVerifier(ring, enrollment, code)).toEqual(verifier);
    expect(recoveryVerifier(ring, randomUUID(), code)).not.toEqual(verifier);
    const other: KeyRing = { current: "k2", keys: { k2: new Uint8Array(randomBytes(32)) } };
    expect(recoveryVerifier(other, enrollment, code)).not.toEqual(verifier);
    expect(verifier.toString("utf8")).not.toContain(code);
  });
});
