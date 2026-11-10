# D-15 — Route list frozen on Day 1

**Date:** 2026-11-10

**Status:** DECIDED by the session planner, recorded by the executing agent in Run 1.6

## Decision

The Stage 1 API has exactly 41 routes. They are listed in `packages/contracts/src/routes.ts` (`ROUTES`), each with its id, method, path, authentication class, `Idempotency-Key` requirement, owning run, request schema, response schemas and error codes. `packages/contracts/openapi/openapi.json` is generated from that list and committed.

From now on:

1. **No run adds, renames or removes a route** without a commit titled `contract: …` that updates `ROUTES`, the test table in `tests/unit/contracts/routes.test.ts`, the generated OpenAPI file and this record.
2. **The owning run fills in a pending body** in a commit titled `contract: …`. The list of pending routes may only shrink; it is pinned by `tests/unit/contracts/pending-routes.snapshot.json`.
3. **`GET /v1/operations/:id/status` is a denied alias.** There is one operation-status route, `GET /v1/operations/:operation`.
4. Better Auth's own routes are not in this list. Run 2.3 inventories them.

## What is fixed now

- Every request body of the plan's table, except the password-reset body (Run 3.6).
- `health.get`: `{ "status": "up" | "down" }` on 200 and 503, no other field.
- Every operation-bearing response: `{ operationId, state, statusUrl, replayExpiresAt, result? }` with the seven states `accepted`, `executing`, `awaiting_input`, `uncertain`, `succeeded`, `partial`, `rejected`. `replayExpiresAt` is null until the operation is final.
- `machine.resolve` 200: `{ apiMajor, environmentId, generation, count, entries: [{ name, value }], complete: true }`, strict.
- `export.create` 200: a `text/plain` attachment. Import bodies are raw dotenv text, at most 1,048,576 bytes.
- Every error response: the D-14 envelope.

## What is pending (21 routes)

`version.get`, `organizations.list`, `projects.list`, `environments.list`, `secrets.list`, `secrets.history`, `secrets.reveal`, `import.preview`, `credentials.list`, `credentials.issue` (the 201 body that shows the token once), `operations.list`, `audit.list`, `activity.list`, `overview.get`, `credentials.summary`, `metrics.get`, `session.activity`, `auth.reset.complete` (request and response), `reference.get`, `openapi.get`, `machine.keys`.

In the OpenAPI file a pending body is `{ "type": "object", "x-mykey-pending": true }`.

## Choices made by the executing agent

These are not stated by the plan or the specification. Each can be changed by the owning run with a `contract:` commit.

- **Completed-mutation status.** `projects.create`, `environments.create`, `secrets.create` and `credentials.issue` answer 201 when complete; every other idempotent mutation answers 200; all of them answer 202 while unfinished (Document 06 §9).
- **Per-route error lists** are built from rules (authentication class, method, path parameters, body, idempotency) plus a short list per route. They are the set a route _may_ return. `not_found` is listed exactly on the routes that have a path parameter.
- **`listing_changed` is listed on every `*.list` route.**
- **Credential `name` uses the project-name rule** (1 to 64 code points, no control characters, not whitespace only) until Run 5.1 says otherwise.
- **`expectedStateTag` is a non-empty string**; its format belongs to Run 4.2.
- **Query parameters** are defined only for `secrets.list` (`prefix`, `limit`, `cursor`). Other list routes get theirs from the owning run.
- **Path parameters are plain strings** in OpenAPI, except `:name` and `:envName`, which carry the secret-name and environment-name patterns.
- **The `Idempotency-Key` header is a non-empty string**; its format belongs to Run 4.1.
- **The session cookie is named `__Host-session` in the OpenAPI security scheme** as a placeholder; Run 2.3 sets the real name.
- **`ttlSeconds` has a default**, so the OpenAPI request schema is the _input_ form: the field is optional there.

## Proof

`tests/unit/contracts/routes.test.ts` (the 41-row table, the seven non-idempotent mutations, the denied alias, request and response schemas) and `tests/unit/contracts/openapi.test.ts` (valid OpenAPI 3.1 by `@scalar/openapi-parser`, a broken document is rejected, 41 operations, parameters, security, byte-identical builds, committed file equals a fresh build). `pnpm run check` runs `contracts:check`, which fails when the committed OpenAPI file is stale.

## Amends

Nothing in Documents 04 or 06.
