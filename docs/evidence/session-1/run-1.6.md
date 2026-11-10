# Run 1.6 — Contracts foundation

## What was done

- **Task A** — `packages/contracts/src/limits.ts` (every number of Document 06 §11 as the frozen `LIMITS`), `names.ts` (`checkSecretName`, `checkEnvironmentName`, `checkProjectName`, `checkSecretValue`) and `ids.ts` (branded UUID schemas).
- **Task B** — `errors.ts`: thirty error codes with one HTTP status each, and the strict error envelope. Decision record D-14.
- **Task C** — `routes.ts`: the frozen list of 41 routes with request, response and error definitions; `operation.ts`: the operation response; `openapi.ts`: the OpenAPI 3.1 builder; `scripts/contracts-openapi.ts`; the generated `packages/contracts/openapi/openapi.json`. Decision record D-15.
- Root scripts `contracts:openapi` and `contracts:check`; `check` now ends with `contracts:check`.

## Commits

- `8f21a66` feat(contracts): limits, name and value validators, id types
- feat(contracts): error envelope and code list
- feat(contracts): frozen route list and generated OpenAPI 3.1 (this commit)

## Commands and results

| Command                                                 | Exit | Proof line                                                                            |
| ------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `pnpm test` with the three new test files, no code yet  | 1    | `Failed Tests 19`, `buildOpenApiDocument is not a function`, `expected undefined …`   |
| `pnpm test` after the implementation, before generating | 1    | `Tests 2 failed \| 91 passed (93)` — the committed file and the snapshot were missing |
| `pnpm run contracts:openapi`                            | 0    | `Wrote …/packages/contracts/openapi/openapi.json (41 routes).`                        |
| `pnpm test`                                             | 0    | `Test Files 9 passed (9)`, `Tests 94 passed (94)`                                     |
| `pnpm run contracts:check` after appending one space    | 1    | `openapi.json is out of date`                                                         |
| `pnpm run contracts:check`                              | 0    | `OpenAPI document is current.`                                                        |
| `pnpm run check`                                        | 0    | format, lint, typecheck, pins and contracts all pass                                  |

What the tests prove: the code set equals the D-14 table; the ten codes the specification names keep their statuses; the envelope is strict. The route list equals the plan's 41-row table field by field; exactly seven POST routes need no `Idempotency-Key`; the denied alias is absent; `secrets.update` rejects a missing `expectedStateTag`, a missing `expectedVersion`, an unknown key and a NUL in the value; `credentials.issue` rejects `ttlSeconds` 0, −1, 1.5 and 2,592,001 and accepts 2,592,000; `machine.resolve` rejects a partial set. The OpenAPI document is valid 3.1, a deliberately broken copy is rejected by the same validator, and two builds are byte-identical.

## Deviations and decisions

- **Tasks B and C were developed together** (tests for both first, then the code), and committed as the plan's two commits.
- **A pending body is the marker `PENDING` in `ROUTES`**, rendered in OpenAPI as `{ "type": "object", "x-mykey-pending": true }`. A route's `pending` flag is computed from its bodies, so it cannot disagree with them.
- **`not_found` is listed on the routes that have a path parameter**, not on every authenticated route.
- **`@mykey/contracts` is a root development dependency** so that `scripts/contracts-openapi.ts` can import it; `@scalar/openapi-parser` and `zod` are development dependencies of `@mykey/tests`.
- The other choices (201 for creates, credential name rule, placeholder cookie name, plain-string path parameters) are listed in D-15 under "Choices made by the executing agent".

## Open issues

- 21 routes still have a pending body; the owning runs fill them in with `contract:` commits.
- The generated OpenAPI file is 163 KB, mostly repeated parameter and error-response blocks. It is not size-critical; shared `components.parameters` would shrink it if that ever matters.
