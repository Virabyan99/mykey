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

## Amendment (Session 11, 25 Nov 2026; D-80)

The route list grows from 41 to **57**, in one `contract:` commit of Run 11.2. No existing route changes its id, method, path, class or error list.

**The sixteen routes:**

- `machine.metadata`, `machine.exchange`;
- `runtime_credentials.issue`;
- `automation_credentials.list`, `automation_credentials.issue`, `automation_credentials.revoke`;
- `automation.projects.list`, `automation.projects.create`, `automation.projects.get`, `automation.environments.create`, `automation.secrets.list`, `automation.secrets.create`, `automation.runtime_credentials.list`, `automation.runtime_credentials.issue`, `automation.runtime_credentials.revoke`, `automation.operations.get`.

**Two authentication classes:**

- `machine_exchange`: the bearer is a runtime credential's client secret (`mkrc.<id>.<43 characters>`). One route has it.
- `automation`: the bearer is an automation credential's secret (`mkac.<id>.<43 characters>`). The ten routes under `/v1/automation` have it, with no `:org` in the path (D-34). Each names a `right`: one of `AUTOMATION_RIGHTS`, or `any` for a read.

Neither class has an Origin rule. `automation` lists what `machine` lists without `forbidden_selector`, plus `state_conflict` and `backend_inconsistent`. `machine_exchange` lists what `machine` lists, plus `audit_unavailable` and the backend's three codes. **No error code is added.**

**Three additive fields on existing bodies**, nothing removed or renamed:

- a credential's view gains `kind` (`token`, `runtime`), `issuedByKind` (`user`, `automation`) and `boundCidrs`;
- a project's row in `projects.list` gains `managedBy` (a UUID or null);
- a history actor's `kind` gains `machine`.

**What does not change, byte for byte:** the bodies of `machine.keys` and `machine.resolve`. `tests/unit/contracts/machine-bodies.snapshot.json` was taken from the code before this commit and the test compares both schemas with it. `machine.metadata` is a new route beside them because the shipped CLI (`cli-v0.1.2`) parses their strict bodies.

**Three answers hold a secret once** and are never replayed (`credential_not_replayable`): `runtime_credentials.issue` and `automation.runtime_credentials.issue` (`clientSecret`), and `automation_credentials.issue` (`secret`). `machine.exchange` answers a token of 15 minutes and stores nothing. `tests/unit/contracts/token-fields.test.ts` lists these five fields and fails for a sixth.

**Choices made by the executing agent:**

- **A member who calls `automation_credentials.*` gets `403 action_denied`,** as on `credentials.summary`: the organization is visible to its members, and `decide()` answers `denied` for an action a member lacks. The plan's test text said 404.
- **On `automation_credentials.issue`, `not_found` has a second meaning:** `replaces` names no credential of the organization. The code is already listed for `:org`.
- **A machine route's `version` in `machine.metadata` is nullable,** for a live name whose index row holds none.
- **Until Runs 11.3 and 11.5,** a route of the two new classes answers the terminal `404` to every caller: the build has no way to authenticate it, so no handler of such a route can be reached (`apps/api/src/pipeline/route.ts`).

**Proof:** `tests/unit/contracts/routes.test.ts` (the 57-row table, the eight non-idempotent mutations, the rights, the error lists, the snapshot), `automation.test.ts`, `openapi.test.ts` (57 operations, four security schemes), `token-fields.test.ts`, `tests/unit/authz/route-actions.test.ts` and `tests/integration/api/routes-mounted.test.ts`.

**Amends:** Doc 10 §4.2 and Doc 04 FR-1.39, as D-80 says.
