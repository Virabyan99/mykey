// The one way the workspace talks to the API (P-136). A call names a route of
// the contract; the path, the method and the response schema come from the
// route table, so the page cannot call what the contract does not have. Every
// answer is checked: a success against the route's schema, a refusal against
// the error envelope. Anything else is a transport failure, and the page then
// claims nothing about what happened.
import "./zod-setup.ts";
import {
  ROUTES,
  errorEnvelopeSchema,
  type ActivityListBody,
  type AuditListBody,
  type EnvironmentsBody,
  type CredentialsListBody,
  type OperationResponse,
  type OperationsListBody,
  type OrganizationsBody,
  type OverviewBody,
  type ProjectsBody,
  type RouteDef,
  type SecretsListBody,
  type SecretsRevealBody,
  type SessionActivityBody,
} from "@mykey/contracts";
import type { z } from "zod";
import type { Failure } from "../errors/explain.ts";
import { SECRET_BEARING, type SecretBearing } from "./secret-routes.ts";

/** The routes the workspace calls, with the body of their success. A run adds its routes here. */
export interface Bodies {
  "organizations.list": OrganizationsBody;
  "projects.list": ProjectsBody;
  "environments.list": EnvironmentsBody;
  "session.activity": SessionActivityBody;
  "audit.list": AuditListBody;
  "activity.list": ActivityListBody;
  "overview.get": OverviewBody;
  "projects.create": OperationResponse;
  "projects.rename": OperationResponse;
  "projects.archive": OperationResponse;
  "projects.reactivate": OperationResponse;
  "environments.create": OperationResponse;
  "environments.rename": OperationResponse;
  "environments.archive": OperationResponse;
  "environments.reactivate": OperationResponse;
  "credentials.list": CredentialsListBody;
  "operations.list": OperationsListBody;
  "secrets.list": SecretsListBody;
}
/** A route of SECRET_BEARING is not one of these, whatever `Bodies` says. */
export type RouteId = Exclude<keyof Bodies, SecretBearing>;

/** The routes that carry a secret in the request or in the answer: only `callSecret` sends them. */
export interface SecretBodies {
  "auth.reset.complete": { next: "sign_in" | "enroll" };
  "secrets.reveal": SecretsRevealBody;
  "secrets.create": OperationResponse;
  "secrets.update": OperationResponse;
}
export type SecretRouteId = Extract<keyof SecretBodies, SecretBearing>;

const CARRIES_SECRET: ReadonlySet<string> = new Set(SECRET_BEARING);

export interface CallInput {
  /** The `:name` parts of the route's path. */
  params?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | number | undefined>>;
  body?: unknown;
  /** One key per decision of the owner: the same click sent twice is the same request. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export type CallResult<T> =
  { ok: true; status: number; body: T; requestId: string | null } | { ok: false; failure: Failure };

/** What a failed call throws inside a query, so the screen can explain it. */
export class CallError extends Error {
  readonly failure: Failure;
  constructor(failure: Failure) {
    super(failure.kind === "api" ? failure.code : "transport");
    this.name = "CallError";
    this.failure = failure;
  }
}

export const failureOf = (error: unknown): Failure =>
  error instanceof CallError ? error.failure : { kind: "transport", status: null };

const BY_ID: ReadonlyMap<string, RouteDef> = new Map(ROUTES.map((route) => [route.id, route]));

export interface Answer {
  status: number;
  /** The parsed JSON body, or undefined when there is none or it is not JSON. */
  json: unknown;
  requestId: string | null;
  retryAfterSeconds: number | null;
}

/** One request to this origin. Null: no answer (the connection, or an aborted request). */
export async function send(request: {
  method: string;
  path: string;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}): Promise<Answer | null> {
  const headers: Record<string, string> = { accept: "application/json", ...request.headers };
  const init: RequestInit = {
    method: request.method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
  };
  if (request.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(request.body);
  }
  if (request.signal !== undefined) init.signal = request.signal;
  try {
    const response = await fetch(request.path, init);
    const text = await response.text();
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    const retryAfter = Number(response.headers.get("retry-after") ?? "");
    return {
      status: response.status,
      json,
      requestId: response.headers.get("x-request-id"),
      retryAfterSeconds: Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : null,
    };
  } catch {
    return null;
  }
}

/** The failure an answer is, when it is not the success that was expected. */
export function failureFrom(answer: Answer | null): Failure {
  if (answer === null) return { kind: "transport", status: null };
  const envelope = errorEnvelopeSchema.safeParse(answer.json);
  if (!envelope.success) return { kind: "transport", status: answer.status };
  const { code, message, requestId, operationId, details } = envelope.data.error;
  return {
    kind: "api",
    status: answer.status,
    code,
    message,
    requestId,
    operationId: operationId ?? null,
    details: details ?? null,
    retryAfterSeconds: answer.retryAfterSeconds,
  };
}

function pathOf(route: RouteDef, input: CallInput): string {
  const path = route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = input.params?.[name];
    if (value === undefined || value === "") throw new Error(`${route.id}: no ${name}`);
    return encodeURIComponent(value);
  });
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) query.set(name, String(value));
  }
  const text = query.toString();
  return text === "" ? path : `${path}?${text}`;
}

async function request<T>(id: string, input: CallInput): Promise<CallResult<T>> {
  const route = BY_ID.get(id);
  if (route === undefined) throw new Error(`not a route of the contract: ${id}`);
  const headers: Record<string, string> = {};
  if (route.idempotent) {
    if (input.idempotencyKey === undefined) throw new Error(`${id}: no idempotency key`);
    headers["idempotency-key"] = input.idempotencyKey;
  }
  const answer = await send({
    method: route.method,
    path: pathOf(route, input),
    // A route that declares no body refuses one (malformed_request), so none is sent.
    ...(route.request.body === undefined ? {} : { body: input.body ?? {} }),
    headers,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (answer === null) return { ok: false, failure: failureFrom(null) };
  const schema = route.responses[answer.status];
  if (schema === undefined || typeof schema === "string") {
    return { ok: false, failure: failureFrom(answer) };
  }
  const parsed = (schema as z.ZodType<T>).safeParse(answer.json);
  if (!parsed.success) return { ok: false, failure: { kind: "transport", status: answer.status } };
  return { ok: true, status: answer.status, body: parsed.data, requestId: answer.requestId };
}

/** A route that carries no secret. Its answer may be kept by the query cache. */
export function call<Id extends RouteId>(
  id: Id,
  input: CallInput = {},
): Promise<CallResult<Bodies[Id]>> {
  if (CARRIES_SECRET.has(id)) throw new Error(`${id} carries a secret: it is sent by callSecret`);
  return request<Bodies[Id]>(id, input);
}

/**
 * A route of SECRET_BEARING (P-138): the same request as `call`, and a rule
 * about where it may be written. It is called from an event handler, never
 * from a query, and its answer goes to the forgetting holder (use-ephemeral.ts)
 * or is dropped.
 */
export function callSecret<Id extends SecretRouteId>(
  id: Id,
  input: CallInput = {},
): Promise<CallResult<SecretBodies[Id]>> {
  if (!CARRIES_SECRET.has(id)) throw new Error(`${id} carries no secret: it is sent by call`);
  return request<SecretBodies[Id]>(id, input);
}

/** For a query function: the body, or a CallError the screen explains. */
export async function need<T>(result: Promise<CallResult<T>>): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new CallError(settled.failure);
  return settled.body;
}
