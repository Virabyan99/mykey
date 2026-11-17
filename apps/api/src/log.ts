// The API's log (P-42). First defence: one entry type per event and no
// free-form object — an entry cannot hold a body, a query string, a URL or a
// header value it was not designed for. Second defence: before a line is
// written, any key with a denied name, at any depth and in any case, is
// replaced by "[redacted]".
import type { ErrorCode } from "@mykey/contracts";
import type { GateCause } from "./pipeline/gate.ts";
import type { HealthCause } from "./health.ts";

export type LogEntry =
  | {
      event: "request";
      time: string;
      requestId: string;
      method: string;
      /** The route pattern (`/v1/organizations/:org/projects`), never the URL; null when nothing matched. */
      path: string | null;
      status: number;
      durationMs: number;
      /** Bytes of the request body the API read; it stops reading at the route's limit. */
      bodyBytesRead: number;
      /** The address of the TCP peer: the proxy in production. */
      peer: string | null;
      /** The X-Forwarded-For value as received. Informational; Run 3.3 decides what is believed. */
      forwardedFor: string | null;
      /** The X-Forwarded-Proto value as received. Informational. */
      forwardedProto: string | null;
    }
  | {
      event: "health_down";
      time: string;
      requestId: string;
      cause: HealthCause;
      code: string | null;
    }
  | { event: "gate_closed"; time: string; requestId: string; cause: GateCause }
  | {
      event: "unhandled";
      time: string;
      requestId: string | null;
      routeId: string | null;
      errorClass: string;
    }
  | { event: "unlisted_error"; time: string; requestId: string; routeId: string; code: ErrorCode }
  | { event: "output_invalid"; time: string; requestId: string; routeId: string; status: number }
  /** Run 6.1 (P-107): a stored audit row whose details fail its schema; served with `{}`. */
  | { event: "output_invalid"; time: string; requestId: string; routeId: string; eventId: string }
  | { event: "outbox"; time: string; outcome: "failed"; errorClass: string }
  /** Run 5.9: the reference's asset is not in the image; reference.get answers 503. */
  | { event: "reference_asset_missing"; time: string }
  | { event: "throttle_sweep"; time: string; outcome: "failed"; errorClass: string }
  | { event: "session_cleanup"; time: string; outcome: "failed"; errorClass: string }
  | { event: "operation_sweep"; time: string; outcome: "failed"; errorClass: string }
  | { event: "operation_sweep"; time: string; uncertain: string[]; rejected: string[] }
  /** Run 5.3: archives the tick finished, by operation id only. */
  | { event: "archive_continue"; time: string; archived: string[] }
  /** Run 5.4 (P-93): a machine token nobody can attribute; counted here, never audited. */
  | {
      event: "machine_unauthenticated";
      time: string;
      requestId: string;
      cause: "header" | "token" | "catalog";
    }
  | { event: "machine_last_used"; time: string; outcome: "failed"; errorClass: string }
  /** Run 6.3 (P-113): a request refused by a rate limit; the scope only, never the subject. */
  | { event: "rate_limited"; time: string; requestId: string; scope: string }
  | { event: "listening"; port: number }
  | { event: "startup_refused"; missing: string }
  | {
      event: "selfcheck";
      runtimeLogin: "ok" | "refused" | "unreachable" | "absent";
      /** Run 5.1 (P-85). */
      issuerLogin?: "ok" | "refused" | "unreachable" | "absent";
    };

const DENIED_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "token",
  "code",
  "secret",
  "value",
  "link",
]);

const REDACTED = "[redacted]";

/** A copy of `value` with every denied key replaced, at any depth. */
export function redactEntry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactEntry);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        DENIED_KEYS.has(key.toLowerCase()) ? REDACTED : redactEntry(child),
      ]),
    );
  }
  return value;
}

/**
 * The settings a refused start may name (Run 6.1, P-109): the names
 * `server.ts` reads, and nothing else (a unit test compares the two).
 */
export const API_SETTINGS: readonly string[] = Object.freeze([
  "MYKEY_API_PORT",
  "MYKEY_API_TLS_CERT_FILE",
  "MYKEY_API_TLS_KEY_FILE",
  "MYKEY_BACKEND_INCARNATION",
  "MYKEY_BAO_CA_FILE",
  "MYKEY_BASE_URL",
  "MYKEY_BUILD",
  "MYKEY_DB_CA_FILE",
  "MYKEY_DB_HOST",
  "MYKEY_DB_PASSWORD_FILE",
  "MYKEY_DB_PORT",
  "MYKEY_GATE_PATH",
  "MYKEY_HOST_INSTANCE_ID",
  "MYKEY_VERIFY_LISTEN",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENUM = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * The third defence (Run 6.1, P-109, FR-1.80): every string field has a
 * format by its name, and a value outside it is written as "[invalid]". A
 * string under a name that has no format is invalid too: a field nobody
 * designed cannot carry a value into the log.
 */
const FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  event: (v) => ENUM.test(v),
  time: (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(v),
  requestId: (v) => UUID.test(v),
  eventId: (v) => UUID.test(v),
  method: (v) => /^[A-Z]{3,7}$/.test(v),
  /** A route pattern of the app: lower-case segments, `:param` and `*`. */
  path: (v) => /^(\/([a-z0-9._-]+|:[a-zA-Z]+|\*))+$|^\/$/.test(v),
  /** Addresses as received: hex digits, dots and colons (commas and spaces in a list); bounded. */
  peer: (v) => v.length <= 64 && /^[0-9a-f:.]+$/i.test(v),
  forwardedFor: (v) => v.length <= 256 && /^[0-9a-f:., ]+$/i.test(v),
  forwardedProto: (v) => v === "http" || v === "https",
  cause: (v) => ENUM.test(v),
  code: (v) => ENUM.test(v),
  outcome: (v) => ENUM.test(v),
  routeId: (v) => /^[a-z]+(\.[a-z]+)+$/.test(v),
  /** A JavaScript class name, or `typeof`'s answer. */
  errorClass: (v) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(v),
  where: (v) => ENUM.test(v),
  uncertain: (v) => UUID.test(v),
  rejected: (v) => UUID.test(v),
  archived: (v) => UUID.test(v),
  missing: (v) => v === "configuration" || API_SETTINGS.includes(v),
  runtimeLogin: (v) => ENUM.test(v),
  issuerLogin: (v) => ENUM.test(v),
  /** Run 6.3: a rate scope (`rl:source`, `rl:machine-miss`, …). */
  scope: (v) => /^rl:[a-z-]{1,32}$/.test(v),
};

const INVALID = "[invalid]";

/** A copy of `value` in which every string outside its field's format is "[invalid]". */
export function conformEntry(value: unknown, key = ""): unknown {
  if (value === REDACTED) return value;
  if (typeof value === "string") return FORMATS[key]?.(value) === true ? value : INVALID;
  if (Array.isArray(value)) return value.map((item: unknown) => conformEntry(item, key));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [name, conformEntry(child, name)]),
    );
  }
  return value;
}

/** A logger that writes one redacted, conformed JSON line per entry. */
export function createLogger(write: (line: string) => void): (entry: LogEntry) => void {
  return (entry) => {
    write(`${JSON.stringify(conformEntry(redactEntry(entry)))}\n`);
  };
}

export const now = (): string => new Date().toISOString();
