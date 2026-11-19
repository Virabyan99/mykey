// GET /health: one `SELECT 1` as the API's runtime role, over TLS that
// verifies the server certificate and host name (the connection settings come
// from @mykey/db, which has no way to turn verification off); and, on a host
// with OpenBao (Run 2.7), `GET /v1/sys/health` over verified TLS, which
// answers 200 only when OpenBao is initialised, unsealed and active.
// Run 6.4 (P-116): also down when an audit row cannot be written (a fixed row
// inserted as the runtime role and rolled back) or an audited OpenBao call
// fails (OpenBao refuses every audited request when its device cannot write).
// Those two are reused for 15 s.
import { readFileSync } from "node:fs";
import https from "node:https";
import { connectionConfig, type DbTarget } from "@mykey/db";
import type { EnvironmentId, ProjectId } from "@mykey/contracts";
import { secretPath } from "@mykey/openbao";
import type { RuntimeBao } from "@mykey/operations";
import pg from "pg";

/** Why the database did not answer. Never carries text from the server or the target. */
export type HealthCause =
  | "timeout"
  | "certificate"
  | "unreachable"
  | "login_refused"
  | "error"
  | "openbao_sealed"
  | "openbao_down"
  /** The service gate is closed (Run 3.1); `code` names the gate's cause. */
  | "gate"
  /** Run 6.4: the runtime role cannot insert into audit.event; `code` is the SQLSTATE. */
  | "audit_unwritable"
  /** Run 6.4: an audited OpenBao call failed (its audit device, or OpenBao); `code` is the status or kind. */
  | "openbao_audit";

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

/** Run 6.4 (P-116): the audit probe and the audited OpenBao call are reused for this long. */
export const DEEP_REUSE_MS = 15_000;

/** One fixed row, inserted and rolled back: it proves audit.event takes a row, and leaves none. */
const AUDIT_PROBE =
  "INSERT INTO audit.event (id, actor_kind, action, outcome) VALUES (gen_random_uuid(), 'system', 'system.health_probe', 'success')";

/**
 * An audited OpenBao call as the API's runtime identity: the metadata of a
 * secret that never exists (inline AppRole holds no token, so `lookup-self`
 * is refused). Its 404 is an audited answer; OpenBao refuses the request when
 * its audit device cannot write. Up while this process holds no runtime
 * credential yet: there is nothing it could reveal.
 */
/** A path under the runtime policy's `kv/metadata/p/*` that no environment can hold. */
const PROBE_PATH = secretPath(
  "00000000-0000-4000-8000-000000000000" as ProjectId,
  "00000000-0000-4000-8000-000000000000" as EnvironmentId,
  "HEALTH_PROBE",
);

export function auditedBaoCall(runtime: RuntimeBao): () => Promise<HealthReading> {
  return async () => {
    const organizationId = runtime.organizationId();
    const client = organizationId === null ? null : runtime.clientFor(organizationId);
    if (client === null) return { up: true };
    const result = await client.kvMetadata(PROBE_PATH);
    if (result.ok || result.kind === "not_found") return { up: true };
    return {
      up: false,
      cause: "openbao_audit",
      code: result.kind === "unknown" ? result.cause : String(result.status),
    };
  };
}

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

export function createHealthCheck(
  target: DbTarget,
  openbao?: OpenBaoHealthTarget,
  opts: { auditedCall?: () => Promise<HealthReading> } = {},
): HealthCheck {
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
  let deepLast: { at: number; reading: HealthReading } | undefined;

  const auditProbe = async (): Promise<HealthReading> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(AUDIT_PROBE);
      return { up: true };
    } catch (error) {
      const failure = classifyFailure(error);
      // A connection failure keeps its own cause; a refused insert is the audit's.
      return failure.cause === "error"
        ? { up: false, cause: "audit_unwritable", code: failure.code }
        : { up: false, ...failure };
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  };

  const deep = async (): Promise<HealthReading> => {
    if (deepLast !== undefined && Date.now() - deepLast.at < DEEP_REUSE_MS) return deepLast.reading;
    const [audit, bao] = await Promise.all([
      auditProbe(),
      opts.auditedCall === undefined
        ? Promise.resolve<HealthReading>({ up: true })
        : opts
            .auditedCall()
            .catch((): HealthReading => ({ up: false, cause: "openbao_audit", code: null })),
    ]);
    const reading = audit.up ? bao : audit;
    deepLast = { at: Date.now(), reading };
    return reading;
  };

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
    const query = Promise.all([database, bao]).then(async ([db, vault]) => {
      if (!db.up) return db;
      if (!vault.up) return vault;
      return deep();
    });
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
