// The only place a request body is read and parsed (Doc 06 §11). Every refusal
// here is `400 malformed_request` (D-14 has no 413 or 415): headers over the
// limit; a body over the route's maximum, decided from Content-Length when
// present and by counting while reading otherwise (the read stops at the
// limit); a wrong Content-Type; a body on a route that takes none; invalid
// UTF-8; invalid JSON; depth over the limit; a duplicate key in any object.
import { LIMITS, type RouteDef } from "@mykey/contracts";
import { ApiError } from "./context.ts";

export type StrictJson = { ok: true; value: unknown } | { ok: false };

/**
 * JSON.parse with two extra refusals, decided by a scanning pass first:
 * a key that occurs twice in one object (after unescaping), and nesting of
 * containers deeper than `maxDepth`.
 */
export function parseStrictJson(text: string, maxDepth: number): StrictJson {
  const frames: { keys: Set<string> | null; expectKey: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      if (i >= text.length) return { ok: false };
      i += 1;
      const top = frames.at(-1);
      if (top?.keys != null && top.expectKey) {
        let key: unknown;
        try {
          key = JSON.parse(text.slice(start, i));
        } catch {
          return { ok: false };
        }
        if (typeof key !== "string" || top.keys.has(key)) return { ok: false };
        top.keys.add(key);
        top.expectKey = false;
      }
      continue;
    }
    if (char === "{" || char === "[") {
      frames.push({ keys: char === "{" ? new Set() : null, expectKey: char === "{" });
      if (frames.length > maxDepth) return { ok: false };
    } else if (char === "}" || char === "]") {
      frames.pop();
    } else if (char === ",") {
      const top = frames.at(-1);
      if (top?.keys != null) top.expectKey = true;
    }
    i += 1;
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The size of the request's header block as received: names, values and separators. */
export function headerBytes(rawHeaders: readonly string[]): number {
  let total = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    total +=
      Buffer.byteLength(rawHeaders[i] ?? "") + Buffer.byteLength(rawHeaders[i + 1] ?? "") + 4;
  }
  return total;
}

export type BodyKind = "none" | "json" | "text";

export function bodyKindOf(route: RouteDef): BodyKind {
  const body = route.request.body;
  if (body === undefined) return "none";
  if (body === "raw-dotenv") return "text";
  return "json";
}

export function bodyLimitOf(route: RouteDef): number {
  if (route.request.body === "raw-dotenv") return LIMITS.body.dotenvMaxBytes;
  return route.path.startsWith("/v1/auth/") ? LIMITS.body.authMaxBytes : LIMITS.body.jsonMaxBytes;
}

function mediaType(header: string | null): string | null {
  if (header === null) return null;
  const [type, ...parameters] = header.split(";").map((part) => part.trim().toLowerCase());
  // Only a UTF-8 charset parameter is acceptable.
  for (const parameter of parameters) {
    if (parameter !== "charset=utf-8") return null;
  }
  return type ?? null;
}

const malformed = (): ApiError => new ApiError("malformed_request");

/**
 * An oversized body whose length was declared is refused from the header
 * alone, but the rest of it is read and dropped (never kept) up to this many
 * bytes before the answer goes out: a peer that is still uploading would
 * otherwise get a connection reset instead of the 400. Beyond it the
 * connection is simply closed after the answer.
 */
const DISCARD_MAX_BYTES = 4 * 1024 * 1024;

async function discard(request: Request, bytes: number): Promise<void> {
  const reader = request.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return;
  let dropped = 0;
  try {
    while (dropped < bytes) {
      const { done, value } = await reader.read();
      if (done) return;
      dropped += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run 6.3 (P-114): a large route refused before its body was read drains it
 * like an oversized declared body: read and dropped (never kept, never
 * counted) up to DISCARD_MAX_BYTES, so the peer gets the answer, not a reset.
 */
export async function drainBody(request: Request): Promise<void> {
  if (request.bodyUsed) return;
  await discard(request, DISCARD_MAX_BYTES).catch(() => undefined);
}

/**
 * Reads at most `limit` bytes of the body; one byte more is a refusal. Reports
 * every byte it read through `counted`, so the request log can show it.
 */
async function readLimited(
  request: Request,
  limit: number,
  counted: (bytes: number) => void,
): Promise<Uint8Array> {
  const reader = request.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      counted(value.byteLength);
      if (total > limit) {
        over = true;
        break;
      }
      chunks.push(value);
    }
    if (over) {
      // As for a declared length (above): the rest is read and dropped, never
      // kept, up to DISCARD_MAX_BYTES, so a peer still uploading gets the 400
      // and not a reset (Run 6.3: the source step's await made that race show).
      let dropped = total;
      while (dropped < DISCARD_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        dropped += value.byteLength;
      }
      throw malformed();
    }
  } finally {
    // Stop reading: what is left of an oversized body is never consumed.
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/**
 * Reads the body the route takes, applying every rule above. Answers
 * `undefined` for a route without a body, the parsed JSON for a JSON route and
 * the bytes (valid UTF-8) for a dotenv route.
 */
export async function readBody(
  request: Request,
  route: RouteDef,
  counted: (bytes: number) => void,
): Promise<unknown> {
  const length = request.headers.get("content-length");
  const chunked = request.headers.get("transfer-encoding") !== null;
  const declared = length === null ? null : Number(length);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) throw malformed();
  const hasBody = chunked || (declared !== null && declared > 0);
  const kind = route.method === "GET" ? "none" : bodyKindOf(route);

  if (kind === "none") {
    if (hasBody) throw malformed();
    return undefined;
  }
  const limit = bodyLimitOf(route);
  if (declared !== null && declared > limit) {
    if (declared <= DISCARD_MAX_BYTES) await discard(request, declared).catch(() => undefined);
    throw malformed();
  }
  const expected = kind === "json" ? "application/json" : "text/plain";
  if (mediaType(request.headers.get("content-type")) !== expected) throw malformed();

  const bytes = await readLimited(request, limit, counted);
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw malformed();
  }
  // A dotenv body (Run 4.7) stays bytes: the file's HMAC binds exactly what was
  // sent, and the parser sees a byte-order mark the decoder would drop.
  if (kind === "text") return bytes;
  const parsed = parseStrictJson(text, LIMITS.body.jsonMaxDepth);
  if (!parsed.ok) throw malformed();
  return parsed.value;
}

/**
 * The body of an auth route (Run 3.2): the same rules with the auth limit. A
 * request without any body counts as `{}` (sign-out, enroll); a GET has none.
 */
export async function readAuthBody(
  request: Request,
  counted: (bytes: number) => void,
): Promise<unknown> {
  const length = request.headers.get("content-length");
  const chunked = request.headers.get("transfer-encoding") !== null;
  const empty = !chunked && (length === null || length === "0");
  if (request.method === "GET") {
    if (!empty) throw malformed();
    return undefined;
  }
  if (empty && request.headers.get("content-type") === null) return {};
  return readBody(request, AUTH_BODY_ROUTE, counted);
}

/** The shape `readBody` needs for an auth route: a JSON body under /v1/auth. */
const AUTH_BODY_ROUTE = {
  id: "auth.body",
  method: "POST",
  path: "/v1/auth/",
  auth: "public",
  idempotent: false,
  ownerRun: "3.2",
  pending: true,
  request: { body: "pending" },
  responses: {},
  errors: [],
  action: null,
  scope: "none",
} as const satisfies RouteDef;
