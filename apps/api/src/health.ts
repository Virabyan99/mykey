// GET /health: one `SELECT 1` as the API's runtime role, over TLS that
// verifies the server certificate and host name (the connection settings come
// from @mykey/db, which has no way to turn verification off); and, on a host
// with OpenBao (Run 2.7), `GET /v1/sys/health` over verified TLS, which
// answers 200 only when OpenBao is initialised, unsealed and active.
import { readFileSync } from "node:fs";
import https from "node:https";
import { connectionConfig, type DbTarget } from "@mykey/db";
import pg from "pg";

/** Why the database did not answer. Never carries text from the server or the target. */
export type HealthCause =
  | "timeout"
  | "certificate"
  | "unreachable"
  | "login_refused"
  | "error"
  | "openbao_sealed"
  | "openbao_down";

export interface OpenBaoHealthTarget {
  url: string;
  caCertPath: string;
}

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

/** OpenBao's own health answer: 200 up, 503 sealed, anything else or no answer down. */
function openBaoReading(target: OpenBaoHealthTarget, ca: Buffer): Promise<HealthReading> {
  return new Promise((resolve) => {
    const request = https.get(
      new URL("/v1/sys/health", target.url),
      { ca, agent: false, timeout: HEALTH_DEADLINE_MS },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        if (status === 200) resolve({ up: true });
        else if (status === 503) resolve({ up: false, cause: "openbao_sealed", code: "503" });
        else resolve({ up: false, cause: "openbao_down", code: String(status) });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", (error: NodeJS.ErrnoException) => {
      resolve({ up: false, cause: "openbao_down", code: error.code ?? null });
    });
  });
}

export function createHealthCheck(target: DbTarget, openbao?: OpenBaoHealthTarget): HealthCheck {
  const baoCa = openbao === undefined ? undefined : readFileSync(openbao.caCertPath);
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
    const database = pool.query("SELECT 1").then(
      (): HealthReading => ({ up: true }),
      (error: unknown): HealthReading => ({ up: false, ...classifyFailure(error) }),
    );
    const bao: Promise<HealthReading> =
      openbao === undefined || baoCa === undefined
        ? Promise.resolve({ up: true })
        : openBaoReading(openbao, baoCa);
    // The database's cause is reported first: it is the one /health always had.
    const query = Promise.all([database, bao]).then(([db, vault]) => (db.up ? vault : db));
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
