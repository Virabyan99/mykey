// Run 11.3 Task A (P-185, D-81): the two new secrets and the bound addresses.
// A presented secret is `mkrc|mkac.<id>.<43 base64url>`; what is stored is
// HMAC-SHA-256(key, "mykey:credential-secret:v1\n" + presented + "\n" + the
// JSON list of what the credential is bound to) with its key id (Task D: the
// environment and the networks, so that a changed row no longer verifies).
// A CIDR is a strict network: no host bits, a prefix longer than 0.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parsePresentedSecret } from "@mykey/contracts";
import {
  mintSecret,
  parseCidrs,
  runtimeBinding,
  sourceAllowed,
  verifierOf,
  verifies,
} from "@mykey/operations";

const ring = {
  current: "k2",
  keys: { k1: new Uint8Array(32).fill(1), k2: new Uint8Array(32).fill(2) },
};
const ID = "11111111-1111-4111-8111-111111111111";
const SCOPE = {
  organizationId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  environmentId: "44444444-4444-4444-8444-444444444444",
};
const OTHER = "55555555-5555-4555-8555-555555555555";
const BOUND = runtimeBinding(SCOPE, ["203.0.113.0/24"]);

describe("mintSecret", () => {
  it("gives the presented shape of its prefix and id, and 32 new random bytes each time", () => {
    const first = mintSecret("mkrc", ID);
    const second = mintSecret("mkrc", ID);
    const parsed = parsePresentedSecret(first);
    expect(parsed?.prefix).toBe("mkrc");
    expect(parsed?.id).toBe(ID);
    expect(Buffer.from(parsed?.secret ?? "", "base64url")).toHaveLength(32);
    expect(first === second).toBe(false);
    expect(parsePresentedSecret(mintSecret("mkac", ID))?.prefix).toBe("mkac");
  });
});

describe("verifierOf and verifies", () => {
  it("the verifier is the labelled HMAC of the presented string under the current key", () => {
    const presented = mintSecret("mkrc", ID);
    const stored = verifierOf(ring, presented, BOUND);
    expect(stored.keyId).toBe("k2");
    expect(stored.digest).toHaveLength(32);
    const expected = createHmac("sha256", Buffer.from(ring.keys.k2))
      .update(`mykey:credential-secret:v1\n${presented}\n${JSON.stringify(BOUND)}`, "utf8")
      .digest();
    expect(stored.digest.equals(expected)).toBe(true);
    expect(BOUND).toEqual([
      "runtime",
      SCOPE.organizationId,
      SCOPE.projectId,
      SCOPE.environmentId,
      "203.0.113.0/24",
    ]);
    // The label keeps it apart from a reset token's verifier under the same ring.
    const unlabelled = createHmac("sha256", Buffer.from(ring.keys.k2))
      .update(presented, "utf8")
      .digest();
    expect(stored.digest.equals(unlabelled)).toBe(false);
  });

  it("verifies the same string, under the key id it was stored with", () => {
    const presented = mintSecret("mkrc", ID);
    const old = verifierOf({ ...ring, current: "k1" }, presented, BOUND);
    expect(old.keyId).toBe("k1");
    // The ring has moved on to k2; the stored key id still decides.
    expect(verifies(ring, old, presented, BOUND)).toBe(true);
  });

  // Run 11.3 Task D (D-81): what a writer of the database alone could change.
  it("the same secret does not verify for another organization, project or environment, nor for other networks", () => {
    const presented = mintSecret("mkrc", ID);
    const stored = verifierOf(ring, presented, BOUND);
    expect(verifies(ring, stored, presented, BOUND)).toBe(true);
    const cidrs = ["203.0.113.0/24"];
    const moved = [
      runtimeBinding({ ...SCOPE, environmentId: OTHER }, cidrs),
      runtimeBinding({ ...SCOPE, projectId: OTHER }, cidrs),
      runtimeBinding({ ...SCOPE, organizationId: OTHER }, cidrs),
      runtimeBinding(SCOPE, []),
      runtimeBinding(SCOPE, ["203.0.113.0/25"]),
      runtimeBinding(SCOPE, ["203.0.113.0/24", "198.51.100.0/24"]),
      [],
    ];
    for (const bound of moved) {
      expect(verifies(ring, stored, presented, bound), JSON.stringify(bound)).toBe(false);
    }
    // Two lists cannot be made to read as one: the list is encoded, not joined.
    const joined = verifierOf(ring, presented, ["a", "b"]);
    expect(verifies(ring, joined, presented, ["a\nb"])).toBe(false);
    expect(verifies(ring, joined, presented, ['a","b'])).toBe(false);
  });

  it("refuses another secret, another id, a short digest and an unknown key id", () => {
    const presented = mintSecret("mkrc", ID);
    const stored = verifierOf(ring, presented, BOUND);
    expect(verifies(ring, stored, presented, BOUND)).toBe(true);
    expect(verifies(ring, stored, mintSecret("mkrc", ID), BOUND)).toBe(false);
    expect(verifies(ring, stored, presented.replace("mkrc", "mkac"), BOUND)).toBe(false);
    expect(
      verifies(ring, { ...stored, digest: stored.digest.subarray(0, 16) }, presented, BOUND),
    ).toBe(false);
    expect(verifies(ring, { ...stored, keyId: "k9" }, presented, BOUND)).toBe(false);
  });
});

describe("parseCidrs", () => {
  it.each([
    ["192.0.2.0/24"],
    ["192.0.2.7/32"],
    ["10.0.0.0/8"],
    ["128.0.0.0/1"],
    ["2001:db8::/32"],
    ["2001:db8::1/128"],
    ["2001:db8:0:1::/64"],
  ])("%s is a network", (text) => {
    expect(parseCidrs([text])).not.toBeNull();
  });

  it.each([
    ["192.0.2.7/24", "host bits"],
    ["0.0.0.0/0", "a /0"],
    ["::/0", "a /0"],
    ["192.0.2.0/33", "a prefix too long"],
    ["2001:db8::/129", "a prefix too long"],
    ["2001:db8::1/64", "host bits"],
    ["192.0.2.0", "no prefix"],
    ["192.0.2.0/024", "a prefix with a leading zero"],
    ["192.0.2/24", "a short address"],
    ["example.test/24", "a name"],
    ["192.0.2.0/24 ", "a trailing space"],
    ["", "nothing"],
  ])("%s is refused (%s)", (text) => {
    expect(parseCidrs([text])).toBeNull();
  });

  it("one bad entry refuses the whole list; an empty list is a list", () => {
    expect(parseCidrs(["192.0.2.0/24", "192.0.2.7/24"])).toBeNull();
    expect(parseCidrs([])).not.toBeNull();
  });
});

describe("sourceAllowed", () => {
  it("an empty list allows every source", () => {
    expect(sourceAllowed([], "198.51.100.7")).toBe(true);
    expect(sourceAllowed([], "unknown")).toBe(true);
  });

  it("allows a source inside one of the networks and refuses one outside", () => {
    const cidrs = ["192.0.2.0/24", "2001:db8::/32"];
    expect(sourceAllowed(cidrs, "192.0.2.200")).toBe(true);
    expect(sourceAllowed(cidrs, "192.0.3.1")).toBe(false);
    expect(sourceAllowed(cidrs, "2001:db8:1::5")).toBe(true);
    expect(sourceAllowed(cidrs, "2001:db9::5")).toBe(false);
  });

  it("an IPv4 source written as a mapped IPv6 address is that IPv4 address", () => {
    expect(sourceAllowed(["192.0.2.0/24"], "::ffff:192.0.2.9")).toBe(true);
    expect(sourceAllowed(["192.0.2.0/24"], "::ffff:192.0.3.9")).toBe(false);
  });

  it("a source that is no address, and a stored list that is no list of networks, allow nothing", () => {
    expect(sourceAllowed(["192.0.2.0/24"], "unknown")).toBe(false);
    expect(sourceAllowed(["192.0.2.0/24"], "")).toBe(false);
    expect(sourceAllowed(["192.0.2.7/24"], "192.0.2.7")).toBe(false);
  });
});
