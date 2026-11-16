// What proves a machine token is what was asked for, and what proves it is
// gone (Run 5.1, P-87 step d, P-89 steps c–d; D-18). A revocation is proven
// only by a lookup that answers 400 "invalid accessor": revoke-by-accessor
// answers 200 for an accessor that does not exist, so its own answer proves
// nothing.
import { setTimeout as sleep } from "node:timers/promises";
import type { Correlation, TokenInfo } from "@mykey/openbao";
import type { IssuerSession } from "../runtime.ts";

export type TokenFault =
  "orphan" | "renewable" | "type" | "policies" | "uses" | "ttl" | "meta" | "namespace";

function sameMeta(seen: Record<string, string> | null, want: Record<string, string>): boolean {
  if (seen === null) return false;
  const keys = Object.keys(want);
  return Object.keys(seen).length === keys.length && keys.every((key) => seen[key] === want[key]);
}

/** The first property of `info` that differs from what issuance asked for; null when none does. */
export function checkIssuedToken(
  info: TokenInfo,
  want: { role: string; ttlSeconds: number; meta: Record<string, string>; namespace: string },
): TokenFault | null {
  if (!info.orphan) return "orphan";
  if (info.renewable) return "renewable";
  if (info.type !== "service") return "type";
  if (info.policies.length !== 1 || info.policies[0] !== want.role) return "policies";
  if (info.numUses !== 0) return "uses";
  // FR-1.39: the backend may give less than was asked, never more and never nothing.
  if (info.creationTtlSeconds <= 0 || info.creationTtlSeconds > want.ttlSeconds) return "ttl";
  if (!sameMeta(info.meta, want.meta)) return "meta";
  if (info.namespacePath !== `${want.namespace}/`) return "namespace";
  return null;
}

export type RevokeProof = "absent" | "refused_sealed" | "refused_denied" | "not_sent" | "unproven";

const LOOKUPS = 3;
const LOOKUP_GAP_MS = 200;

/**
 * One revoke-by-accessor, then up to three lookups 200 ms apart. `absent`: a
 * lookup answered 400. `not_sent`: the connection of the revoke was never made.
 * `refused_*`: OpenBao refused the revoke itself. Anything else: `unproven`.
 */
export async function revokeAndVerify(
  session: IssuerSession,
  accessor: string,
  c: Correlation,
): Promise<RevokeProof> {
  const revoked = await session.client.tokenRevokeAccessor(accessor, c);
  if (!revoked.ok) {
    if (revoked.kind === "sealed") return "refused_sealed";
    if (revoked.kind === "denied") return "refused_denied";
    if (revoked.kind === "invalid" && revoked.status === 0) return "not_sent";
    // Anything else may have been applied: only a lookup can tell.
  }
  for (let attempt = 0; attempt < LOOKUPS; attempt += 1) {
    if (attempt > 0) await sleep(LOOKUP_GAP_MS);
    const lookup = await session.client.tokenLookupAccessor(accessor);
    if (!lookup.ok && lookup.kind === "invalid" && lookup.status === 400) return "absent";
  }
  return "unproven";
}
