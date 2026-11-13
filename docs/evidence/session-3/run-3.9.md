# Run 3.9 — Projects and environments

**Result: DONE on 13 Nov 2026.** Projects and environments are created and renamed through durable, replayable operations; their names pass their boundary tests; lists are keyset pages under signed cursors; a new environment is pending — and cannot start a credential issuance — until the provisioner has verified its objects; nothing deletes a project or an environment.

FR-1.14 SPIKE_PASS — product code, real stores: create and rename of projects with replay, conflicts, races and audit (`tests/integration/resources/projects.test.ts`, 27).
FR-1.15 SPIKE_PASS — product code, real stores: project and environment names at their boundaries, NFC, exact uniqueness (`projects.test.ts`, `environments.test.ts`, 18).
FR-1.16 SPIKE_PASS — product code, real stores: a new environment is pending until its machine policy and token role are verified; "a pending environment cannot issue credentials" is proven at the state gate here and is proven again on the real issuance route by Run 5.1 (`readiness.test.ts`, 4).
FR-1.19 SPIKE_PASS — product code, real stores: no route, repository function or runtime right deletes a project or an environment (`no-delete.test.ts`, 4).
AC-1.10 SPIKE_PASS — product code, real stores: the suites above and `listing.test.ts` (6).

## What was done

- **Task A** — `@mykey/operations`: `intentFingerprint`, `sameIntent`, `beginOperation`, `operationResponse`; `apps/api/src/pipeline/cursor.ts`: `signCursor`, `readCursor`. `OperationRow` carries `replayExpiresAt`.
- **Task B** — contract commit (list bodies); the pipeline's mutation step (key, replay before state and freshness, `ApiContext.idempotencyKey`); `authorize` stops before state, `admitStates` follows the replay lookup; handlers in `apps/api/src/routes/resources.ts`; repository `packages/db/src/repos/resources.ts`; `completeOperation`; audit actions `project.create|rename`, `environment.create|rename`; migration `0009_resource_generation`.
- **Task C** — environment and listing suites (the code came with Task B).
- **Task D** — readiness and no-deletion suites; D-33.
- Earlier suites adapted to real handlers: the authorization matrix (any 2xx is "allowed", unique names for creates and renames), the state table, `routes-mounted` (Idempotency-Key on mutations, six more handled routes), revocation.

## Commits

- `feat(operations): replay identity and intent fingerprint; signed list cursors` (+ `style(api): no string spread in the cursor test`)
- `contract: project and environment list bodies`
- `feat(api): create, rename and list projects`
- `feat(api): create, rename and list environments; keyset pages`
- `test(resources): readiness and the absence of deletion`
- `test: earlier suites on the real resource handlers; D-33 and the Run 3.9 note` (this commit; the provisioner's credential directory variable renamed `MYKEY_PROVISIONER_CREDENTIALS_DIR`, a name the compose check accepts)

## Commands and results

| Command                                                                                     | Result                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest --project unit tests/unit/operations tests/unit/api/cursor.test.ts` before the code | 9 failed (RED)                                                                                                                                                                                                                                                                                                                                           |
| the same after                                                                              | 9 passed                                                                                                                                                                                                                                                                                                                                                 |
| `projects.test.ts` before the handlers                                                      | 18 failed, 8 passed (refusals the pipeline already made)                                                                                                                                                                                                                                                                                                 |
| the same after                                                                              | 26 passed, then the race of two creates: `[201, 503]` (deadlock) → fixed → 27 with the rename race (RED `[503, 200]` first)                                                                                                                                                                                                                              |
| `environments.test.ts`, `listing.test.ts`                                                   | 18 and 6 passed (first run)                                                                                                                                                                                                                                                                                                                              |
| `listing.test.ts` without the generation bump                                               | the `listing_changed` case fails                                                                                                                                                                                                                                                                                                                         |
| `readiness.test.ts`, `no-delete.test.ts`                                                    | 4 and 4 passed (`no-delete` after reading `secrets.undelete` as a restore)                                                                                                                                                                                                                                                                               |
| database + authz + api folders                                                              | 15 files, 257 passed                                                                                                                                                                                                                                                                                                                                     |
| `pnpm test`                                                                                 | 823 passed                                                                                                                                                                                                                                                                                                                                               |
| `pnpm run test:integration`                                                                 | 66 files: 61 passed; 4 tests failed — three suites written before Run 3.9's handlers (`factors-http`, `concealment` counting the outbox dispatcher's polls, `drift`), `hosts/compose` without the provisioner's variables (fixed in this commit, each re-run green), and `fault/effects/exclusion` (`busy` under the load of the whole run; green alone) |
| `pnpm run check`                                                                            | exit 0                                                                                                                                                                                                                                                                                                                                                   |

## Deviations and decisions

- Migration `0009` (the plan's `0007`; `0007` and `0008` were taken by Runs 3.7 and 3.8). It also adds `created_at` to `project` and `environment`, which the list bodies and the rename test need and which did not exist.
- One repository file `resources.ts` for projects and environments (the plan names two).
- Lock order: creates raise the generation before any share lock; the renamed row is locked `FOR UPDATE` in the admission recheck. Both deadlocks were seen in the race tests.
- The replay target is the deepest id of the path (organization for a project create, project for a rename or an environment create, environment for its rename).
- The Task C suites passed on their first run: the environment code was written with Task B's shared mutation frame.

## Open issues

- `tests/fault/effects/exclusion.test.ts` (Session 2 spike) reports `busy` executors under the load of the whole integration run; green alone. Watched at the gate.

- `operations.get` still answers 404 until Run 4.1 resolves an operation to its scope; the `statusUrl` of every answer points there.
