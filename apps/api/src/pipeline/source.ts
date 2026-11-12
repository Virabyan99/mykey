// The request source (P-47, Doc 06 §9: trust only the actual edge hop). When
// the TCP peer is the configured edge (Traefik, 10.78.1.2 on the hosts) and
// X-Forwarded-For holds exactly one valid address, that address; otherwise
// the peer. Nothing else in the API reads a forwarded header for a decision.
import net from "node:net";

const MAX_FORWARDED = 64;

/** An IPv4-mapped IPv6 address in its IPv4 form; anything else unchanged. */
function normalize(address: string): string {
  const mapped = /^::ffff:([0-9.]+)$/i.exec(address);
  return mapped?.[1] !== undefined && net.isIPv4(mapped[1]) ? mapped[1] : address;
}

export function requestSource(
  peer: string | undefined,
  forwardedFor: string | undefined,
  trustedProxy: string | null,
): string {
  if (peer === undefined || peer === "") return "unknown";
  const from = normalize(peer);
  if (trustedProxy === null || from !== trustedProxy || forwardedFor === undefined) return from;
  const value = forwardedFor.trim();
  if (value.length === 0 || value.length > MAX_FORWARDED || value.includes(",")) return from;
  // A bare address only: no port, no brackets, no name.
  if (net.isIP(value) === 0) return from;
  return normalize(value);
}
