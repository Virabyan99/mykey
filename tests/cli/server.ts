// The CLI's test server (P-97): HTTPS with a certificate made at run time,
// answering the three routes the CLI calls with bodies checked against the
// contract's own schemas. A script replaces or damages single answers. It
// records what it saw, and of the Authorization header only whether one came.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import {
  API_MAJOR,
  ROUTES,
  errorEnvelopeSchema,
  machineKeysBody,
  machineResolveBody,
  type ErrorCode,
} from "@mykey/contracts";
import type { z } from "zod";
import { certPaths } from "./certs.ts";

export interface SeenRequest {
  method: string;
  path: string;
  hadAuthorization: boolean;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  /** An object is sent as JSON; a string or Buffer as it is. */
  body?: unknown;
  /** Sends no content-length (chunked). */
  noLength?: boolean;
}

export interface ServerScript {
  cert?: "good" | "other-host" | "expired";
  version?: Reply | "hang";
  keys?: Reply | "hang";
  resolve?: Reply | "hang";
}

export interface CliServer {
  url: string;
  caPath: string;
  requests: SeenRequest[];
  close(): Promise<void>;
}

export const PROJECT = "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e7f";
export const ENVIRONMENT_ID = "0193a5c0-7b1e-7c3a-9f4e-2b6d8a1c5e70";
export const ENV_NAME = "dev";
export const NAMES = ["ALPHA", "BETA", "GAMMA"];

const versionSchema = ROUTES.find((route) => route.id === "version.get")
  ?.responses[200] as z.ZodType;

export const goodVersion = (): Record<string, unknown> =>
  versionSchema.parse({ apiMajor: API_MAJOR, build: "abcdef123456" }) as Record<string, unknown>;

export const goodKeys = (names: string[] = NAMES): Record<string, unknown> =>
  machineKeysBody.parse({
    apiMajor: API_MAJOR,
    environmentId: ENVIRONMENT_ID,
    generation: "3",
    count: names.length,
    names,
    complete: true,
  });

export const goodResolve = (
  entries: { name: string; value: string }[] = NAMES.map((name) => ({
    name,
    value: `synthetic-${name}`,
  })),
): Record<string, unknown> =>
  machineResolveBody.parse({
    apiMajor: API_MAJOR,
    environmentId: ENVIRONMENT_ID,
    generation: "3",
    count: entries.length,
    entries,
    complete: true,
  });

/** The contract's error envelope; the request id is returned so a test can look for it. */
export function errorReply(status: number, code: ErrorCode): { reply: Reply; requestId: string } {
  const requestId = randomUUID();
  const body = errorEnvelopeSchema.parse({ error: { code, message: "test refusal", requestId } });
  return { reply: { status, body }, requestId };
}

const MACHINE = /^\/v1\/machine\/projects\/([^/]+)\/environments\/([^/]+)\/(keys|resolve)$/;

export async function startCliServer(script: ServerScript = {}): Promise<CliServer> {
  const paths = certPaths();
  const pair =
    script.cert === "other-host"
      ? paths.otherHost
      : script.cert === "expired"
        ? paths.expired
        : paths.good;
  const requests: SeenRequest[] = [];
  const server = https.createServer(
    { cert: readFileSync(pair.cert), key: readFileSync(pair.key) },
    (request, response) => {
      const path = request.url ?? "";
      requests.push({
        method: request.method ?? "",
        path,
        hadAuthorization: request.headers.authorization !== undefined,
      });
      request.resume();
      const machine = MACHINE.exec(path);
      let reply: Reply | "hang";
      if (request.method === "GET" && path === "/v1/version") {
        reply = script.version ?? { status: 200, body: goodVersion() };
      } else if (machine !== null && request.headers.authorization === undefined) {
        reply = errorReply(401, "unauthenticated").reply;
      } else if (request.method === "GET" && machine?.[3] === "keys") {
        reply = script.keys ?? { status: 200, body: goodKeys() };
      } else if (request.method === "POST" && machine?.[3] === "resolve") {
        reply = script.resolve ?? { status: 200, body: goodResolve() };
      } else {
        reply = errorReply(404, "not_found").reply;
      }
      if (reply === "hang") return;
      const isBytes = typeof reply.body === "string" || Buffer.isBuffer(reply.body);
      const bytes =
        reply.body === undefined
          ? Buffer.alloc(0)
          : isBytes
            ? Buffer.from(reply.body as string | Buffer)
            : Buffer.from(JSON.stringify(reply.body), "utf8");
      const headers: Record<string, string> = {
        "content-type": isBytes ? "text/plain" : "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...(reply.noLength === true ? {} : { "content-length": String(bytes.length) }),
        ...reply.headers,
      };
      response.writeHead(reply.status, headers);
      response.end(bytes);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${String(port)}`,
    caPath: paths.ca,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
