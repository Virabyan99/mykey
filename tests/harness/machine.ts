// Machine requests to the test API (Run 5.4): raw HTTPS with full control of
// the headers (two Authorization headers, a cookie beside the bearer), no
// Origin header. The token is a local of the caller; nothing here prints it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import { parseDotenv } from "@mykey/contracts";
import type { SecretsFixture } from "./secrets-fixture.ts";
import type { EnvName } from "./secrets-fixture.ts";

export interface MachineAnswer {
  status: number;
  code: string | undefined;
  body: Record<string, unknown>;
  text: string;
  /** The raw bytes of the body, as received. */
  bytes: Buffer;
  headers: Headers;
}

export interface MachineRequest {
  /** The bearer token, sent as `Authorization: Bearer <token>`; omitted when undefined. */
  token?: string;
  /** Extra headers; an array value sends that header once per element. */
  headers?: Record<string, string | string[]>;
  /** A body as sent (JSON text or bytes) with its content type. */
  body?: { text: string | Buffer; contentType?: string };
  /** A query string, without the `?`. */
  query?: string;
}

const parse = (text: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** One request to the API listening on `port`. */
export function machineFetch(
  target: { port: number; ca: Buffer },
  method: string,
  path: string,
  init: MachineRequest = {},
): Promise<MachineAnswer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | string[]> = {};
    if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      headers[name.toLowerCase()] = value;
    }
    let payload: Buffer | undefined;
    if (init.body !== undefined) {
      payload = Buffer.isBuffer(init.body.text) ? init.body.text : Buffer.from(init.body.text);
      headers["content-type"] = init.body.contentType ?? "application/json";
      headers["content-length"] = String(payload.length);
    }
    const outgoing = https.request(
      {
        host: "127.0.0.1",
        port: target.port,
        path: init.query === undefined ? path : `${path}?${init.query}`,
        method,
        headers,
        ca: target.ca,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const answerHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) for (const v of value) answerHeaders.append(name, v);
            else if (value !== undefined) answerHeaders.set(name, value);
          }
          const bytes = Buffer.concat(chunks);
          const text = bytes.toString("utf8");
          const body = parse(text);
          const error = body.error as { code?: string } | undefined;
          resolve({
            status: response.statusCode ?? 0,
            code: error?.code,
            body,
            text,
            bytes,
            headers: answerHeaders,
          });
        });
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    if (payload !== undefined) outgoing.write(payload);
    outgoing.end();
  });
}

export type MachineRoute = "keys" | "resolve" | "metadata";

/** The machine path of an environment: the project id and the environment's name. */
export function machinePath(projectId: string, envName: string, route: MachineRoute): string {
  return `/v1/machine/projects/${projectId}/environments/${encodeURIComponent(envName)}/${route}`;
}

/** Session 11: the one machine path that names no environment. */
export const EXCHANGE_PATH = "/v1/machine/exchange";

/** `from`: the caller's address as the trusted edge reports it (a fixture with `trustedProxy`). */
const forwarded = (from: string | undefined): Record<string, string> =>
  from === undefined ? {} : { "x-forwarded-for": from };

/**
 * machine.exchange against the fixture's first API. `secret` is the bearer:
 * a runtime credential's client secret, a local of the caller that nothing
 * here prints.
 */
export function exchangeCall(
  f: SecretsFixture,
  init: Omit<MachineRequest, "token"> & {
    secret?: string;
    from?: string;
    to?: "first" | "second";
  } = {},
): Promise<MachineAnswer> {
  const { secret, from, to, ...rest } = init;
  const ca = readFileSync(f.stack.api.certAuthorityPath);
  const port = to === "second" ? (f.second?.port ?? 0) : f.api.port;
  return machineFetch({ port, ca }, "POST", EXCHANGE_PATH, {
    ...rest,
    ...(secret === undefined ? {} : { token: secret }),
    headers: { ...forwarded(from), ...rest.headers },
  });
}

/** The names the tenants fixture gives its environments (tests/harness/tenants.ts). */
export const ENV_NAMES: Record<EnvName, string> = { env1a: "dev", env1b: "prod", env2a: "dev" };

/** A machine call against the fixture's first API: resolve is POST, keys and metadata are GET. */
export function machineCall(
  f: SecretsFixture,
  route: MachineRoute,
  init: MachineRequest & {
    env?: EnvName;
    path?: string;
    to?: "first" | "second";
    /** The caller's address as the trusted edge reports it. */
    from?: string;
  } = {},
): Promise<MachineAnswer> {
  const env = init.env ?? "env1a";
  const path = init.path ?? machinePath(f.env(env).projectId, ENV_NAMES[env], route);
  const port = init.to === "second" ? (f.second?.port ?? 0) : f.api.port;
  const ca = readFileSync(f.stack.api.certAuthorityPath);
  return machineFetch({ port, ca }, route === "resolve" ? "POST" : "GET", path, {
    ...init,
    headers: { ...forwarded(init.from), ...init.headers },
  });
}

/** sha256 of a value, hex: what the machine tests compare instead of values. */
export const digestOf = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * The owner's export of an environment (a fresh session, `{ confirmed: true }`)
 * as digests by name; fails unless it answers 200 with a dotenv body.
 */
export async function exportDigests(f: SecretsFixture, env: EnvName): Promise<Map<string, string>> {
  await f.api.superuser.query("UPDATE auth.session SET totp_verified_at = now()");
  const response = await f.api.request("POST", `${f.env(env).path}/export`, {
    cookie: await f.tenants.cookie("ownerA"),
    body: { confirmed: true },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200) throw new Error(`export answered ${String(response.status)}`);
  const parsed = parseDotenv(bytes);
  if (!parsed.ok) throw new Error("export is not a dotenv file");
  return new Map(parsed.entries.map((entry) => [entry.name, digestOf(entry.value)]));
}

/** A resolve body as digests by name, in the order it came. */
export function resolveDigests(answer: MachineAnswer): [string, string][] {
  const entries = (answer.body.entries ?? []) as { name: string; value: string }[];
  return entries.map((entry) => [entry.name, digestOf(entry.value)]);
}
