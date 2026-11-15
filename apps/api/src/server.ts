// The API process: an HTTPS listener in front of the app. TLS on this hop is
// required by Doc 06 §2 (the proxy verifies this certificate).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createAuth, createThrottle, loadAuthKeys } from "@mykey/auth";
import { LIMITS } from "@mykey/contracts";
import { createPool, type DbTarget } from "@mykey/db";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { createHealthCheck, type OpenBaoHealthTarget } from "./health.ts";
import { issuerBaoFromDirectory, runtimeBaoFromDirectory } from "./runtime-bao.ts";
import { issuerSelfCheck, runtimeSelfCheck } from "./selfcheck.ts";
import { createLogger, type LogEntry } from "./log.ts";
import { startOperationSweep } from "./operation-sweep.ts";
import { startOutboxDispatcher } from "./outbox-dispatcher.ts";
import { startSessionCleanup, startThrottleSweep } from "./throttle-sweep.ts";
import type { ApiConfig, ApiEnv } from "./pipeline/context.ts";

export interface ListenOptions {
  hostname: string;
  /** 0 picks a free port. */
  port: number;
  tls: { certPath: string; keyPath: string };
}

export interface ApiServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Serves `app` over HTTPS. Node's own header limit is set above the API's
 * (LIMITS.body.headersMaxBytes), so the pipeline is the one that refuses
 * oversized headers, with the error envelope.
 */
export function listen(app: Hono<ApiEnv>, options: ListenOptions): Promise<ApiServer> {
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: options.hostname,
        port: options.port,
        createServer: https.createServer,
        serverOptions: {
          cert: readFileSync(options.tls.certPath),
          key: readFileSync(options.tls.keyPath),
          minVersion: "TLSv1.2",
          maxHeaderSize: 64 * 1024,
        },
      },
      (info: AddressInfo) => {
        resolve({
          port: info.port,
          close: () =>
            new Promise<void>((done, failed) => {
              server.close((error) => {
                if (error === undefined) done();
                else failed(error);
              });
              // Idle keep-alive connections would hold `close` open.
              if ("closeAllConnections" in server) server.closeAllConnections();
            }),
        });
      },
    );
    server.once("error", reject);
  });
}

export interface ServerConfig extends ListenOptions {
  database: DbTarget;
  /** On a host with OpenBao (Run 2.7): /health also requires it unsealed. */
  openbao?: OpenBaoHealthTarget;
  api: ApiConfig;
  /** The key files of the auth module (read-only mount on a host). */
  keysDirectory: string;
  /** The credential files (organization-id, runtime-role-id, runtime-secret-id, issuer-role-id, issuer-secret-id). */
  secretsDirectory?: string;
  log: (entry: LogEntry) => void;
}

/** P-66: of the process's connections, this many are dedicated lock connections. */
export const LOCK_POOL_SIZE = 8;

export async function startServer(config: ServerConfig): Promise<ApiServer> {
  const health = createHealthCheck(config.database, config.openbao);
  const pool = createPool(config.database, {
    max: LIMITS.db.apiPool - LOCK_POOL_SIZE,
    queryTimeoutMs: LIMITS.deadlines.requestMs,
  });
  // One connection per secret action or value read, holding the environment's lock (P-66).
  const lockPool = createPool(config.database, {
    max: LOCK_POOL_SIZE,
    queryTimeoutMs: LIMITS.deadlines.largeRequestMs,
  });
  const keys = loadAuthKeys(config.keysDirectory);
  const auth = createAuth({ db: drizzle(pool), keys, baseURL: config.api.baseUrl });
  const app = createApp({
    pool,
    lockPool,
    ...(config.openbao === undefined
      ? {}
      : {
          bao: runtimeBaoFromDirectory(
            config.openbao,
            config.secretsDirectory ?? "/run/mykey/secrets",
          ),
          issuer: issuerBaoFromDirectory(
            config.openbao,
            config.secretsDirectory ?? "/run/mykey/secrets",
          ),
        }),
    bootId: randomUUID(),
    config: config.api,
    health: () => health.check(),
    log: config.log,
    auth: { auth, keys, throttle: createThrottle({ pool, ring: keys.rateLimit }) },
  });
  const server = await listen(app, config);
  const dispatcher = startOutboxDispatcher(pool, config.log);
  const sweep = startThrottleSweep(pool, config.log);
  const sessionCleanup = startSessionCleanup(pool, config.log);
  const operationSweep = startOperationSweep(pool, config.log);
  return {
    port: server.port,
    async close() {
      operationSweep.stop();
      sweep.stop();
      sessionCleanup.stop();
      await dispatcher.stop();
      await server.close();
      await health.close();
      await pool.end();
      await lockPool.end();
    },
  };
}

/** A setting the container must have; its absence refuses the start, naming it. */
export class MissingSetting extends Error {
  readonly setting: string;

  constructor(setting: string, problem = "is not set") {
    super(`${setting} ${problem}`);
    this.name = "MissingSetting";
    this.setting = setting;
  }
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (value === undefined || value === "") throw new MissingSetting(name);
  return value;
};

/**
 * Settings of the container. Only paths, names and addresses come from the
 * environment; the database password is read from a file (Doc 10 Run 2.5).
 */
export function configFromEnvironment(env: NodeJS.ProcessEnv): Omit<ServerConfig, "log"> {
  const port = Number(env.MYKEY_API_PORT ?? "8443");
  const databasePort = Number(env.MYKEY_DB_PORT ?? "5432");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new MissingSetting("MYKEY_API_PORT", "is not a port");
  }
  if (!Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65_535) {
    throw new MissingSetting("MYKEY_DB_PORT", "is not a port");
  }
  const build = required(env, "MYKEY_BUILD");
  if (!/^[0-9a-f]{7,40}$/.test(build)) throw new MissingSetting("MYKEY_BUILD", "is not a commit");
  const baseUrl = required(env, "MYKEY_BASE_URL");
  if (new URL(baseUrl).origin !== baseUrl) {
    throw new MissingSetting("MYKEY_BASE_URL", "is not an origin");
  }
  return {
    hostname: env.MYKEY_API_HOST ?? "0.0.0.0",
    port,
    tls: {
      certPath: required(env, "MYKEY_API_TLS_CERT_FILE"),
      keyPath: required(env, "MYKEY_API_TLS_KEY_FILE"),
    },
    database: {
      host: required(env, "MYKEY_DB_HOST"),
      port: databasePort,
      database: env.MYKEY_DB_NAME ?? "postgres",
      user: env.MYKEY_DB_USER ?? "api_runtime",
      password: readFileSync(required(env, "MYKEY_DB_PASSWORD_FILE"), "utf8").trim(),
      caCertPath: required(env, "MYKEY_DB_CA_FILE"),
    },
    // Without MYKEY_BAO_URL (production in Session 2) /health checks PostgreSQL only.
    ...(env.MYKEY_BAO_URL === undefined || env.MYKEY_BAO_URL === ""
      ? {}
      : { openbao: { url: env.MYKEY_BAO_URL, caCertPath: required(env, "MYKEY_BAO_CA_FILE") } }),
    keysDirectory: env.MYKEY_AUTH_RINGS_DIR ?? "/run/mykey/keys",
    secretsDirectory: env.MYKEY_API_SECRETS_DIR ?? "/run/mykey/secrets",
    api: {
      baseUrl,
      build,
      gatePath: required(env, "MYKEY_GATE_PATH"),
      hostInstanceId: required(env, "MYKEY_HOST_INSTANCE_ID"),
      trustedProxy:
        env.MYKEY_TRUSTED_PROXY === undefined || env.MYKEY_TRUSTED_PROXY === ""
          ? null
          : env.MYKEY_TRUSTED_PROXY,
    },
  };
}

if (import.meta.main) {
  const log = createLogger((line) => process.stdout.write(line));
  let settings: Omit<ServerConfig, "log">;
  try {
    settings = configFromEnvironment(process.env);
  } catch (error) {
    // One typed line naming what is missing, never a value (Review focus 5).
    log({
      event: "startup_refused",
      missing: error instanceof MissingSetting ? error.setting : "configuration",
    });
    process.exit(1);
  }
  const server = await startServer({ ...settings, log });
  log({ event: "listening", port: server.port });
  // Run 3.8: the delivered runtime credential logs in (a log line only).
  log({
    event: "selfcheck",
    runtimeLogin: await runtimeSelfCheck(
      settings.openbao,
      settings.secretsDirectory ?? "/run/mykey/secrets",
    ).catch(() => "unreachable" as const),
    // Run 5.1 (P-85): the issuer credential logs in and revokes itself; it does not gate /health.
    issuerLogin: await issuerSelfCheck(
      settings.openbao,
      settings.secretsDirectory ?? "/run/mykey/secrets",
    ).catch(() => "unreachable" as const),
  });
  const stop = (): void => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
