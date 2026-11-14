// The intent of a mutation whose body is a dotenv file (Run 4.7): the bytes
// enter the fingerprint as their SHA-256 digest inside the canonical text, so
// a 1 MiB file is not canonicalised byte by byte. The canonical text is only
// ever HMAC'd; nothing of it is stored.
import { intentOf, type Principal } from "@mykey/api";
import { ROUTES, type UserId } from "@mykey/contracts";
import { intentFingerprint } from "@mykey/operations";
import { describe, expect, it } from "vitest";

const route = ROUTES.find((candidate) => candidate.id === "import.apply")!;
const principal = { userId: "00000000-0000-4000-8000-000000000001" as UserId } as Principal;
const params = { org: "o", project: "p", env: "e", preview: "v" };
const ring = { current: "k1", keys: { k1: new Uint8Array(32).fill(7) } };

describe("intentOf with a byte body", () => {
  it("is the bytes' digest: equal bytes give equal fingerprints, other bytes another", () => {
    const bytes = Buffer.from("A=1\n", "utf8");
    const intent = intentOf(route, params, principal, bytes);
    expect(Object.keys(intent.body as object)).toEqual(["sha256"]);
    expect((intent.body as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    const same = intentOf(route, params, principal, Buffer.from("A=1\n", "utf8"));
    const other = intentOf(route, params, principal, Buffer.from("A=2\n", "utf8"));
    const digest = (value: typeof intent) => intentFingerprint(ring, value).digest;
    expect(digest(same).equals(digest(intent))).toBe(true);
    expect(digest(other).equals(digest(intent))).toBe(false);
  });

  it("a 1 MiB body is fingerprinted quickly", () => {
    const bytes = Buffer.alloc(1024 * 1024, 0x41);
    const started = performance.now();
    intentFingerprint(ring, intentOf(route, params, principal, bytes));
    expect(performance.now() - started).toBeLessThan(500);
  });
});
