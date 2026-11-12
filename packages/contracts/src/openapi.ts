// Builds the OpenAPI 3.1 document from the route list. The output depends only
// on its input, so two builds are byte-identical and the committed file can be
// compared with a fresh build.
import { z } from "zod";
import { ERROR_CODES, errorEnvelopeSchema } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import { ENVIRONMENT_NAME_PATTERN, SECRET_NAME_PATTERN } from "./names.ts";
import { operationResponseSchema } from "./operation.ts";
import { PENDING, type AuthClass, type ResponseBody, type RouteDef } from "./routes.ts";

type Json = Record<string, unknown>;

const ERROR_REF = { $ref: "#/components/schemas/ErrorEnvelope" };
const OPERATION_REF = { $ref: "#/components/schemas/OperationResponse" };
const PENDING_SCHEMA = { type: "object", "x-mykey-pending": true };

const STATUS_TEXT: Readonly<Record<string, string>> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  400: "Bad request",
  401: "Unauthenticated",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  422: "Unprocessable content",
  429: "Too many requests",
  503: "Service unavailable",
  507: "Insufficient storage",
};

const PATH_PARAMETER_PATTERNS: Readonly<Record<string, RegExp>> = {
  name: SECRET_NAME_PATTERN,
  envName: ENVIRONMENT_NAME_PATTERN,
};

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Json {
  const converted = z.toJSONSchema(schema, { target: "draft-2020-12", io });
  return Object.fromEntries(Object.entries(converted).filter(([key]) => key !== "$schema"));
}

function json(schema: Json): Json {
  return { "application/json": { schema } };
}

function statusText(status: string): string {
  return STATUS_TEXT[status] ?? `HTTP ${status}`;
}

function security(auth: AuthClass): Json[] {
  if (auth === "human" || auth === "human_fresh_totp") return [{ sessionCookie: [] }];
  if (auth === "machine") return [{ machineBearer: [] }];
  return [];
}

function parameters(route: RouteDef): Json[] {
  const list: Json[] = [];
  for (const match of route.path.matchAll(/:([A-Za-z]+)/g)) {
    const name = match[1] ?? "";
    const pattern = PATH_PARAMETER_PATTERNS[name];
    const schema =
      pattern === undefined ? { type: "string" } : { type: "string", pattern: pattern.source };
    list.push({ name, in: "path", required: true, schema });
  }
  if (route.request.query !== undefined) {
    const query = jsonSchema(route.request.query, "input");
    const properties = (query.properties ?? {}) as Record<string, Json>;
    const required = (query.required ?? []) as string[];
    for (const [name, schema] of Object.entries(properties)) {
      list.push({ name, in: "query", required: required.includes(name), schema });
    }
  }
  if (route.idempotent) {
    list.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1 },
    });
  }
  return list;
}

function requestBody(route: RouteDef): Json | undefined {
  const body = route.request.body;
  if (body === undefined) return undefined;
  if (body === "raw-dotenv") {
    return {
      required: true,
      content: {
        "text/plain": { schema: { type: "string", maxLength: LIMITS.body.dotenvMaxBytes } },
      },
    };
  }
  if (body === PENDING) return { required: true, content: json(PENDING_SCHEMA) };
  return { required: true, content: json(jsonSchema(body, "input")) };
}

function successResponse(status: string, body: ResponseBody): Json {
  const description = statusText(status);
  if (body === "dotenv-attachment") {
    return {
      description,
      headers: { "Content-Disposition": { schema: { type: "string" } } },
      content: { "text/plain": { schema: { type: "string" } } },
    };
  }
  if (body === PENDING) return { description, content: json(PENDING_SCHEMA) };
  if (body === operationResponseSchema) return { description, content: json(OPERATION_REF) };
  return { description, content: json(jsonSchema(body, "output")) };
}

function responses(route: RouteDef): Json {
  const result: Json = {};
  for (const [status, body] of Object.entries(route.responses)) {
    result[status] = successResponse(status, body);
  }
  const byStatus = new Map<number, string[]>();
  for (const code of route.errors) {
    const { status } = ERROR_CODES[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
    const key = String(status);
    if (key in result) {
      throw new Error(`${route.id}: status ${key} is both a response and an error`);
    }
    const codes = byStatus.get(status) ?? [];
    result[key] = {
      description: `${statusText(key)}. Codes: ${codes.join(", ")}.`,
      content: json(ERROR_REF),
    };
  }
  return result;
}

function operation(route: RouteDef): Json {
  const result: Json = {
    operationId: route.id,
    "x-mykey-auth": route.auth,
    security: security(route.auth),
  };
  const list = parameters(route);
  if (list.length > 0) result.parameters = list;
  const body = requestBody(route);
  if (body !== undefined) result.requestBody = body;
  result.responses = responses(route);
  return result;
}

export function buildOpenApiDocument(routes: readonly RouteDef[]): Json {
  const paths: Record<string, Json> = {};
  for (const route of routes) {
    const path = route.path.replace(/:([A-Za-z]+)/g, "{$1}");
    const methods = (paths[path] ??= {});
    methods[route.method.toLowerCase()] = operation(route);
  }
  return {
    openapi: "3.1.0",
    info: { title: "MyKey API", version: "1.0.0" },
    paths,
    components: {
      schemas: {
        ErrorEnvelope: jsonSchema(errorEnvelopeSchema, "output"),
        OperationResponse: jsonSchema(operationResponseSchema, "output"),
      },
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__Secure-better-auth.session_token",
          description:
            "Human session cookie: Secure, HttpOnly, SameSite=Strict, Path=/, host-only (no Domain attribute). D-27.",
        },
        machineBearer: {
          type: "http",
          scheme: "bearer",
          description: "Machine credential token. Never accepted together with a session cookie.",
        },
      },
    },
  };
}

/** The exact bytes of the committed `openapi/openapi.json`. */
export function serialiseOpenApiDocument(document: Json): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
