// What no text of the catalogue or the help may hold (P-159, Review focus 1
// and 2, the repository is public): nothing shaped like a secret, a token or
// a reset link, no address of any deployment, and none of the claims
// FR-1.102 bans except inside a sentence that denies it.

export interface LintProblem {
  rule: string;
  text: string;
}

/** Host names a text may use: the documentation's own and the public sources of the CLI. */
const ALLOWED_HOSTS = new Set(["mykey.example", "example.com", "example", "github.com"]);

/** Shapes that are never written in a description. Assembled so this file does not hold them. */
const SHAPES: readonly [string, RegExp][] = [
  ["a canary", new RegExp(`${["MYKEY", "CANARY"].join("_")}_[A-Za-z0-9]{8,}`)],
  ["an OpenBao token", /\b(?:hv[sbr]|s)\.[A-Za-z0-9_-]{20,}/],
  ["a reset token", /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/],
  ["an IPv4 address", /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  ["an IPv6 address", /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b|::1\b/i],
  ["a staging or production host", /\b[a-z0-9-]+\.(?:staging|prod|production)\.[a-z0-9.-]+/i],
];

/** A host name: labels joined by dots that end in a letters-only top label. */
const HOST = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi;

/** File names and code that look like host names but are not. */
const NOT_HOSTS = /\.(?:md|ts|tsx|sh|json|env|txt|tgz|js|mjs|html|css|yml|yaml|service|timer)$/i;

/** FR-1.102: claims the product does not make. */
export const BANNED_CLAIMS: readonly string[] = [
  "zero-knowledge",
  "guaranteed",
  "always available",
  "erased",
  "permanently deleted",
  "sandbox",
  "cannot be read by anyone",
  "military-grade",
  "unbreakable",
  "100%",
];

/** Sentences that name a banned claim only to deny it; nothing else may. */
export const ALLOWED_DENIALS: readonly string[] = [
  "MyKey is not zero-knowledge: the service can read the values it stores, so that it can give them to your application.",
  "A deleted value is not erased: the secret store keeps its versions until they age out.",
  "Nothing about availability is guaranteed: this is a single server run by one operator.",
];

export function lintText(text: string): LintProblem[] {
  const problems: LintProblem[] = [];
  for (const [rule, pattern] of SHAPES) {
    if (pattern.test(text)) problems.push({ rule, text });
  }
  for (const match of text.matchAll(HOST)) {
    const host = match[0].toLowerCase();
    if (ALLOWED_HOSTS.has(host) || NOT_HOSTS.test(host)) continue;
    // A dotted word inside code, such as `secrets.reveal` or `consumer-local.md`, is not a host
    // when its last label is not a top-level domain of the public internet's common set.
    if (
      !/\.(?:com|net|org|io|dev|app|cloud|eu|us|co|me|sh|xyz|info|online|site|tech)$/.test(host)
    ) {
      continue;
    }
    problems.push({ rule: `a host name (${host})`, text });
  }
  const lower = text.toLowerCase();
  const denied = ALLOWED_DENIALS.some((sentence) => text.includes(sentence));
  for (const claim of BANNED_CLAIMS) {
    if (lower.includes(claim) && !denied) problems.push({ rule: `the claim "${claim}"`, text });
  }
  return problems;
}

/** Every string inside a value: an object's values, an array's items, a function's text is not read. */
export function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsOf(item));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) => stringsOf(item));
  }
  return [];
}
