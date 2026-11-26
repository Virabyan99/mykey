// Session 11 (D-80, P-185, P-192): the two non-human credentials that are not
// OpenBao tokens. An automation credential provisions; a runtime credential is
// exchanged for a short-lived machine token. Each is presented as one string,
// `<prefix>.<credential id>.<43 base64url characters>` (32 random bytes), and
// only a keyed verifier of that string is ever stored.

/** What an automation credential may be given at issue (least privilege); reading comes with any. */
export const AUTOMATION_RIGHTS = [
  "projects.create",
  "secrets.create",
  "runtime_credentials.manage",
] as const;
export type AutomationRight = (typeof AUTOMATION_RIGHTS)[number];

export const RUNTIME_SECRET_PREFIX = "mkrc";
export const AUTOMATION_SECRET_PREFIX = "mkac";
export type PresentedPrefix = typeof RUNTIME_SECRET_PREFIX | typeof AUTOMATION_SECRET_PREFIX;

/** Characters of the secret part: 32 bytes as unpadded base64url. */
export const PRESENTED_SECRET_LENGTH = 43;

const PRESENTED =
  /^(mkrc|mkac)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export interface PresentedSecret {
  readonly prefix: PresentedPrefix;
  /** The credential's id: a lookup key, not a secret. */
  readonly id: string;
  readonly secret: string;
}

/** The parts of a presented secret, or null for any other string (an OpenBao token included). */
export function parsePresentedSecret(text: string): PresentedSecret | null {
  // `$` would accept a trailing newline; the length rules that out.
  if (text.length !== 4 + 1 + 36 + 1 + PRESENTED_SECRET_LENGTH) return null;
  const match = PRESENTED.exec(text);
  if (match === null) return null;
  return { prefix: match[1] as PresentedPrefix, id: match[2] ?? "", secret: match[3] ?? "" };
}

/** A CIDR as a request may write it; whether it is a network is checked by the server. */
export const CIDR_TEXT_PATTERN = /^[0-9A-Fa-f:.]+\/[0-9]{1,3}$/;
/** The longest textual IPv6 network: 39 characters, a slash and three digits. */
export const CIDR_TEXT_MAX_LENGTH = 43;
