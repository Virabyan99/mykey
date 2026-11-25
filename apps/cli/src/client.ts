// The CLI's connection to the API (P-96, FR-1.79). `node:https` directly: one
// request per call on its own socket (`agent: false`), certificate
// verification always on, no proxy, no redirect followed (a 3xx is refused and
// its location never read), a total deadline, and the body read to its end
// into one buffer with a hard cap. `GET /v1/version` goes first without a
// credential; the bearer is sent only after its apiMajor matched. Nothing here
// logs, and no error carries a body, a header value or the token.
import https from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import { rootCertificates } from "node:tls";
import { API_MAJOR, LIMITS, ROUTES, errorEnvelopeSchema } from "@mykey/contracts";
import type { z } from "zod";
import { CliError, categoryOf } from "./errors.ts";
import { CLI_VERSION } from "./identity.ts";
import {
  validateKeys,
  validateResolve,
  type KeysBody,
  type ResolveBody,
  type ResponseHead,
} from "./validate.ts";

/** The environment a command asks for. */
export interface Selector {
  project: string;
  env: string;
}

export interface ApiClient {
  version(): Promise<{ apiMajor: number }>;
  keys(s: Selector, token: string): Promise<KeysBody>;
  resolve(s: Selector, token: string): Promise<ResolveBody>;
}

const BODY_CAP = LIMITS.completeResponse.maxBodyBytes + 64 * 1024;
const SHORT_MS = 30_000;
const RESOLVE_MS = 150_000;
/**
 * A machine read refused with 503 busy (the API's large-request gate, the
 * environment's lock) is asked again after these pauses: a read has no effect,
 * and instances started together would otherwise lose one (gate review of
 * Session 5). Any other refusal is final at once.
 *
 * Session 11 (Run 11.3, D-83): ten requests in 13.75 s, where there were five
 * in 3.75 s. Complete reads of one environment are admitted about two every
 * 1.6 s (D-49's read cool-down), so ten instances started together need up to
 * seven requests each (measured); with five, two of the ten did not start.
 */
const BUSY_PAUSES_MS = [250, 500, 1_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000] as const;

const versionSchema = ROUTES.find((route) => route.id === "version.get")?.responses[200] as
  z.ZodType | undefined;

/** TLS failures that mean "this is not the API we trust", told apart for the user. */
const CERTIFICATE_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);

interface Answer {
  head: ResponseHead;
  body: Buffer;
}

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join(", ") : value;

export function createClient(
  apiUrl: URL,
  opts: {
    timeoutMs?: number;
    /** Adds trust, never replaces it: SECRETS_CA_FILE only (D-68). */
    extraCa?: string;
  } = {},
): ApiClient {
  const ca = opts.extraCa === undefined ? undefined : [...rootCertificates, opts.extraCa];
  let versionChecked = false;

  function call(method: "GET" | "POST", path: string, token: string | null, deadlineMs: number) {
    return new Promise<Answer>((resolve, reject) => {
      const headers: Record<string, string> = {
        accept: "application/json",
        "accept-encoding": "identity",
        "user-agent": `secrets/${CLI_VERSION}`,
      };
      if (token !== null) headers.authorization = `Bearer ${token}`;
      if (method === "POST") headers["content-length"] = "0";
      let settled = false;
      const fail = (error: CliError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.destroy();
        reject(error);
      };
      const request = https.request({
        protocol: "https:",
        hostname: apiUrl.hostname.replace(/^\[|\]$/g, ""),
        port: apiUrl.port === "" ? 443 : Number(apiUrl.port),
        path,
        method,
        headers,
        agent: false,
        rejectUnauthorized: true,
        ...(ca === undefined ? {} : { ca }),
      });
      const timer = setTimeout(() => {
        fail(new CliError("unavailable", "the API did not answer in time"));
      }, opts.timeoutMs ?? deadlineMs);
      request.on("error", (error: NodeJS.ErrnoException) => {
        fail(
          CERTIFICATE_CODES.has(error.code ?? "")
            ? new CliError("unavailable", "the API's certificate is not trusted for this address")
            : new CliError("unavailable", "could not reach the API"),
        );
      });
      request.on("response", (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          fail(
            new CliError(
              "unavailable",
              "the API answered a redirect; redirects are never followed",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > BODY_CAP) {
            response.destroy();
            fail(new CliError("malformed", "the answer is larger than any answer of the API"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => {
          fail(new CliError("unavailable", "the connection broke during the answer"));
        });
        response.on("close", () => {
          if (!response.complete) {
            fail(new CliError("unavailable", "the connection broke during the answer"));
          }
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            head: {
              status,
              contentLength: single(response.headers["content-length"]),
              contentType: single(response.headers["content-type"]),
              contentEncoding: single(response.headers["content-encoding"]),
            },
            body: Buffer.concat(chunks),
          });
        });
      });
      request.end();
    });
  }

  /** The contract's error envelope of an answer, or null when it is not one. */
  function envelopeOf(answer: Answer): z.infer<typeof errorEnvelopeSchema> | null {
    try {
      const parsed = errorEnvelopeSchema.safeParse(JSON.parse(answer.body.toString("utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** An answer other than 200: the contract's envelope when it is one, else the status alone. */
  function refusal(answer: Answer): CliError {
    const envelope = envelopeOf(answer);
    const code = envelope?.error.code ?? null;
    const category = categoryOf(answer.head.status, code);
    return new CliError(category, `the API answered ${String(answer.head.status)}`, {
      ...(code === null ? {} : { code }),
      ...(envelope === null ? {} : { requestId: envelope.error.requestId }),
    });
  }

  async function version(): Promise<{ apiMajor: number }> {
    const answer = await call("GET", "/v1/version", null, SHORT_MS);
    if (answer.head.status !== 200) throw refusal(answer);
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.body.toString("utf8"));
    } catch {
      throw new CliError("malformed", "the version answer is not JSON");
    }
    const major = (parsed as { apiMajor?: unknown } | null)?.apiMajor;
    if (typeof major === "number" && Number.isInteger(major) && major !== API_MAJOR) {
      throw new CliError(
        "incompatible",
        `the API speaks major version ${String(major)}; this CLI speaks ${String(API_MAJOR)}`,
      );
    }
    if (!versionSchema?.safeParse(parsed).success) {
      throw new CliError("malformed", "the version answer is not the API's version body");
    }
    versionChecked = true;
    return { apiMajor: API_MAJOR };
  }

  const machinePath = (s: Selector, route: "keys" | "resolve"): string =>
    `/v1/machine/projects/${s.project}/environments/${s.env}/${route}`;

  /** A machine read, asked again while the API answers 503 busy (BUSY_PAUSES_MS). */
  async function machineRead(
    method: "GET" | "POST",
    path: string,
    token: string,
    deadlineMs: number,
  ): Promise<Answer> {
    for (const pause of [...BUSY_PAUSES_MS, null]) {
      const answer = await call(method, path, token, deadlineMs);
      const busy = answer.head.status === 503 && envelopeOf(answer)?.error.code === "busy";
      if (!busy || pause === null) return answer;
      await sleep(pause);
    }
    throw new Error("unreachable");
  }

  return {
    version,
    async keys(s, token) {
      if (!versionChecked) await version();
      const answer = await machineRead("GET", machinePath(s, "keys"), token, SHORT_MS);
      if (answer.head.status !== 200) throw refusal(answer);
      return validateKeys(answer.body, answer.head);
    },
    async resolve(s, token) {
      if (!versionChecked) await version();
      const answer = await machineRead("POST", machinePath(s, "resolve"), token, RESOLVE_MS);
      if (answer.head.status !== 200) throw refusal(answer);
      return validateResolve(answer.body, answer.head);
    },
  };
}
