// Signed list cursors (Run 3.9, P-59; Run 4.3 reuses them). A cursor is
// base64url(payload) "." base64url(HMAC-SHA-256 under the cursor-mac ring),
// bound to its route, its scope and its filter, and carrying the list's
// generation when the first page was read. Anything that does not verify,
// parse or match is null — the caller answers 400 malformed_request.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export interface MacRing {
  current: string;
  keys: Readonly<Record<string, Uint8Array>>;
}

export interface CursorFields {
  routeId: string;
  scope: string;
  filter: string;
  lastKey: string;
  generation: string;
}

const payloadSchema = z.strictObject({
  v: z.literal(1),
  k: z.string().min(1).max(32),
  r: z.string().max(64),
  s: z.string().max(128),
  f: z.string().max(256),
  l: z.string().max(256),
  g: z.string().regex(/^[0-9]{1,19}$/),
});

const MAX_CURSOR_LENGTH = 2048;

function mac(key: Uint8Array, payload: string): Buffer {
  return createHmac("sha256", Buffer.from(key)).update(payload).digest();
}

export function signCursor(ring: MacRing, cursor: CursorFields): string {
  const key = ring.keys[ring.current];
  if (key === undefined) throw new Error("the cursor ring has no current key");
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      k: ring.current,
      r: cursor.routeId,
      s: cursor.scope,
      f: cursor.filter,
      l: cursor.lastKey,
      g: cursor.generation,
    }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${mac(key, payload).toString("base64url")}`;
}

export function readCursor(
  ring: MacRing,
  text: string,
  expect: { routeId: string; scope: string; filter: string },
): { lastKey: string; generation: string } | null {
  if (text.length === 0 || text.length > MAX_CURSOR_LENGTH) return null;
  const parts = text.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  let parsed: z.infer<typeof payloadSchema>;
  try {
    const result = payloadSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  const key = ring.keys[parsed.k];
  if (key === undefined) return null;
  const expected = mac(key, payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  // The signature must be the canonical encoding of those bytes (no alternative spelling).
  if (given.toString("base64url") !== signature) return null;
  if (parsed.r !== expect.routeId || parsed.s !== expect.scope || parsed.f !== expect.filter) {
    return null;
  }
  return { lastKey: parsed.l, generation: parsed.g };
}
