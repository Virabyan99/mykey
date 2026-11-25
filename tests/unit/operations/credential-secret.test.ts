// Run 11.3 Task A (P-185, D-81): the two new secrets and the bound addresses.
// A presented secret is `mkrc|mkac.<id>.<43 base64url>`; what is stored is
// HMAC-SHA-256(key, "mykey:credential-secret:v1\n" + presented) with its key
// id. A CIDR is a strict network: no host bits, a prefix longer than 0.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parsePresentedSecret } from "@mykey/contracts";
import { mintSecret, parseCidrs, sourceAllowed, verifierOf, verifies } from "@mykey/operations";

const ring = {
  current: "k2",
  keys: { k1: new Uint8Array(32).fill(1), k2: new Uint8Array(32).fill(2) },
};
const ID = "11111111-1111-4111-8111-111111111111";

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
    const stored = verifierOf(ring, presented);
    expect(stored.keyId).toBe("k2");
    expect(stored.digest).toHaveLength(32);
    const expected = createHmac("sha256", Buffer.from(ring.keys.k2))
      .update(`mykey:credential-secret:v1\n${presented}`, "utf8")
      .digest();
    expect(stored.digest.equals(expected)).toBe(true);
    // The label keeps it apart from a reset token's verifier under the same ring.
    const unlabelled = createHmac("sha256", Buffer.from(ring.keys.k2))
      .update(presented, "utf8")
      .digest();
    expect(stored.digest.equals(unlabelled)).toBe(false);
  });

  it("verifies the same string, under the key id it was stored with", () => {
    const presented = mintSecret("mkrc", ID);
    const old = verifierOf({ ...ring, current: "k1" }, presented);
    expect(old.keyId).toBe("k1");
    // The ring has moved on to k2; the stored key id still decides.
    expect(verifies(ring, old, presented)).toBe(true);
  });

  it("refuses another secret, another id, a short digest and an unknown key id", () => {
    const presented = mintSecret("mkrc", ID);
    const stored = verifierOf(ring, presented);
    expect(verifies(ring, stored, presented)).toBe(true);
    expect(verifies(ring, stored, mintSecret("mkrc", ID))).toBe(false);
    expect(verifies(ring, stored, presented.replace("mkrc", "mkac"))).toBe(false);
    expect(verifies(ring, { ...stored, digest: stored.digest.subarray(0, 16) }, presented)).toBe(
      false,
    );
    expect(verifies(ring, { ...stored, keyId: "k9" }, presented)).toBe(false);
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
