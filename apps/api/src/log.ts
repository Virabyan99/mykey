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
  | { event: "outbox"; time: string; outcome: "failed"; errorClass: string }
  | { event: "listening"; port: number }
  | { event: "startup_refused"; missing: string };

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

/** A logger that writes one redacted JSON line per entry. */
export function createLogger(write: (line: string) => void): (entry: LogEntry) => void {
  return (entry) => {
    write(`${JSON.stringify(redactEntry(entry))}\n`);
  };
}

export const now = (): string => new Date().toISOString();
