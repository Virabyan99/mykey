// The API process: an HTTPS listener in front of the app. TLS on this hop is
// required by Doc 06 §2 (the proxy verifies this certificate).
import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { DbTarget } from "@mykey/db";
import { createApp, type RequestLogEntry } from "./app.ts";
import { createHealthCheck } from "./health.ts";

export interface ServerConfig {
  hostname: string;
  /** 0 picks a free port. */
  port: number;
  tls: { certPath: string; keyPath: string };
  database: DbTarget;
  log: (entry: RequestLogEntry) => void;
}

export interface ApiServer {
  port: number;
  close(): Promise<void>;
}

export function startServer(config: ServerConfig): Promise<ApiServer> {
  const health = createHealthCheck(config.database);
  const app = createApp({ health: () => health.check(), log: config.log });
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: config.hostname,
        port: config.port,
        createServer: https.createServer,
        serverOptions: {
          cert: readFileSync(config.tls.certPath),
          key: readFileSync(config.tls.keyPath),
          minVersion: "TLSv1.2",
        },
      },
      (info: AddressInfo) => {
        resolve({
          port: info.port,
          close: () =>
            new Promise<void>((done, failed) => {
              server.close((error) => {
                health.close().then(() => {
                  if (error === undefined) done();
                  else failed(error);
                }, failed);
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

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
};

/**
 * Settings of the container. Only paths and names come from the environment;
 * the database password is read from a file (Doc 10 Run 2.5: a service reads
 * its secrets from files, never from environment variables).
 */
export function configFromEnvironment(env: NodeJS.ProcessEnv): Omit<ServerConfig, "log"> {
  const port = Number(env.MYKEY_API_PORT ?? "8443");
  const databasePort = Number(env.MYKEY_DB_PORT ?? "5432");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("MYKEY_API_PORT is not a port");
  }
  if (!Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65_535) {
    throw new Error("MYKEY_DB_PORT is not a port");
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
  };
}

if (import.meta.main) {
  const log = (entry: RequestLogEntry): void => {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  };
  const server = await startServer({ ...configFromEnvironment(process.env), log });
  process.stdout.write(`${JSON.stringify({ event: "listening", port: server.port })}\n`);
  const stop = (): void => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
