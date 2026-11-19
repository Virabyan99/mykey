// The frozen Stage 1 route list (Doc 06 §9, D-15). Later runs implement these
// routes; none adds, renames or removes one without a `contract:` commit.
import { z } from "zod";
import type { Action, RouteScope } from "./authz.ts";
import { DOTENV_RULES } from "./dotenv/parse.ts";
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
import { OPERATION_STATES, operationResponseSchema } from "./operation.ts";

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
/**
 * A JSON schema, or a raw body: `dotenv-attachment` (Run 4.9) and
 * `html-document` (Run 5.9, the API reference: one self-contained page).
 */
export type ResponseBody = z.ZodType | "dotenv-attachment" | "html-document" | typeof PENDING;

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

/** The OpenAPI document of this build (Run 5.9): an object; its shape is OpenAPI's. */
const openApiDocumentBody = z.looseObject({ openapi: z.string() });

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
/** The states of an organization. */
export const ORGANIZATION_STATES = ["provisioning", "active", "failed", "needs_review"] as const;
const organizationsBody = z.strictObject({
  organizations: z.array(
    z.strictObject({
      id: z.uuid(),
      role: z.enum(["owner", "admin", "member"]),
      state: z.enum(ORGANIZATION_STATES),
      /** Why the organization is `needs_review`; null in every other state. */
      reviewReason: z.string().nullable(),
    }),
  ),
});

/** The API's major version (Doc 06 §9): a client refuses any other. */
export const API_MAJOR = 1;

const versionBody = z.strictObject({
  apiMajor: z.literal(API_MAJOR),
  /** The commit the image was built from. */
  build: z.string().regex(/^[0-9a-f]{7,40}$/),
});

/** An environment's metadata generation (a bigint): a decimal string, as in the cursors. */
const generationText = z
  .string()
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/);

/** machine.resolve (Run 5.4, P-94): every live value of one generation, or nothing. */
const resolveBody = z.strictObject({
  apiMajor: z.int().positive(),
  environmentId: environmentIdSchema,
  generation: generationText,
  count: z.int().nonnegative(),
  entries: z.array(z.strictObject({ name: z.string(), value: z.string() })),
  complete: z.literal(true),
});

/** machine.keys (Run 5.4, P-94): the live names of one generation, bytewise order; never a value. */
const keysBody = z.strictObject({
  apiMajor: z.int().positive(),
  environmentId: environmentIdSchema,
  generation: generationText,
  count: z.int().nonnegative(),
  names: z.array(z.string()),
  complete: z.literal(true),
});

const secretsListQuery = z.strictObject({
  // A name prefix (Run 4.3): the name pattern, so `_` and `%` are never wildcards.
  prefix: z.string().regex(SECRET_NAME_PATTERN).optional(),
  limit: z.int().min(1).max(LIMITS.listing.maxLimit).default(LIMITS.listing.defaultLimit),
  cursor: z.string().min(1).optional(),
});

/** Run 4.3 (P-73): the index's view of a name. Never a value. */
/** The states of a secret's index row. */
export const INDEX_STATES = ["live", "deleted", "needs_review"] as const;
const indexState = z.enum(INDEX_STATES);
const secretsListBody = z.strictObject({
  secrets: z.array(
    z.strictObject({
      name: z.string(),
      version: z.int().positive().nullable(),
      stateTag: z.string(),
      state: indexState,
      changedAt: z.iso.datetime(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const historyActor = z.strictObject({
  kind: z.enum(["user", "operator", "system", "unknown"]),
  id: z.string().nullable(),
});
/** secrets.history: newest version first, at most the twenty OpenBao keeps. */
const secretsHistoryBody = z.strictObject({
  name: z.string(),
  currentVersion: z.int().positive().nullable(),
  state: indexState,
  stateTag: z.string(),
  versions: z
    .array(
      z.strictObject({
        version: z.int().positive(),
        createdAt: z.iso.datetime(),
        deleted: z.boolean(),
        destroyed: z.boolean(),
        current: z.boolean(),
        written: z.strictObject({
          action: z.enum(["create", "update", "restore"]).nullable(),
          actor: historyActor,
          operationId: z.uuid().nullable(),
        }),
        lastChange: z
          .strictObject({
            action: z.enum(["delete", "undelete"]),
            actor: historyActor,
            occurredAt: z.iso.datetime(),
            operationId: z.uuid().nullable(),
          })
          .nullable(),
      }),
    )
    .max(LIMITS.secret.versionsKept),
});
/** secrets.reveal: one value, after its audit row is committed (Run 4.3). */
const secretsRevealBody = z.strictObject({
  name: z.string(),
  version: z.int().positive(),
  value: z.string(),
  stateTag: z.string(),
});

/**
 * import.preview (Run 4.7, P-76): the classification of every entry against
 * the index. Never a value. An invalid entry carries no name (it is typed text
 * and may be anything); a file the parser refuses has issues and no entries.
 */
const importClassification = z.enum([
  "create",
  "update",
  "unchanged",
  "invalid",
  "duplicate",
  "conflict",
]);
const count = z.int().nonnegative();
const importPreviewBody = z.strictObject({
  previewId: z.uuid().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  applicable: z.boolean(),
  counts: z.strictObject({
    create: count,
    update: count,
    unchanged: count,
    conflict: count,
    invalid: count,
    duplicate: count,
  }),
  entries: z
    .array(
      z.strictObject({
        ordinal: z.int().positive(),
        line: z.int().positive(),
        name: z.string().nullable(),
        classification: importClassification,
      }),
    )
    .max(LIMITS.body.dotenvMaxEntries),
  issues: z.array(z.strictObject({ line: z.int().nonnegative(), rule: z.enum(DOTENV_RULES) })),
  warnings: z.array(
    z.strictObject({
      name: z.string(),
      loader: z.enum(["nextjs", "python-dotenv"]),
      kind: z.enum(["expansion", "escape"]),
    }),
  ),
});

/**
 * audit.list (Run 6.1, P-107): the organization's audit trail, newest first.
 * `from` and `to` are RFC 3339 (default: the last 30 days before the first
 * page's anchor; at most 92 days apart). `action` is one of the served
 * actions (checked by the handler against @mykey/audit). A cursor is bound to
 * the filters it was made with: another filter is `409 listing_changed`.
 */
const auditId = z.uuid();
const auditTime = z.iso.datetime({ offset: true });
export const auditListQuery = z.strictObject({
  limit: z.int().min(1).max(LIMITS.listing.maxLimit).default(LIMITS.listing.defaultLimit),
  cursor: z.string().min(1).max(2048).optional(),
  from: auditTime.optional(),
  to: auditTime.optional(),
  action: z
    .string()
    .max(48)
    .regex(/^[a-z]+(?:[._][a-z]+)+$/)
    .optional(),
  outcome: z.enum(["success", "denied", "failure", "intent", "unknown"]).optional(),
  actorKind: z.enum(["user", "machine", "operator", "system", "anonymous"]).optional(),
  actorId: auditId.optional(),
  projectId: auditId.optional(),
  environmentId: auditId.optional(),
  operationId: auditId.optional(),
  requestId: auditId.optional(),
});
const auditItem = z.strictObject({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  actor: z.strictObject({ kind: z.string(), id: z.string().nullable() }),
  source: z.string().nullable(),
  action: z.string(),
  target: z.strictObject({ kind: z.string(), id: z.string().nullable() }).nullable(),
  outcome: z.string(),
  requestId: z.string().nullable(),
  operationId: z.uuid().nullable(),
  /** Parsed again with the action's own schema on the way out; `{}` when the row fails it. */
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export const auditListBody = z.strictObject({
  items: z.array(auditItem),
  nextCursor: z.string().nullable(),
  /** The first page's database time; no row after it is served by this listing. */
  anchor: z.iso.datetime(),
});

/** activity.list (Run 6.1, P-108): the product's events, for the workspace's timeline. */
export const activityListQuery = z.strictObject({
  limit: z.int().min(1).max(LIMITS.listing.maxLimit).default(LIMITS.listing.defaultLimit),
  cursor: z.string().min(1).max(2048).optional(),
  projectId: auditId.optional(),
  environmentId: auditId.optional(),
});
export const activityListBody = z.strictObject({
  items: z.array(
    auditItem.extend({
      /** The operation's state now (read at request time), or null. */
      operation: z
        .strictObject({ id: z.uuid(), state: z.enum(OPERATION_STATES), action: z.string() })
        .nullable(),
      /** The current name of the project or environment the event targets, or null. */
      targetName: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
  anchor: z.iso.datetime(),
});

/** projects.list and environments.list (Run 3.9, P-59): keyset pages in id order. */
const pageQuery = z.strictObject({
  limit: z.int().min(1).max(LIMITS.listing.maxLimit).default(LIMITS.listing.defaultLimit),
  cursor: z.string().min(1).optional(),
});
/** The states of a project or an environment (exported for the workspace, Session 7). */
export const RESOURCE_STATES = [
  "pending",
  "active",
  "revoking",
  "archived",
  "needs_review",
] as const;
const resourceState = z.enum(RESOURCE_STATES);
const projectsBody = z.strictObject({
  projects: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      state: resourceState,
      reviewReason: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const environmentsBody = z.strictObject({
  environments: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      state: resourceState,
      reviewReason: z.string().nullable(),
      kvReady: z.boolean(),
      createdAt: z.iso.datetime(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

/**
 * overview.get (Run 7.3, P-139, FR-1.90): the organization's projects with
 * their environments, read at one database time. Counts come from the secret
 * index, never from OpenBao; `keys` is null where no count was made (an
 * environment that is pending or under review), which is not zero.
 */
const keyCount = z.int().nonnegative();
const overviewBody = z.strictObject({
  observedAt: z.iso.datetime(),
  source: z.literal("index"),
  projects: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      state: resourceState,
      reviewReason: z.string().nullable(),
      environments: z.array(
        z.strictObject({
          id: z.uuid(),
          name: z.string(),
          state: resourceState,
          reviewReason: z.string().nullable(),
          kvReady: z.boolean(),
          /** The newest change the index knows of, or null (none, or not counted). */
          changedAt: z.iso.datetime().nullable(),
          keys: z
            .strictObject({ live: keyCount, deleted: keyCount, needsReview: keyCount })
            .nullable(),
        }),
      ),
    }),
  ),
  /** True when the organization has more projects than the answer holds. */
  truncated: z.boolean(),
});

/** operations.list (Run 4.1, P-63): newest first; children of an import are not listed. */
const operationsListQuery = z.strictObject({
  limit: z.int().min(1).max(LIMITS.listing.maxLimit).default(LIMITS.listing.defaultLimit),
  cursor: z.string().min(1).optional(),
  state: z.enum(["unfinished"]).optional(),
});
const operationsListBody = z.strictObject({
  operations: z.array(
    z.strictObject({
      operationId: z.uuid(),
      action: z.string(),
      state: z.enum(OPERATION_STATES),
      name: z.string().nullable(),
      createdAt: z.iso.datetime(),
      completedAt: z.iso.datetime().nullable(),
      replayExpiresAt: z.iso.datetime().nullable(),
      errorCode: z.string().nullable(),
      mine: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

/**
 * A machine credential as the inventory shows it (Run 5.1, P-86): never the
 * token, never its accessor. `state` is the stored state, except that an
 * `active` credential past its expiry shows as `expired`; `issuedAt` is the
 * completion time of the issuance.
 */
export const CREDENTIAL_STATES = [
  "issuing",
  "active",
  "revoking",
  "revoked",
  "expired",
  "needs_review",
] as const;
const credentialView = z.strictObject({
  credentialId: z.uuid(),
  name: z.string(),
  projectId: z.uuid(),
  environmentId: z.uuid(),
  state: z.enum(CREDENTIAL_STATES),
  issuedBy: z.uuid(),
  issuedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  expiringSoon: z.boolean(),
  lastUsedAt: z.iso.datetime().nullable(),
});
/** credentials.issue (FR-1.41, P-88): the one response of the contract that holds a token. */
const credentialIssuedBody = z.strictObject({
  operationId: z.uuid(),
  credential: credentialView,
  token: z.string().min(1),
});
/** credentials.revoke (Run 5.2, P-89): the envelope of a revocation proven in the backend. */
const credentialRevokedBody = operationResponseSchema.extend({
  result: z.strictObject({ credentialId: z.uuid(), state: z.literal("revoked") }),
});
/** projects.archive, environments.archive (Run 5.3, P-91): what the archive closed. */
const archivedBody = operationResponseSchema.extend({
  result: z.strictObject({
    state: z.enum(["archived", "revoking"]),
    environments: z.int().nonnegative(),
    credentialsRevoked: z.int().nonnegative(),
  }),
});
/** projects.reactivate, environments.reactivate (Run 5.3, P-92). */
const reactivatedBody = operationResponseSchema.extend({
  result: z.strictObject({ state: z.literal("active"), environments: z.int().nonnegative() }),
});
const credentialsListBody = z.strictObject({
  credentials: z.array(credentialView),
  nextCursor: z.string().nullable(),
});
/**
 * credentials.summary (Run 7.7, P-139, FR-1.91): the organization's machine
 * credentials counted by state at one database time, and the active ones
 * within the expiry warning, soonest first. States are derived as
 * `credentials.list` derives them. Never a token, never an accessor.
 */
const credentialCount = z.int().nonnegative();
const credentialsSummaryBody = z.strictObject({
  observedAt: z.iso.datetime(),
  byState: z.strictObject({
    issuing: credentialCount,
    active: credentialCount,
    revoking: credentialCount,
    revoked: credentialCount,
    expired: credentialCount,
    needs_review: credentialCount,
  }),
  expiring: z.array(
    z.strictObject({
      credentialId: z.uuid(),
      name: z.string(),
      projectId: z.uuid(),
      environmentId: z.uuid(),
      expiresAt: z.iso.datetime(),
    }),
  ),
  /** True when more credentials are expiring than the answer holds. */
  expiringTruncated: z.boolean(),
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

  define("projects.list", "GET", `${O}/projects`, "human", false, "3.9", {
    action: null,
    query: pageQuery,
    responses: { 200: projectsBody },
  }),
  define("projects.create", "POST", `${O}/projects`, "human", true, "3.9", {
    action: "resources.manage",
    body: nameBody(projectName),
    completed: 201,
    errors: ["capacity_exceeded", "already_exists"],
  }),
  define("projects.rename", "PATCH", P, "human", true, "3.9", {
    action: "resources.manage",
    body: nameBody(projectName),
    errors: ["capacity_exceeded", "already_exists", "state_conflict"],
  }),
  define("projects.archive", "POST", `${P}/archive`, "human", true, "5.3", {
    action: "resources.manage",
    body: confirmedBody,
    responses: { 200: archivedBody },
    errors: ["state_conflict", ...BACKEND],
  }),
  define("projects.reactivate", "POST", `${P}/reactivate`, "human", true, "5.3", {
    action: "resources.manage",
    body: confirmedBody,
    responses: { 200: reactivatedBody },
    errors: ["capacity_exceeded", "state_conflict", ...BACKEND],
  }),

  define("environments.list", "GET", `${P}/environments`, "human", false, "3.9", {
    action: null,
    query: pageQuery,
    responses: { 200: environmentsBody },
  }),
  define("environments.create", "POST", `${P}/environments`, "human", true, "3.9", {
    action: "resources.manage",
    body: nameBody(environmentName),
    completed: 201,
    errors: ["capacity_exceeded", "already_exists", "state_conflict", ...BACKEND],
  }),
  define("environments.rename", "PATCH", E, "human", true, "3.9", {
    action: "resources.manage",
    body: nameBody(environmentName),
    errors: ["capacity_exceeded", "already_exists", "state_conflict"],
  }),
  define("environments.archive", "POST", `${E}/archive`, "human", true, "5.3", {
    action: "resources.manage",
    body: confirmedBody,
    responses: { 200: archivedBody },
    errors: ["state_conflict", ...BACKEND],
  }),
  define("environments.reactivate", "POST", `${E}/reactivate`, "human", true, "5.3", {
    action: "resources.manage",
    body: confirmedBody,
    responses: { 200: reactivatedBody },
    errors: ["capacity_exceeded", "state_conflict", ...BACKEND],
  }),

  define("secrets.list", "GET", `${E}/secrets`, "human", false, "4.3", {
    action: "secrets.read",
    query: secretsListQuery,
    responses: { 200: secretsListBody },
  }),
  define("secrets.history", "GET", `${E}/secrets/:name/history`, "human", false, "4.3", {
    action: "secrets.history",
    responses: { 200: secretsHistoryBody },
    errors: ["unsupported_history_parameter", "key_under_review", ...BACKEND],
  }),
  define("secrets.reveal", "POST", `${E}/secrets/:name/reveal`, "human", false, "4.3", {
    action: "secrets.read",
    body: z.strictObject({ version: version.optional() }),
    responses: { 200: secretsRevealBody },
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
    errors: ["capacity_exceeded", ...VERSIONED],
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
    responses: { 200: importPreviewBody },
    errors: ["state_conflict", "capacity_exceeded", ...BACKEND],
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
      // Run 6.9 (M-7): an import expired while it waited cannot be resumed.
      errors: ["outcome_unknown", "audit_unavailable", "replay_expired", ...IMPORT_WRITE],
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
    query: pageQuery,
    responses: { 200: credentialsListBody },
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
    responses: { 201: credentialIssuedBody },
    errors: ["capacity_exceeded", "credential_not_replayable", "state_conflict", ...BACKEND],
  }),
  define(
    "credentials.revoke",
    "POST",
    `${E}/credentials/:credential/revoke`,
    "human",
    true,
    "5.2",
    {
      action: "credentials.manage",
      body: confirmedBody,
      responses: { 200: credentialRevokedBody },
      errors: ["state_conflict", ...BACKEND],
    },
  ),

  // Status stays readable while a project or environment is in review (P-63, D-35):
  // action null puts both in state class metadata_read; who sees which row is
  // decided from the operation's own scope and author.
  define("operations.get", "GET", "/v1/operations/:operation", "human", false, "4.1", {
    action: null,
    responses: operation,
    // The operation's organization state answers as on every scoped route (P-53).
    errors: ["state_conflict", "backend_inconsistent"],
  }),
  define("operations.list", "GET", `${E}/operations`, "human", false, "4.1", {
    action: null,
    query: operationsListQuery,
    responses: { 200: operationsListBody },
  }),

  define("audit.list", "GET", `${O}/audit`, "human", false, "6.1", {
    action: "audit.view",
    query: auditListQuery,
    responses: { 200: auditListBody },
  }),
  define("activity.list", "GET", `${O}/activity`, "human", false, "6.1", {
    action: "audit.view",
    query: activityListQuery,
    responses: { 200: activityListBody },
  }),
  define("overview.get", "GET", `${O}/overview`, "human", false, "7.3", {
    action: "audit.view",
    responses: { 200: overviewBody },
  }),
  define("credentials.summary", "GET", `${O}/credentials/summary`, "human", false, "7.7", {
    action: "credentials.manage",
    responses: { 200: credentialsSummaryBody },
  }),
  define("metrics.get", "GET", `${O}/metrics`, "human", false, "7.8", { action: "audit.view" }),

  define("session.activity", "POST", "/v1/session/activity", "human", false, "3.5", {
    action: null,
    responses: { 200: activityBody },
  }),
  define("auth.reset.complete", "POST", "/v1/auth/reset/complete", "reset_flow", false, "3.6", {
    body: resetCompleteBody,
    responses: { 200: z.strictObject({ next: z.enum(["sign_in", "enroll"]) }) },
    errors: ["capacity_exceeded", "audit_unavailable"],
  }),
  // Run 5.9 (P-101): the process's own organization is the scope (no :org in
  // the path); owner and admins see them, everyone else gets the hidden 404.
  define("reference.get", "GET", "/v1/reference", "human", false, "5.9", {
    action: "reference.read",
    responses: { 200: "html-document" },
    errors: ["not_found", "dependency_unavailable"],
  }),
  define("openapi.get", "GET", "/v1/openapi.json", "human", false, "5.9", {
    action: "reference.read",
    responses: { 200: openApiDocumentBody },
    errors: ["not_found", "dependency_unavailable"],
  }),

  // Run 5.4 (P-93, P-94): no query and no body schema — a selector is refused
  // before validation (forbidden_selector).
  define("machine.keys", "GET", `${M}/keys`, "machine", false, "5.4", {
    responses: { 200: keysBody },
    errors: ["environment_changed", ...VALUE_READ],
  }),
  define("machine.resolve", "POST", `${M}/resolve`, "machine", false, "5.4", {
    responses: { 200: resolveBody },
    errors: ["environment_changed", "capacity_exceeded", ...VALUE_READ],
  }),
]);

// The types of the bodies above, for the owner workspace (Session 7, P-136).
// An export is not a contract change.
export type OrganizationsBody = z.infer<typeof organizationsBody>;
export type ProjectsBody = z.infer<typeof projectsBody>;
export type EnvironmentsBody = z.infer<typeof environmentsBody>;
export type SecretsListBody = z.infer<typeof secretsListBody>;
export type SecretsHistoryBody = z.infer<typeof secretsHistoryBody>;
export type SecretsRevealBody = z.infer<typeof secretsRevealBody>;
export type ImportPreviewBody = z.infer<typeof importPreviewBody>;
export type OperationsListBody = z.infer<typeof operationsListBody>;
export type CredentialView = z.infer<typeof credentialView>;
export type CredentialIssuedBody = z.infer<typeof credentialIssuedBody>;
export type CredentialsListBody = z.infer<typeof credentialsListBody>;
export type AuditListBody = z.infer<typeof auditListBody>;
export type ActivityListBody = z.infer<typeof activityListBody>;
export type SessionActivityBody = z.infer<typeof activityBody>;
export type OverviewBody = z.infer<typeof overviewBody>;
export type CredentialsSummaryBody = z.infer<typeof credentialsSummaryBody>;

/** The two machine bodies, for the CLI's validator (Run 5.5, P-96). */
export { keysBody as machineKeysBody, resolveBody as machineResolveBody };
