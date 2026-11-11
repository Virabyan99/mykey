// The narrow OpenBao client used by the runtime, the issuer and machines.
//
// Rules (Doc 06 §5, Run 2.1 "Design fixed here"):
// - Every namespace and path argument must have the shape paths.ts produces;
//   anything else throws before a request is sent.
// - One call is one HTTPS request. Nothing is retried and nothing is guessed.
// - A deadline that expires is `unknown/timeout`, whether or not the connection
//   was established. A connection that breaks after the TLS handshake is
//   `unknown/connection_lost`: the request may have been applied. A refused
//   connection or a failed certificate check is `invalid` with status 0.
// - No token, secret id or value is ever put into an error message.
import { readFileSync } from "node:fs";
import https from "node:https";
import { LIMITS } from "@mykey/contracts";
import {
  isEnvironmentPrefix,
  isMachineName,
  isOrganizationNamespace,
  isSecretPath,
} from "./paths.ts";

export interface OpenBaoTarget {
  url: string;
  caCertPath: string;
}

/** Sent as `x-mykey-operation-id` / `x-mykey-dispatch-id` and recorded by the audit device. */
export interface Correlation {
  operationId: string;
  dispatchId: string;
}

export interface SecretEnvelope {
  value: string;
  operation_id: string;
  format: 1;
}

export type BaoFailureKind = "denied" | "not_found" | "cas_mismatch" | "sealed" | "invalid";

export type BaoResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; kind: BaoFailureKind; status: number }
  /** The request may have been applied. */
  | { ok: false; kind: "unknown"; cause: "timeout" | "connection_lost" };

export interface TokenInfo {
  accessor: string;
  policies: string[];
  orphan: boolean;
  renewable: boolean;
  type: string;
  ttlSeconds: number;
  explicitMaxTtlSeconds: number;
  namespacePath: string;
}

export interface IssuedToken {
  token: string;
  accessor: string;
  ttlSeconds: number;
}

type Failure = Exclude<BaoResult<never>, { ok: true }>;

// ---------------------------------------------------------------------------
// Transport (shared with admin.ts; not exported from the package root)

export interface BaoCall {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path below `/v1/`, possibly with a query string. Built by the caller from validated parts. */
  path: string;
  /** "" is the root namespace. */
  namespace: string;
  token?: string;
  body?: unknown;
  correlation?: Correlation;
  deadlineMs: number;
}

export type BaoOutcome =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "invalid" }
  | { kind: "unknown"; cause: "timeout" | "connection_lost" };

export interface ResolvedTarget {
  url: URL;
  ca: Buffer;
}

export function resolveTarget(target: OpenBaoTarget): ResolvedTarget {
  const url = new URL(target.url);
  if (url.protocol !== "https:") throw new Error("OpenBao target must use https");
  return { url, ca: readFileSync(target.caCertPath) };
}

const CORRELATION_SHAPE = /^[A-Za-z0-9-]{1,128}$/;

function correlationHeaders(c: Correlation): Record<string, string> {
  if (!CORRELATION_SHAPE.test(c.operationId) || !CORRELATION_SHAPE.test(c.dispatchId)) {
    throw new Error("invalid correlation");
  }
  return { "x-mykey-operation-id": c.operationId, "x-mykey-dispatch-id": c.dispatchId };
}

export function baoCall(target: ResolvedTarget, call: BaoCall): Promise<BaoOutcome> {
  const payload = call.body === undefined ? undefined : JSON.stringify(call.body);
  const headers: Record<string, string> = {};
  if (call.token !== undefined) headers["X-Vault-Token"] = call.token;
  if (call.namespace !== "") headers["X-Vault-Namespace"] = call.namespace;
  if (call.correlation !== undefined) Object.assign(headers, correlationHeaders(call.correlation));
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }

  return new Promise((resolveCall) => {
    let settled = false;
    // Request bytes can only leave once the TLS handshake has completed.
    let mayHaveLeft = false;
    const finish = (outcome: BaoOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCall(outcome);
    };

    const request = https.request(
      {
        host: target.url.hostname,
        port: target.url.port,
        path: `/v1/${call.path}`,
        method: call.method,
        headers,
        ca: target.ca,
        // A fresh connection per call: the handshake tells whether bytes may have left.
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", () => {
          finish({ kind: "unknown", cause: "connection_lost" });
        });
        response.on("close", () => {
          if (!response.complete) finish({ kind: "unknown", cause: "connection_lost" });
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          if (text.trim() !== "") {
            try {
              body = JSON.parse(text);
            } catch {
              body = null;
            }
          }
          finish({ kind: "response", status: response.statusCode ?? 0, body });
        });
      },
    );
    const timer = setTimeout(() => {
      finish({ kind: "unknown", cause: "timeout" });
      request.destroy();
    }, call.deadlineMs);
    request.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        mayHaveLeft = true;
      });
    });
    request.on("error", () => {
      finish(mayHaveLeft ? { kind: "unknown", cause: "connection_lost" } : { kind: "invalid" });
    });
    request.end(payload);
  });
}

// ---------------------------------------------------------------------------
// Response reading

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorTexts(body: unknown): string[] {
  const errors = record(body).errors;
  return Array.isArray(errors) ? errors.filter((e): e is string => typeof e === "string") : [];
}

function failureOf(status: number, body: unknown): Failure {
  if (status === 403) return { ok: false, kind: "denied", status };
  if (status === 404) return { ok: false, kind: "not_found", status };
  if (status === 503) return { ok: false, kind: "sealed", status };
  if (status === 400 && errorTexts(body).some((e) => e.includes("check-and-set parameter"))) {
    return { ok: false, kind: "cas_mismatch", status };
  }
  return { ok: false, kind: "invalid", status };
}

/** Maps an outcome to a result; `read` turns a successful body into data, or null when malformed. */
function resultOf<T>(
  outcome: BaoOutcome,
  read: (body: unknown, status: number) => T | null,
): BaoResult<T> {
  if (outcome.kind === "invalid") return { ok: false, kind: "invalid", status: 0 };
  if (outcome.kind === "unknown") return { ok: false, kind: "unknown", cause: outcome.cause };
  const { status, body } = outcome;
  if (status !== 200 && status !== 204) return failureOf(status, body);
  const data = read(body, status);
  return data === null ? { ok: false, kind: "invalid", status } : { ok: true, status, data };
}

const noContent = (): "none" => "none";

function toNull(result: BaoResult<"none">): BaoResult<null> {
  return result.ok ? { ok: true, status: result.status, data: null } : result;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readEnvelope(value: unknown): SecretEnvelope | null {
  const data = record(value);
  const keys = Object.keys(data).sort().join(",");
  if (keys !== "format,operation_id,value") return null;
  if (typeof data.value !== "string" || typeof data.operation_id !== "string") return null;
  if (data.format !== 1) return null;
  return { value: data.value, operation_id: data.operation_id, format: 1 };
}

function readIssuedToken(body: unknown): IssuedToken | null {
  const auth = record(record(body).auth);
  const token = auth.client_token;
  const accessor = auth.accessor;
  const ttl = auth.lease_duration;
  if (typeof token !== "string" || typeof accessor !== "string" || !isNumber(ttl)) return null;
  return { token, accessor, ttlSeconds: ttl };
}

function readTokenInfo(body: unknown): TokenInfo | null {
  const data = record(record(body).data);
  const policies = data.policies;
  const info = {
    accessor: data.accessor,
    policies: Array.isArray(policies) ? policies : undefined,
    orphan: data.orphan,
    renewable: data.renewable,
    type: data.type,
    ttlSeconds: data.ttl,
    explicitMaxTtlSeconds: data.explicit_max_ttl,
    namespacePath: data.namespace_path,
  };
  if (
    typeof info.accessor !== "string" ||
    info.policies?.every((p) => typeof p === "string") !== true ||
    typeof info.orphan !== "boolean" ||
    typeof info.renewable !== "boolean" ||
    typeof info.type !== "string" ||
    !isNumber(info.ttlSeconds) ||
    !isNumber(info.explicitMaxTtlSeconds) ||
    typeof info.namespacePath !== "string"
  ) {
    return null;
  }
  return info as TokenInfo;
}

// ---------------------------------------------------------------------------
// Client

function requireSecretPath(path: string): void {
  if (!isSecretPath(path)) throw new Error("invalid secret path");
}

function requireVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("invalid version");
}

function requireTtl(ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error("invalid ttl");
}

function requireNamespace(namespace: string): void {
  if (!isOrganizationNamespace(namespace)) throw new Error("invalid namespace");
}

export class OpenBaoClient {
  readonly #target: ResolvedTarget;
  readonly #namespace: string;
  readonly #token: string;
  readonly #deadlineMs: number;

  constructor(
    target: OpenBaoTarget,
    opts: { namespace: string; token: string; deadlineMs?: number },
  ) {
    requireNamespace(opts.namespace);
    const deadlineMs = opts.deadlineMs ?? LIMITS.deadlines.backendCallMs;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error("invalid deadline");
    this.#target = resolveTarget(target);
    this.#namespace = opts.namespace;
    this.#token = opts.token;
    this.#deadlineMs = deadlineMs;
  }

  #call(
    method: BaoCall["method"],
    path: string,
    extra: { body?: unknown; correlation?: Correlation } = {},
  ): Promise<BaoOutcome> {
    return baoCall(this.#target, {
      method,
      path,
      namespace: this.#namespace,
      token: this.#token,
      deadlineMs: this.#deadlineMs,
      ...extra,
    });
  }

  async kvWrite(
    path: string,
    envelope: SecretEnvelope,
    cas: number,
    c: Correlation,
  ): Promise<BaoResult<{ version: number }>> {
    requireSecretPath(path);
    requireVersion(cas);
    const data: SecretEnvelope = {
      value: envelope.value,
      operation_id: envelope.operation_id,
      format: 1,
    };
    const outcome = await this.#call("POST", `kv/data/${path}`, {
      body: { options: { cas }, data },
      correlation: c,
    });
    return resultOf(outcome, (body) => {
      const version = record(record(body).data).version;
      return isNumber(version) ? { version } : null;
    });
  }

  async kvRead(
    path: string,
    version?: number,
  ): Promise<BaoResult<{ envelope: SecretEnvelope; version: number }>> {
    requireSecretPath(path);
    if (version !== undefined) requireVersion(version);
    const query = version === undefined ? "" : `?version=${version}`;
    const outcome = await this.#call("GET", `kv/data/${path}${query}`);
    return resultOf(outcome, (body) => {
      const data = record(record(body).data);
      const envelope = readEnvelope(data.data);
      const read = record(data.metadata).version;
      return envelope !== null && isNumber(read) ? { envelope, version: read } : null;
    });
  }

  async kvMetadata(path: string): Promise<
    BaoResult<{
      currentVersion: number;
      versions: Record<string, { deleted: boolean; destroyed: boolean }>;
    }>
  > {
    requireSecretPath(path);
    const outcome = await this.#call("GET", `kv/metadata/${path}`);
    return resultOf(outcome, (body) => {
      const data = record(record(body).data);
      const currentVersion = data.current_version;
      if (!isNumber(currentVersion)) return null;
      const versions: Record<string, { deleted: boolean; destroyed: boolean }> = {};
      for (const [key, entry] of Object.entries(record(data.versions))) {
        const deletionTime = record(entry).deletion_time;
        const destroyed = record(entry).destroyed;
        if (typeof deletionTime !== "string" || typeof destroyed !== "boolean") return null;
        versions[key] = { deleted: deletionTime !== "", destroyed };
      }
      return { currentVersion, versions };
    });
  }

  /** OpenBao answers 404 for a prefix that holds nothing: that is `not_found`, not an empty list. */
  async kvList(prefix: string): Promise<BaoResult<{ names: string[] }>> {
    if (!isEnvironmentPrefix(prefix)) throw new Error("invalid environment prefix");
    const outcome = await this.#call("GET", `kv/metadata/${prefix}?list=true`);
    return resultOf(outcome, (body) => {
      const keys = record(record(body).data).keys;
      if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) return null;
      return { names: keys };
    });
  }

  async kvSoftDelete(path: string, version: number, c: Correlation): Promise<BaoResult<null>> {
    return this.#versionAction("delete", path, version, c);
  }

  async kvUndelete(path: string, version: number, c: Correlation): Promise<BaoResult<null>> {
    return this.#versionAction("undelete", path, version, c);
  }

  async #versionAction(
    action: "delete" | "undelete",
    path: string,
    version: number,
    c: Correlation,
  ): Promise<BaoResult<null>> {
    requireSecretPath(path);
    requireVersion(version);
    if (version === 0) throw new Error("invalid version");
    const outcome = await this.#call("POST", `kv/${action}/${path}`, {
      body: { versions: [version] },
      correlation: c,
    });
    return toNull(resultOf(outcome, noContent));
  }

  async tokenCreateFromRole(
    role: string,
    ttlSeconds: number,
    c: Correlation,
  ): Promise<BaoResult<IssuedToken>> {
    if (!isMachineName(role)) throw new Error("invalid machine name");
    requireTtl(ttlSeconds);
    const outcome = await this.#call("POST", `auth/token/create/${role}`, {
      body: { ttl: `${ttlSeconds}s`, policies: [role], no_default_policy: true },
      correlation: c,
    });
    return resultOf(outcome, readIssuedToken);
  }

  async tokenLookupSelf(): Promise<BaoResult<TokenInfo>> {
    return resultOf(await this.#call("GET", "auth/token/lookup-self"), readTokenInfo);
  }

  async tokenLookupAccessor(accessor: string): Promise<BaoResult<TokenInfo>> {
    const outcome = await this.#call("POST", "auth/token/lookup-accessor", { body: { accessor } });
    return resultOf(outcome, readTokenInfo);
  }

  async tokenRevokeAccessor(accessor: string, c: Correlation): Promise<BaoResult<null>> {
    const outcome = await this.#call("POST", "auth/token/revoke-accessor", {
      body: { accessor },
      correlation: c,
    });
    return toNull(resultOf(outcome, noContent));
  }

  async tokenRevokeSelf(): Promise<BaoResult<null>> {
    return toNull(resultOf(await this.#call("POST", "auth/token/revoke-self"), noContent));
  }
}

/** AppRole login inside an organization namespace. No token is sent. */
export async function appRoleLogin(
  target: OpenBaoTarget,
  namespace: string,
  roleId: string,
  secretId: string,
): Promise<BaoResult<IssuedToken>> {
  requireNamespace(namespace);
  const outcome = await baoCall(resolveTarget(target), {
    method: "POST",
    path: "auth/approle/login",
    namespace,
    body: { role_id: roleId, secret_id: secretId },
    deadlineMs: LIMITS.deadlines.backendCallMs,
  });
  return resultOf(outcome, readIssuedToken);
}
