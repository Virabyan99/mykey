// The API process: an HTTPS listener in front of the app. TLS on this hop is
// required by Doc 06 §2 (the proxy verifies this certificate).
import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createAuth, loadAuthKeys } from "@mykey/auth";
import { createPool, type DbTarget } from "@mykey/db";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { createHealthCheck, type OpenBaoHealthTarget } from "./health.ts";
import { createLogger, type LogEntry } from "./log.ts";
import { startOutboxDispatcher } from "./outbox-dispatcher.ts";
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
  log: (entry: LogEntry) => void;
}

export async function startServer(config: ServerConfig): Promise<ApiServer> {
  const health = createHealthCheck(config.database, config.openbao);
  const pool = createPool(config.database, { max: 20 });
  const keys = loadAuthKeys(config.keysDirectory);
  const auth = createAuth({ db: drizzle(pool), keys, baseURL: config.api.baseUrl });
  const app = createApp({
    pool,
    config: config.api,
    health: () => health.check(),
    log: config.log,
    // Without throttling the auth routes refuse to mount: no start (Run 3.3 adds it).
    auth: { auth, keys },
  });
  const server = await listen(app, config);
  const dispatcher = startOutboxDispatcher(pool, config.log);
  return {
    port: server.port,
    async close() {
      await dispatcher.stop();
      await server.close();
      await health.close();
      await pool.end();
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
    keysDirectory: env.MYKEY_KEYS_DIR ?? "/run/mykey/keys",
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
  const stop = (): void => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
