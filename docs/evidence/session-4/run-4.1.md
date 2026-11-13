# Run 4.1 — Operation records and replay

**Result: DONE on 13 Nov 2026.** Operations carry their scope; a replay answers by the operation's stored state; path parameters are part of the intent; terminal records expire into `replay_expired` through an operator command; an operation's status and the environment's operation list are visible by the operation's own scope and author; the carried provisioning minors are closed.

No registry status changes in this run. `FR-1.82` and `FR-1.83` are proven here for records and replay (`records.test.ts`, `replay.test.ts`, `status.test.ts`); "no external effect tracked only in a lost transaction" needs the fault suite, so Run 4.6 sets their status (plan, Run 4.1 "Registry").

## What was done

- **Task A** — migration `0011_operation_scope` (columns `project_id`, `environment_id`, `secret_name` with the name check, `parent_operation_id`; backfill from `target`; indexes `operation_environment_created_idx`, `operation_unresolved_idx`; `api_runtime` loses `INSERT`/`UPDATE` on `app.operation_tombstone`). Repository: `claimDispatch`, `finishOperation` (one conditional update), `touchOperation`, `hasTombstone`, `expireOperations`; `OperationRow` carries the new columns and `expired` (database time).
- **Task B** — `Intent.params` and `intentOf` (P-64); `replayAnswer` (P-65); `operationResponse` puts `{ errorCode }` on a rejected row and nothing on an uncertain one; `ApiError` and `errorResponse` carry `operationId` and allowlisted `details` (`checkDetails`); the pipeline's replay step (expiry before the fingerprint, tombstones when no row); `ops operations-expire` with audit `operator.operations_expire`. A test-only idempotent route `test.ops` (`tests/harness/test-ops.ts`).
- **Task C** — contract commits `contract: operation status and list` and `contract: operations.get answers the organization's state codes`; scope `operation` in `authorize`; handlers `operations.get` and `operations.list` (`apps/api/src/routes/operations.ts`, repository `listOperations`); `beginOperation` writes the scope columns for the Session 3 resource routes; the pipeline matrix runs with `stubs: "all"` (P-80) and gains the operation rows (`docs/evidence/session-4/authorization-matrix.md`).
- **Task D** — provisioning activation is conditional (operation still `executing` under this worker, environment still `pending`; otherwise the operation goes to `awaiting_input`/`state_conflict`); `environment.provision` expires a held job after 120 s, also on an existing queue (`updateQueue`); the queue-privilege test asserts the real denial; `startTestApi({ beforeHandler })` and the admission-recheck case for `projects.create`. D-35.

## Commits

- `feat(db): operation scope columns, dispatch claim, conditional finish, expiry`
- `feat(api): replay answers by state, path parameters in the intent, expiry`
- `contract: operation status and list`
- `contract: operations.get answers the organization's state codes`
- `feat(api): operation status and list`
- `fix(provisioner): activation guard and job expiry; stricter privilege and admission tests`
- `docs: run 4.1 note` (this note)

## Commands and results

| Command                                                                                                     | Result                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest --project integration tests/integration/operations/records.test.ts` before the code                 | 7 failed, 1 passed (RED: functions and columns missing)                                                                                                                   |
| the same after migration `0011` and the repository                                                          | 8 passed                                                                                                                                                                  |
| `tests/integration/database/privileges.test.ts` after `0011`                                                | first 2 failures (the new insert-only columns were not in the matrix) → matrix extended → 92 passed                                                                       |
| `vitest --project unit tests/unit/api/respond.test.ts tests/unit/operations/replay.test.ts` before the code | 10 failed (RED)                                                                                                                                                           |
| `vitest --project integration tests/integration/operations/replay.test.ts` before the code                  | all failed (RED: `intentOf` missing)                                                                                                                                      |
| unit `api`, `operations`, `audit`, `ops`; integration `operations` after                                    | 121 and 23 passed                                                                                                                                                         |
| `tests/integration/{resources,api,authz}` (Session 3's replay cases must not move)                          | 15 files, 194 passed                                                                                                                                                      |
| `status.test.ts` before the handlers                                                                        | 11 failed, 2 passed (RED)                                                                                                                                                 |
| the same after                                                                                              | 13 passed (after two test fixes: parameter types in the test's SQL, the project of env2a; and one contract finding, below)                                                |
| `tests/integration/authz` with `stubs: "all"`                                                               | 64 passed (one named case adjusted, below)                                                                                                                                |
| `tests/integration/api/routes-mounted.test.ts`                                                              | the `operations.*` 404 cases removed (they have handlers now) → passed                                                                                                    |
| `environment.test.ts -t "activation requires                                                                | taken again"` first run                                                                                                                                                   | both **passed at once** — the activation case was vacuous (the crash point hit a tenant environment's job, not the test's) → tests made self-contained and stronger → RED: `active` instead of `needs_review`; `stayed pending` after 180 s |
| `jobs/privileges.test.ts` with an exact denial                                                              | showed the old test passed on `PGBOSS_QUEUE_NOT_FOUND`, not a privilege refusal → now asserts `42501 permission denied for function create_queue` and `… for table queue` |
| `projects.test.ts -t "admission recheck"` before the hook                                                   | RED (201 instead of 503)                                                                                                                                                  |
| after the activation guard, `expireInSeconds: 120` and the hook                                             | `environment.test.ts` 10 passed (the expiry case finished well within 180 s); `projects.test.ts` + `jobs` 39 passed                                                       |
| `pnpm run check`                                                                                            | exit 0                                                                                                                                                                    |

## Deviations and decisions

- **Tombstone rights.** The plan says migration `0011` has no grant changes, but its own test requires `api_runtime` to fail `expireOperations` with `42501`, and `api_runtime` held `INSERT` on every `app` table. `0011` revokes `INSERT, UPDATE` on `app.operation_tombstone` from `api_runtime` (D-35).
- **`operations.get` error list.** Its path is not under `/v1/organizations`, so it lacked `state_conflict` and `backend_inconsistent`; an organization in review answered `unlisted_error`. A second contract commit adds both (P-53 applies to every scoped route).
- **The list's anchor** travels as microseconds since the epoch in the cursor's generation field (digits only), not as the full sort key.
- **Test routes and operation visibility.** `actionOfOperation` also looks up the harness's test routes, so an operation made through `test.ops` resolves its action like a contract route's.
- **The status-after-expiry case** sits in `status.test.ts`, not `replay.test.ts` (the route is built in Task C).
- **The matrix's named case** "envEditorA … sees project 1 in projects.list" lost its body assertions under `stubs: "all"`; the list contents are covered on real handlers by `tests/integration/resources/listing.test.ts` ("envEditorA: project 1 and, inside it, environment 1a only").
- An environment whose activation finds it no longer `pending` ends its operation `awaiting_input` with `error_code` `state_conflict` and writes no audit row (the review was someone else's act).

## Open issues

- None new. The secret routes still end in the terminal 404 until Runs 4.2–4.4.
