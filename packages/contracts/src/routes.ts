// The frozen Stage 1 route list (Doc 06 §9, D-15). Later runs implement these
// routes; none adds, renames or removes one without a `contract:` commit.
import { z } from "zod";
import type { Action, RouteScope } from "./authz.ts";
import type { ErrorCode } from "./errors.ts";
import { environmentIdSchema } from "./ids.ts";
import { LIMITS } from "./limits.ts";
import {
  ENVIRONMENT_NAME_PATTERN,
  PASSWORD_MAX_CHARACTERS,
  PASSWORD_MIN_CHARACTERS,
  SECRET_NAME_PATTERN,
  checkPassword,
  checkProjectName,
  checkSecretName,
  checkSecretValue,
} from "./names.ts";
import { operationResponseSchema } from "./operation.ts";

export type HttpMethod = "GET" | "POST" | "PATCH";

/**
 * Who may call a route. `human_fresh_totp` is a human session with a TOTP
 * verification inside the last ten minutes; `reset_flow` is the password-reset
 * flow, which carries its own proof in the body.
 */
export type AuthClass = "public" | "human" | "human_fresh_totp" | "machine" | "reset_flow";

/** A body the owning run has not specified yet. */
export const PENDING = "pending";

export type RequestBody = z.ZodType | "raw-dotenv" | typeof PENDING;
export type ResponseBody = z.ZodType | "dotenv-attachment" | typeof PENDING;

export interface RouteDef {
  readonly id: string;
  readonly method: HttpMethod;
  /** Path with `:name` parameters. */
  readonly path: string;
  readonly auth: AuthClass;
  /** True when the route requires an `Idempotency-Key` header. */
  readonly idempotent: boolean;
  /** The Stage 1 run that implements the route. */
  readonly ownerRun: string;
  /** True while any body of the route is still `PENDING`. */
  readonly pending: boolean;
  readonly request: { readonly body?: RequestBody; readonly query?: z.ZodObject };
  /** Non-error responses by HTTP status. */
  readonly responses: Readonly<Record<number, ResponseBody>>;
  /** Every error code the route may return. */
  readonly errors: readonly ErrorCode[];
  /** What Doc 04 §1.1 asks of a human caller beyond seeing the target (P-52); null for other classes. */
  readonly action: Action | null;
  /** The deepest resource the path names, for human routes; `none` for other classes. */
  readonly scope: RouteScope;
}

export const DENIED_ALIASES: readonly { readonly method: HttpMethod; readonly path: string }[] =
  Object.freeze([Object.freeze({ method: "GET", path: "/v1/operations/:id/status" } as const)]);

// ---------------------------------------------------------------- body schemas

const projectName = z
  .string()
  .refine((value) => checkProjectName(value).ok)
  // Handlers receive the NFC form, which is what the database constraint requires.
  .transform((value) => value.normalize("NFC"))
  .describe(
    `${String(LIMITS.project.nameMinCodePoints)} to ${String(LIMITS.project.nameMaxCodePoints)} Unicode code points after NFC normalisation; no control characters; not whitespace only.`,
  );
const environmentName = z.string().regex(ENVIRONMENT_NAME_PATTERN);
const secretName = z
  .string()
  .regex(SECRET_NAME_PATTERN)
  .refine((value) => checkSecretName(value).ok)
  .describe(`Must not start with the reserved prefix ${LIMITS.secret.reservedPrefix}.`);
const secretValue = z
  .string()
  .refine((value) => checkSecretValue(value).ok)
  .describe(
    `At most ${String(LIMITS.secret.valueMaxBytes)} bytes of well-formed UTF-8 without NUL. May be empty.`,
  );
const version = z.int().positive();
const stateTag = z.string().min(1);
const confirmed = z.literal(true);

const nameBody = (name: z.ZodType) => z.strictObject({ name });
const confirmedBody = z.strictObject({ confirmed });
const expected = { expectedVersion: version, expectedStateTag: stateTag };
const deleteBody = z.strictObject({ ...expected, confirmed });

const healthBody = z.strictObject({ status: z.enum(["up", "down"]) });

/** session.activity (Run 3.5): when the session ends if nothing else happens, and at the latest. */
const activityBody = z.strictObject({
  idleExpiresAt: z.iso.datetime(),
  absoluteExpiresAt: z.iso.datetime(),
});

/** auth.reset.complete (Run 3.6, P-51): the token of the link, the new password, and for a password reset a factor code. */
const password = z
  .string()
  .refine((value) => checkPassword(value).ok)
  .describe(
    `${String(PASSWORD_MIN_CHARACTERS)} to ${String(PASSWORD_MAX_CHARACTERS)} Unicode code points and at most ${String(LIMITS.body.passwordMaxBytes)} bytes of UTF-8.`,
  );
const resetCompleteBody = z.strictObject({
  token: z.string().length(43),
  newPassword: password,
  code: z.string().min(1).max(64).optional(),
});

/** organizations.list (Run 3.7): the caller's active memberships; no namespace, no digest. */
const organizationsBody = z.strictObject({
  organizations: z.array(
    z.strictObject({
      id: z.uuid(),
      role: z.enum(["owner", "admin", "member"]),
      state: z.enum(["provisioning", "active", "failed", "needs_review"]),
      /** Why the organization is `needs_review`; null in every other state. */
      reviewReason: z.string().nullable(),
    }),
  ),
});

const versionBody = z.strictObject({
  apiMajor: z.literal(1),
  /** The commit the image was built from. */
  build: z.string().regex(/^[0-9a-f]{7,40}$/),
});

const resolveBody = z.strictObject({
  apiMajor: z.int().positive(),
  environmentId: environmentIdSchema,
  generation: z.int().nonnegative(),
  count: z.int().nonnegative(),
  entries: z.array(z.strictObject({ name: z.string(), value: z.string() })),
  complete: z.literal(true),
});

const secretsListQuery = z.strictObject({
  prefix: z.string().max(LIMITS.listing.filterMaxLength).optional(),
  limit: z.int().min(1).max(LIMITS.listing.maxLimit).default(LIMITS.listing.defaultLimit),
  cursor: z.string().min(1).optional(),
});

// ----------------------------------------------------------------- error lists

// The quarantine gate is the first step of every request (Doc 06 §9: even /v1/version).
const EVERY: readonly ErrorCode[] = ["malformed_request", "rate_limited", "busy", "quarantined"];
const SESSION: readonly ErrorCode[] = [
  "mixed_authentication",
  "unauthenticated",
  "mfa_incomplete",
  "action_denied",
  "dependency_unavailable",
];
const MACHINE: readonly ErrorCode[] = [
  "mixed_authentication",
  "unauthenticated",
  "action_denied",
  "forbidden_selector",
  "dependency_unavailable",
];
const IDEMPOTENT: readonly ErrorCode[] = [
  "precondition_required",
  "idempotency_conflict",
  "replay_expired",
  "outcome_unknown",
  "audit_unavailable",
];
const BACKEND: readonly ErrorCode[] = ["backend_sealed", "backend_inconsistent"];
const VALUE_READ: readonly ErrorCode[] = ["key_under_review", "audit_unavailable", ...BACKEND];
const KEY_WRITE: readonly ErrorCode[] = ["state_conflict", "key_under_review", ...BACKEND];
const VERSIONED: readonly ErrorCode[] = ["version_conflict", ...KEY_WRITE];
const IMPORT_WRITE: readonly ErrorCode[] = [
  "environment_changed",
  "capacity_exceeded",
  ...KEY_WRITE,
];

// ------------------------------------------------------------------ definition

interface RouteInput {
  body?: RequestBody;
  query?: z.ZodObject;
  /** Non-error responses; the default is `{ 200: PENDING }`. */
  responses?: Record<number, ResponseBody>;
  /** HTTP status of a completed mutation (idempotent routes only); the default is 200. */
  completed?: 200 | 201;
  errors?: readonly ErrorCode[];
  /** Required for a human route (`null` when seeing the target is enough). */
  action?: Action | null;
}

function scopeOf(auth: AuthClass, path: string): RouteScope {
  if (auth !== "human" && auth !== "human_fresh_totp") return "none";
  if (path.includes("/:env")) return "environment";
  if (path.includes("/:project")) return "project";
  if (path.includes("/:org")) return "organization";
  if (path.includes("/:operation")) return "operation";
  return "none";
}

function define(
  id: string,
  method: HttpMethod,
  path: string,
  auth: AuthClass,
  idempotent: boolean,
  ownerRun: string,
  input: RouteInput = {},
): RouteDef {
  const responses: Record<number, ResponseBody> = idempotent
    ? {
        [input.completed ?? 200]: operationResponseSchema,
        202: operationResponseSchema,
        ...input.responses,
      }
    : (input.responses ?? { 200: PENDING });

  const errors = new Set<ErrorCode>();
  const add = (codes: readonly ErrorCode[]) => {
    for (const code of codes) errors.add(code);
  };
  if (id !== "health.get") add(EVERY);
  if (auth === "human" || auth === "human_fresh_totp") add(SESSION);
  if (auth === "machine") add(MACHINE);
  if (auth === "human_fresh_totp") add(["fresh_verification_required"]);
  if (auth === "reset_flow") add(["unauthenticated", "dependency_unavailable"]);
  if (auth !== "public" && auth !== "machine" && method !== "GET") add(["origin_rejected"]);
  if (path.includes("/:")) add(["not_found"]);
  if (input.body !== undefined || input.query !== undefined) add(["validation_failed"]);
  if (id.endsWith(".list")) add(["listing_changed"]);
  if (idempotent) add(IDEMPOTENT);
  // Organization, project and environment states (P-53) answer on every scoped route.
  if (path.startsWith("/v1/organizations/:org")) add(["state_conflict", "backend_inconsistent"]);
  add(input.errors ?? []);

  const human = auth === "human" || auth === "human_fresh_totp";
  if (human && input.action === undefined) throw new Error(`route ${id} has no action`);
  if (!human && input.action != null) throw new Error(`route ${id} is not a human route`);

  const request: { body?: RequestBody; query?: z.ZodObject } = {};
  if (input.body !== undefined) request.body = input.body;
  if (input.query !== undefined) request.query = input.query;

  const pending = input.body === PENDING || Object.values(responses).includes(PENDING);

  return Object.freeze({
    id,
    method,
    path,
    auth,
    idempotent,
    ownerRun,
    pending,
    request: Object.freeze(request),
    responses: Object.freeze(responses),
    errors: Object.freeze([...errors]),
    action: input.action ?? null,
    scope: scopeOf(auth, path),
  });
}

const O = "/v1/organizations/:org";
const P = `${O}/projects/:project`;
const E = `${P}/environments/:env`;
const M = "/v1/machine/projects/:project/environments/:envName";

const health = { 200: healthBody, 503: healthBody };
const operation = { 200: operationResponseSchema };

export const ROUTES: readonly RouteDef[] = Object.freeze([
  define("health.get", "GET", "/health", "public", false, "2.5", { responses: health }),
  define("version.get", "GET", "/v1/version", "public", false, "3.1", {
    responses: { 200: versionBody },
  }),
  define("organizations.list", "GET", "/v1/organizations", "human", false, "3.7", {
    action: null,
    responses: { 200: organizationsBody },
  }),

  define("projects.list", "GET", `${O}/projects`, "human", false, "3.9", { action: null }),
  define("projects.create", "POST", `${O}/projects`, "human", true, "3.9", {
    action: "resources.manage",
    body: nameBody(projectName),
    completed: 201,
    errors: ["already_exists"],
  }),
  define("projects.rename", "PATCH", P, "human", true, "3.9", {
    action: "resources.manage",
    body: nameBody(projectName),
    errors: ["already_exists", "state_conflict"],
  }),
  define("projects.archive", "POST", `${P}/archive`, "human", true, "5.3", {
    action: "resources.manage",
    body: confirmedBody,
    errors: ["state_conflict", ...BACKEND],
  }),
  define("projects.reactivate", "POST", `${P}/reactivate`, "human", true, "5.3", {
    action: "resources.manage",
    body: confirmedBody,
    errors: ["state_conflict", ...BACKEND],
  }),

  define("environments.list", "GET", `${P}/environments`, "human", false, "3.9", { action: null }),
  define("environments.create", "POST", `${P}/environments`, "human", true, "3.9", {
    action: "resources.manage",
    body: nameBody(environmentName),
    completed: 201,
    errors: ["already_exists", "state_conflict", ...BACKEND],
  }),
  define("environments.rename", "PATCH", E, "human", true, "3.9", {
    action: "resources.manage",
    body: nameBody(environmentName),
    errors: ["already_exists", "state_conflict"],
  }),
  define("environments.archive", "POST", `${E}/archive`, "human", true, "5.3", {
    action: "resources.manage",
    body: confirmedBody,
    errors: ["state_conflict", ...BACKEND],
  }),
  define("environments.reactivate", "POST", `${E}/reactivate`, "human", true, "5.3", {
    action: "resources.manage",
    body: confirmedBody,
    errors: ["state_conflict", ...BACKEND],
  }),

  define("secrets.list", "GET", `${E}/secrets`, "human", false, "4.3", {
    action: "secrets.read",
    query: secretsListQuery,
  }),
  define("secrets.history", "GET", `${E}/secrets/:name/history`, "human", false, "4.3", {
    action: "secrets.history",
    errors: ["unsupported_history_parameter", "key_under_review", ...BACKEND],
  }),
  define("secrets.reveal", "POST", `${E}/secrets/:name/reveal`, "human", false, "4.3", {
    action: "secrets.read",
    body: z.strictObject({ version: version.optional() }),
    errors: ["state_conflict", ...VALUE_READ],
  }),
  define("secrets.create", "POST", `${E}/secrets`, "human", true, "4.2", {
    action: "secrets.write",
    body: z.strictObject({ name: secretName, value: secretValue }),
    completed: 201,
    errors: ["already_exists", "capacity_exceeded", ...KEY_WRITE],
  }),
  define("secrets.update", "PATCH", `${E}/secrets/:name`, "human", true, "4.2", {
    action: "secrets.write",
    body: z.strictObject({ value: secretValue, ...expected }),
    errors: ["capacity_exceeded", ...VERSIONED],
  }),
  define("secrets.delete", "POST", `${E}/secrets/:name/delete`, "human", true, "4.4", {
    action: "secrets.write",
    body: deleteBody,
    errors: VERSIONED,
  }),
  define("secrets.undelete", "POST", `${E}/secrets/:name/undelete`, "human", true, "4.4", {
    action: "secrets.write",
    body: deleteBody,
    errors: ["capacity_exceeded", ...VERSIONED],
  }),
  define("secrets.restore", "POST", `${E}/secrets/:name/restore`, "human", true, "4.4", {
    action: "secrets.write",
    body: z.strictObject({ sourceVersion: version, ...expected, confirmed }),
    errors: ["capacity_exceeded", ...VERSIONED],
  }),

  define("import.preview", "POST", `${E}/import/preview`, "human", false, "4.7", {
    action: "secrets.write",
    body: "raw-dotenv",
    errors: ["state_conflict", "capacity_exceeded"],
  }),
  define("import.apply", "POST", `${E}/import/:preview/apply`, "human", true, "4.7", {
    action: "secrets.write",
    body: "raw-dotenv",
    errors: IMPORT_WRITE,
  }),
  define(
    "import.resume",
    "POST",
    `${E}/import-operations/:operation/resume`,
    "human",
    false,
    "4.7",
    {
      action: "secrets.write",
      body: "raw-dotenv",
      responses: { 200: operationResponseSchema, 202: operationResponseSchema },
      errors: ["outcome_unknown", "audit_unavailable", ...IMPORT_WRITE],
    },
  ),
  define("export.create", "POST", `${E}/export`, "human_fresh_totp", false, "4.9", {
    action: "secrets.read",
    body: confirmedBody,
    responses: { 200: "dotenv-attachment" },
    errors: ["environment_changed", "state_conflict", ...VALUE_READ],
  }),

  define("credentials.list", "GET", `${E}/credentials`, "human", false, "5.1", {
    action: "credentials.manage",
  }),
  define("credentials.issue", "POST", `${E}/credentials`, "human_fresh_totp", true, "5.1", {
    action: "credentials.manage",
    body: z.strictObject({
      name: projectName,
      ttlSeconds: z
        .int()
        .positive()
        .max(LIMITS.machineToken.maxTtlSeconds)
        .default(LIMITS.machineToken.maxTtlSeconds),
    }),
    completed: 201,
    responses: { 201: PENDING },
    errors: ["credential_not_replayable", "state_conflict", ...BACKEND],
  }),
  define(
    "credentials.revoke",
    "POST",
    `${E}/credentials/:credential/revoke`,
    "human",
    true,
    "5.2",
    { action: "credentials.manage", body: confirmedBody, errors: ["state_conflict", ...BACKEND] },
  ),

  define("operations.get", "GET", "/v1/operations/:operation", "human", false, "4.1", {
    action: "secrets.read",
    responses: operation,
  }),
  define("operations.list", "GET", `${E}/operations`, "human", false, "4.1", {
    action: "secrets.read",
  }),

  define("audit.list", "GET", `${O}/audit`, "human", false, "6.1", { action: "audit.view" }),
  define("activity.list", "GET", `${O}/activity`, "human", false, "6.1", { action: "audit.view" }),
  define("overview.get", "GET", `${O}/overview`, "human", false, "7.3", { action: "audit.view" }),
  define("credentials.summary", "GET", `${O}/credentials/summary`, "human", false, "7.7", {
    action: "credentials.manage",
  }),
  define("metrics.get", "GET", `${O}/metrics`, "human", false, "7.8", { action: "audit.view" }),

  define("session.activity", "POST", "/v1/session/activity", "human", false, "3.5", {
    action: null,
    responses: { 200: activityBody },
  }),
  define("auth.reset.complete", "POST", "/v1/auth/reset/complete", "reset_flow", false, "3.6", {
    body: resetCompleteBody,
    responses: { 200: z.strictObject({ next: z.enum(["sign_in", "enroll"]) }) },
    errors: ["audit_unavailable"],
  }),
  define("reference.get", "GET", "/v1/reference", "human", false, "5.9", { action: null }),
  define("openapi.get", "GET", "/v1/openapi.json", "human", false, "5.9", { action: null }),

  define("machine.keys", "GET", `${M}/keys`, "machine", false, "5.4", {
    errors: ["environment_changed", ...BACKEND],
  }),
  define("machine.resolve", "POST", `${M}/resolve`, "machine", false, "5.4", {
    responses: { 200: resolveBody },
    errors: ["environment_changed", ...VALUE_READ],
  }),
]);
