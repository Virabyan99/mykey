// The database half of GET /health: one `SELECT 1` as the API's runtime role,
// over TLS that verifies the server certificate and host name (the connection
// settings come from @mykey/db, which has no way to turn verification off).
import { connectionConfig, type DbTarget } from "@mykey/db";
import pg from "pg";

/** Why the database did not answer. Never carries text from the server or the target. */
export type HealthCause = "timeout" | "certificate" | "unreachable" | "login_refused" | "error";

export type HealthReading = { up: true } | { up: false; cause: HealthCause; code: string | null };

export interface HealthCheck {
  /** Never rejects; answers within the deadline. */
  check(): Promise<HealthReading>;
  close(): Promise<void>;
}

/** Doc 10 Run 2.5: the answer must arrive within 2 s, otherwise the API is down. */
export const HEALTH_DEADLINE_MS = 2_000;

/** A reading is reused for this long, so a flood of /health requests costs one query. */
const REUSE_MS = 1_000;

const CERTIFICATE_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);
// invalid_authorization_specification, invalid_password
const LOGIN_CODES = new Set(["28000", "28P01"]);

export function classifyFailure(error: unknown): { cause: HealthCause; code: string | null } {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  if (code === "ETIMEDOUT") return { cause: "timeout", code };
  if (code !== null && CERTIFICATE_CODES.has(code)) return { cause: "certificate", code };
  if (code !== null && UNREACHABLE_CODES.has(code)) return { cause: "unreachable", code };
  if (code !== null && LOGIN_CODES.has(code)) return { cause: "login_refused", code };
  return { cause: "error", code };
}

export function createHealthCheck(target: DbTarget): HealthCheck {
  const pool = new pg.Pool({
    ...connectionConfig(target),
    max: 1,
    connectionTimeoutMillis: HEALTH_DEADLINE_MS,
    query_timeout: HEALTH_DEADLINE_MS,
    idleTimeoutMillis: 30_000,
  });
  // An idle connection that breaks must not crash the process; the next check reconnects.
  pool.on("error", () => undefined);

  let last: { at: number; reading: HealthReading } | undefined;
  let running: Promise<HealthReading> | undefined;

  const measure = async (): Promise<HealthReading> => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<HealthReading>((resolve) => {
      timer = setTimeout(() => {
        resolve({ up: false, cause: "timeout", code: null });
      }, HEALTH_DEADLINE_MS);
    });
    const query = pool.query("SELECT 1").then(
      (): HealthReading => ({ up: true }),
      (error: unknown): HealthReading => ({ up: false, ...classifyFailure(error) }),
    );
    try {
      return await Promise.race([query, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    check() {
      if (last !== undefined && Date.now() - last.at < REUSE_MS) {
        return Promise.resolve(last.reading);
      }
      running ??= measure().then((reading) => {
        last = { at: Date.now(), reading };
        running = undefined;
        return reading;
      });
      return running;
    },
    close: () => pool.end(),
  };
}
