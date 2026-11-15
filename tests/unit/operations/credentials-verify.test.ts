// Run 5.1 Task A (P-87 step d): what an issued token must say about itself
// before it is recorded and delivered. One case per fault, and the lifetime
// rule of FR-1.39: the backend may give less than was asked, never more.
import { describe, expect, it } from "vitest";
import { checkIssuedToken, type TokenFault } from "@mykey/operations";
import type { TokenInfo } from "@mykey/openbao";

const ROLE = "machine-env-33333333-3333-4333-8333-333333333333";
const NAMESPACE = "org-11111111-1111-4111-8111-111111111111";
const META = {
  credential_id: "44444444-4444-4444-8444-444444444444",
  operation_id: "55555555-5555-4555-8555-555555555555",
};
const want = { role: ROLE, ttlSeconds: 120, meta: META, namespace: NAMESPACE };

const good: TokenInfo = {
  accessor: "accessor-of-the-test",
  policies: [ROLE],
  orphan: true,
  renewable: false,
  type: "service",
  ttlSeconds: 119,
  explicitMaxTtlSeconds: 0,
  namespacePath: `${NAMESPACE}/`,
  creationTtlSeconds: 120,
  numUses: 0,
  expireTime: "2026-11-15T10:02:00Z",
  issueTime: "2026-11-15T10:00:00Z",
  meta: { ...META },
};

describe("checkIssuedToken", () => {
  it("a token exactly as asked passes", () => {
    expect(checkIssuedToken(good, want)).toBeNull();
  });

  const faults: [TokenFault, Partial<TokenInfo>][] = [
    ["orphan", { orphan: false }],
    ["renewable", { renewable: true }],
    ["type", { type: "batch" }],
    ["policies", { policies: [ROLE, "default"] }],
    ["policies", { policies: [] }],
    ["policies", { policies: ["runtime"] }],
    ["uses", { numUses: 3 }],
    ["ttl", { creationTtlSeconds: 0 }],
    ["ttl", { creationTtlSeconds: 121 }],
    ["meta", { meta: null }],
    ["meta", { meta: { ...META, operation_id: "66666666-6666-4666-8666-666666666666" } }],
    ["meta", { meta: { ...META, extra: "x" } }],
    ["namespace", { namespacePath: "org-22222222-2222-4222-8222-222222222222/" }],
    ["namespace", { namespacePath: "" }],
  ];
  for (const [fault, change] of faults) {
    it(`${fault}: ${JSON.stringify(change)}`, () => {
      expect(checkIssuedToken({ ...good, ...change }, want)).toBe(fault);
    });
  }

  it("ttl: the backend may give less than was asked", () => {
    expect(checkIssuedToken({ ...good, creationTtlSeconds: 60 }, want)).toBeNull();
  });
});
