import {
  ENVIRONMENT_NAME_PATTERN,
  SECRET_NAME_PATTERN,
  checkEnvironmentName,
  checkProjectName,
  checkSecretName,
  checkSecretValue,
  organizationIdSchema,
  requestIdSchema,
} from "@mykey/contracts";
import { describe, expect, it } from "vitest";

const pattern = { ok: false, rule: "pattern" };

describe("secret name", () => {
  it("accepts 128 characters and rejects 129", () => {
    const longest = "A".repeat(128);
    expect(checkSecretName(longest)).toEqual({ ok: true, value: longest });
    expect(checkSecretName("A".repeat(129))).toEqual(pattern);
  });

  it.each(["lower", "Mixed_Case", "1A", "_A", "A-B", "", "A B", "A\n", "\nA", "Ä", "A.B"])(
    "rejects %j by pattern",
    (name) => {
      expect(checkSecretName(name)).toEqual(pattern);
    },
  );

  it("rejects the reserved prefix and nothing that merely resembles it", () => {
    expect(checkSecretName("SECRETS_X")).toEqual({ ok: false, rule: "reserved_prefix" });
    expect(checkSecretName("SECRETS_")).toEqual({ ok: false, rule: "reserved_prefix" });
    expect(checkSecretName("SECRETS")).toEqual({ ok: true, value: "SECRETS" });
    expect(checkSecretName("MY_SECRETS_X")).toEqual({ ok: true, value: "MY_SECRETS_X" });
    expect(checkSecretName("SECRET_X")).toEqual({ ok: true, value: "SECRET_X" });
  });

  it("accepts ordinary names", () => {
    for (const name of ["A", "A1", "A_", "DATABASE_URL", "X9_Y8"]) {
      expect(checkSecretName(name)).toEqual({ ok: true, value: name });
    }
    expect(SECRET_NAME_PATTERN.source).toBe("^[A-Z][A-Z0-9_]{0,127}$");
  });
});

describe("environment name", () => {
  it("accepts 63 characters and rejects 64", () => {
    const longest = "a".repeat(63);
    expect(checkEnvironmentName(longest)).toEqual({ ok: true, value: longest });
    expect(checkEnvironmentName("a".repeat(64))).toEqual(pattern);
  });

  it.each(["1a", "Prod", "a_b", "", "-a", "a b", "a\n", "é"])("rejects %j by pattern", (name) => {
    expect(checkEnvironmentName(name)).toEqual(pattern);
  });

  it("accepts a single letter and a trailing hyphen", () => {
    expect(checkEnvironmentName("a")).toEqual({ ok: true, value: "a" });
    expect(checkEnvironmentName("a-")).toEqual({ ok: true, value: "a-" });
    expect(checkEnvironmentName("development")).toEqual({ ok: true, value: "development" });
    expect(ENVIRONMENT_NAME_PATTERN.source).toBe("^[a-z][a-z0-9-]{0,62}$");
  });
});

describe("project name", () => {
  it("counts code points, not UTF-16 units", () => {
    const astral = "𝒜".repeat(64);
    expect(astral.length).toBe(128);
    expect(checkProjectName(astral)).toEqual({ ok: true, value: astral });
    expect(checkProjectName("𝒜".repeat(65))).toEqual({ ok: false, rule: "length" });
    expect(checkProjectName("a".repeat(64))).toEqual({ ok: true, value: "a".repeat(64) });
    expect(checkProjectName("a".repeat(65))).toEqual({ ok: false, rule: "length" });
  });

  it("rejects empty, whitespace-only and control characters", () => {
    expect(checkProjectName("")).toEqual({ ok: false, rule: "length" });
    expect(checkProjectName("   ")).toEqual({ ok: false, rule: "whitespace_only" });
    expect(checkProjectName("  ")).toEqual({ ok: false, rule: "whitespace_only" });
    expect(checkProjectName("bell\u0007")).toEqual({ ok: false, rule: "control_character" });
    expect(checkProjectName("line\nbreak")).toEqual({ ok: false, rule: "control_character" });
    expect(checkProjectName("tab\there")).toEqual({ ok: false, rule: "control_character" });
  });

  it("returns the NFC form and counts after normalising", () => {
    expect(checkProjectName("é")).toEqual({ ok: true, value: "é" });
    const decomposed = "é".repeat(64);
    expect(checkProjectName(decomposed)).toEqual({ ok: true, value: "é".repeat(64) });
  });

  it("preserves interior and trailing spaces", () => {
    expect(checkProjectName("My  Project ")).toEqual({ ok: true, value: "My  Project " });
    expect(checkProjectName(" x")).toEqual({ ok: true, value: " x" });
  });
});

describe("secret value", () => {
  it("accepts the empty string", () => {
    expect(checkSecretValue("")).toEqual({ ok: true, byteLength: 0 });
  });

  it("limits UTF-8 bytes, not characters", () => {
    expect(checkSecretValue("a".repeat(65536))).toEqual({ ok: true, byteLength: 65536 });
    expect(checkSecretValue("a".repeat(65537))).toEqual({ ok: false, rule: "too_large" });
    const euros = "€".repeat(21845);
    expect(checkSecretValue(`${euros}a`)).toEqual({ ok: true, byteLength: 65536 });
    expect(checkSecretValue(`${euros}aa`)).toEqual({ ok: false, rule: "too_large" });
  });

  it("rejects NUL and ill-formed strings", () => {
    expect(checkSecretValue("a\0b")).toEqual({ ok: false, rule: "nul" });
    expect(checkSecretValue("a\ud800b")).toEqual({ ok: false, rule: "ill_formed" });
    expect(checkSecretValue("\udc00")).toEqual({ ok: false, rule: "ill_formed" });
  });

  it("accepts multi-line and other control characters", () => {
    expect(checkSecretValue("line one\nline two\r\n\ttabbed")).toEqual({
      ok: true,
      byteLength: 26,
    });
    expect(checkSecretValue("🔑")).toEqual({ ok: true, byteLength: 4 });
  });
});

describe("validators never echo their input", () => {
  it("returns only a rule name for a rejected value", () => {
    const canary = `LEAK${"x".repeat(40)}`;
    const results = [
      checkSecretName(canary.toLowerCase()),
      checkEnvironmentName(canary),
      checkProjectName(`${canary}\u0007`),
      checkSecretValue(`${canary}\0`),
    ];
    expect(JSON.stringify(results)).not.toContain("LEAK");
    expect(JSON.stringify(results).toLowerCase()).not.toContain("leakx");
  });
});

describe("identifier schemas", () => {
  it("accept a UUID and reject anything else", () => {
    const id = "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e7f";
    expect(organizationIdSchema.parse(id)).toBe(id);
    expect(requestIdSchema.safeParse(id).success).toBe(true);
    for (const bad of ["", "not-a-uuid", `${id}0`, id.replaceAll("-", ""), 42, null]) {
      expect(organizationIdSchema.safeParse(bad).success).toBe(false);
    }
  });
});
