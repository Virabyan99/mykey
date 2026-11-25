// The CLI's test server (P-97): HTTPS with a certificate made at run time,
// answering the routes the CLI calls with bodies checked against the
// contract's own schemas. A script replaces or damages single answers. It
// records what it saw, and of the Authorization header only whether one came
// and the SHA-256 of its bearer (`seen`), never the bearer.
//
// Session 11 (Run 11.4): `POST /v1/machine/exchange` answers a token this
// server made (`exchangedToken`), and a machine route refuses a bearer of the
// client secret's shape, as the API does.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import {
  API_MAJOR,
  ROUTES,
  errorEnvelopeSchema,
  machineExchangeBody,
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

/** One answer, or a sequence answered in order whose last entry repeats. */
type Answers = Reply | "hang" | readonly (Reply | "hang")[];

export interface ServerScript {
  cert?: "good" | "other-host" | "expired";
  version?: Answers;
  keys?: Answers;
  resolve?: Answers;
  exchange?: Answers;
}

/** What `requests` does not hold: one entry for each request, in the same order. */
export interface SeenDetail {
  method: string;
  path: string;
  /** SHA-256 (hex) of the bearer, or null when no `Bearer` header came. */
  bearerSha: string | null;
  contentLength: string | null;
  /** How many bytes of a body arrived. */
  bodyBytes: number;
}

/** The answer to the `seen`th request (0-based) of a route. */
function nth(answers: Answers | undefined, seen: number): Reply | "hang" | undefined {
  if (answers === undefined || !Array.isArray(answers))
    return answers as Reply | "hang" | undefined;
  const list = answers as readonly (Reply | "hang")[];
  return list[Math.min(seen, list.length - 1)];
}

export interface CliServer {
  url: string;
  caPath: string;
  requests: SeenRequest[];
  seen: SeenDetail[];
  /** The token an exchange answers unless the script says otherwise (synthetic, made at start). */
  exchangedToken: string;
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

export const goodExchange = (token: string): Record<string, unknown> =>
  machineExchangeBody.parse({
    apiMajor: API_MAJOR,
    token,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    projectId: PROJECT,
    environmentName: ENV_NAME,
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
  const seen: SeenDetail[] = [];
  const exchangedToken = `s.${randomBytes(18).toString("base64url")}`;
  const counts = { version: 0, keys: 0, resolve: 0, exchange: 0 };
  const server = https.createServer(
    { cert: readFileSync(pair.cert), key: readFileSync(pair.key) },
    (request, response) => {
      const path = request.url ?? "";
      requests.push({
        method: request.method ?? "",
        path,
        hadAuthorization: request.headers.authorization !== undefined,
      });
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? null;
      const detail: SeenDetail = {
        method: request.method ?? "",
        path,
        bearerSha:
          bearer === null ? null : createHash("sha256").update(bearer, "utf8").digest("hex"),
        contentLength: request.headers["content-length"] ?? null,
        bodyBytes: 0,
      };
      seen.push(detail);
      request.on("data", (chunk: Buffer) => {
        detail.bodyBytes += chunk.length;
      });
      request.resume();
      const machine = MACHINE.exec(path);
      let reply: Reply | "hang";
      if (request.method === "GET" && path === "/v1/version") {
        reply = nth(script.version, counts.version++) ?? { status: 200, body: goodVersion() };
      } else if (request.method === "POST" && path === "/v1/machine/exchange") {
        reply =
          bearer === null
            ? errorReply(401, "unauthenticated").reply
            : (nth(script.exchange, counts.exchange++) ?? {
                status: 200,
                body: goodExchange(exchangedToken),
              });
      } else if (machine !== null && (bearer === null || bearer.startsWith("mkrc."))) {
        // A client secret is not a machine token: the API finds no token for it.
        reply = errorReply(401, "unauthenticated").reply;
      } else if (request.method === "GET" && machine?.[3] === "keys") {
        reply = nth(script.keys, counts.keys++) ?? { status: 200, body: goodKeys() };
      } else if (request.method === "POST" && machine?.[3] === "resolve") {
        reply = nth(script.resolve, counts.resolve++) ?? { status: 200, body: goodResolve() };
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
    seen,
    exchangedToken,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
