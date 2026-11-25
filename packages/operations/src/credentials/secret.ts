// The two secrets of Session 11 and the addresses they are bound to (P-185,
// D-81). A secret is 32 random bytes, presented as `<prefix>.<id>.<base64url>`.
// PostgreSQL holds only HMAC-SHA-256(key, label + presented + what the
// credential is bound to) with the id of the key: 256 random bits cannot be
// found from it. The presented string is a local of whoever mints or checks
// it; nothing here logs or stores it.
//
// Run 11.3 Task D (D-81): the verifier is made over the credential's binding
// too (its kind, organization, project, environment and networks). The key is
// in no database, so whoever can only write the database cannot point a
// credential at another environment or free it of its networks: the changed
// row no longer verifies. State and times are plain columns and are not bound.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import type { PresentedPrefix } from "@mykey/contracts";
import type { HmacRing } from "../replay.ts";

/** Keeps this use of the reset-verifier ring apart from the reset token's own. */
const LABEL = "mykey:credential-secret:v1\n";

export interface StoredVerifier {
  digest: Buffer;
  keyId: string;
}

/** A new presented secret for the credential `id`. */
export function mintSecret(prefix: PresentedPrefix, id: string): string {
  return `${prefix}.${id}.${randomBytes(32).toString("base64url")}`;
}

/** The binding is encoded as a JSON list, never joined: two lists cannot read as one. */
function digestOf(key: Uint8Array, presented: string, bound: readonly string[]): Buffer {
  return createHmac("sha256", Buffer.from(key))
    .update(`${LABEL}${presented}\n${JSON.stringify(bound)}`, "utf8")
    .digest();
}

/** What a runtime credential is bound to: where it reads, and from which networks it may be used. */
export function runtimeBinding(
  scope: { organizationId: string; projectId: string; environmentId: string },
  cidrs: readonly string[],
): string[] {
  return ["runtime", scope.organizationId, scope.projectId, scope.environmentId, ...cidrs];
}

/** What is stored for a presented secret and its binding: the verifier under the ring's current key. */
export function verifierOf(
  ring: HmacRing,
  presented: string,
  bound: readonly string[],
): StoredVerifier {
  const key = ring.keys[ring.current];
  if (key === undefined) throw new Error("the verifier ring has no current key");
  return { digest: digestOf(key, presented, bound), keyId: ring.current };
}

/**
 * Whether `presented` is the secret `stored` was made from, for this binding
 * (read from the row as it is now). False for an unknown key id.
 */
export function verifies(
  ring: HmacRing,
  stored: StoredVerifier,
  presented: string,
  bound: readonly string[],
): boolean {
  const key = ring.keys[stored.keyId];
  if (key === undefined) return false;
  const digest = digestOf(key, presented, bound);
  return digest.length === stored.digest.length && timingSafeEqual(digest, stored.digest);
}

/** The 4 bytes of an IPv4 address, or null. */
function ipv4Bytes(text: string): number[] | null {
  if (!net.isIPv4(text)) return null;
  return text.split(".").map(Number);
}

/** The 16 bytes of an IPv6 address (`::` and a dotted tail included), or null. */
function ipv6Bytes(text: string): number[] | null {
  if (!net.isIPv6(text) || text.includes("%")) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes(".")) {
        const tail = index === pieces.length - 1 ? ipv4Bytes(piece) : null;
        if (tail === null) return null;
        out.push(((tail[0] ?? 0) << 8) | (tail[1] ?? 0), ((tail[2] ?? 0) << 8) | (tail[3] ?? 0));
      } else {
        out.push(Number.parseInt(piece, 16));
      }
    }
    return out;
  };
  const [head, tail, ...rest] = text.split("::");
  if (rest.length > 0 || head === undefined) return null;
  const left = groupsOf(head);
  const right = tail === undefined ? [] : groupsOf(tail);
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...new Array<number>(Math.max(missing, 0)).fill(0), ...right];
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

interface Network {
  address: string;
  prefix: number;
  family: "ipv4" | "ipv6";
}

/** A strict network: a whole address, a prefix from 1 to the family's length, no host bits. */
function networkOf(text: string): Network | null {
  const slash = text.indexOf("/");
  if (slash < 1) return null;
  const address = text.slice(0, slash);
  const prefixText = text.slice(slash + 1);
  if (!/^[1-9][0-9]{0,2}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  const four = ipv4Bytes(address);
  const bytes = four ?? ipv6Bytes(address);
  if (bytes === null || prefix > bytes.length * 8) return null;
  for (const [index, byte] of bytes.entries()) {
    const kept = Math.min(8, Math.max(0, prefix - index * 8));
    if ((byte & (0xff >> kept)) !== 0) return null;
  }
  return { address, prefix, family: four === null ? "ipv6" : "ipv4" };
}

/** The list as networks; null when one entry is not a strict network. */
export function parseCidrs(list: readonly string[]): net.BlockList | null {
  const block = new net.BlockList();
  for (const text of list) {
    const network = networkOf(text);
    if (network === null) return null;
    block.addSubnet(network.address, network.prefix, network.family);
  }
  return block;
}

/**
 * Whether a request from `source` may use a credential bound to `cidrs`. An
 * empty list binds nothing. A source that is no address, and a stored list
 * that does not parse, allow nothing.
 */
export function sourceAllowed(cidrs: readonly string[], source: string): boolean {
  if (cidrs.length === 0) return true;
  const block = parseCidrs(cidrs);
  if (block === null) return false;
  const mapped = /^::ffff:([0-9.]+)$/i.exec(source)?.[1];
  const address = mapped !== undefined && net.isIPv4(mapped) ? mapped : source;
  const family = net.isIP(address);
  if (family === 0) return false;
  return block.check(address, family === 4 ? "ipv4" : "ipv6");
}
