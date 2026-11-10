// Connections to PostgreSQL. Every connection uses TLS and verifies the server
// certificate and host name against the given CA; there is no way to turn that off.
import { readFileSync } from "node:fs";
import pg from "pg";

export interface DbTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** PEM file of the certificate authority that signed the server certificate. */
  caCertPath: string;
}

const CONNECT_TIMEOUT_MS = 10_000;

export function connectionConfig(target: DbTarget): pg.ClientConfig {
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    ssl: { ca: readFileSync(target.caCertPath, "utf8"), rejectUnauthorized: true },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  };
}

export function createPool(target: DbTarget, opts: { max?: number } = {}): pg.Pool {
  const pool = new pg.Pool({ ...connectionConfig(target), max: opts.max ?? 10 });
  // An idle connection that breaks must not crash the process; the next query reconnects.
  pool.on("error", () => undefined);
  return pool;
}
