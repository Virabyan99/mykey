# Run 3.7 — Authorization pipeline

**Result: DONE on 13 Nov 2026.** Every human route answers only what Doc 04 §1.1 allows its caller, decided on every request from current rows; hidden is the same 404 as absent; state precedence follows Doc 04 §1.2; a change to a grant, a membership, a session or an account takes effect on the next request.

FR-1.09 SPIKE_PASS — product code, real stores: `decide` from the contract, every cell of the matrix (`tests/integration/authz/matrix.test.ts`, 924 cells, 0 mismatches); secret, credential and audit routes on stub handlers.
FR-1.10 SPIKE_PASS — product code, real stores: hidden equals absent (status, header names, body but for the request id, length), wrong parents and non-UUID ids are 404, client-supplied selectors refused, mixed credentials 400 before any query.
FR-1.11 SPIKE_PASS — product code, real stores: `tests/integration/authz/revocation.test.ts` (8): grant deleted or lowered, membership revoked, admin lowered, session revoked, account disabled, 20 flips in a row, an in-flight request finishes and the next is denied.
AC-1.08 SPIKE_PASS — product code, real stores: the matrix, the state table (`states.test.ts`, 21) and revocation suites above; the owner runs of the stubbed routes re-run `matrix.test.ts` with their handlers.

## What was done

- **Contract** (`packages/contracts/src/authz.ts`): `ACTIONS`, `decide`, `stateClassOf`; every route carries `action` and `scope`; every route under `/v1/organizations/:org` lists `state_conflict` and `backend_inconsistent`; `organizations.list` body. Two `contract:` commits.
- **Pipeline** (`apps/api/src/pipeline/{origin,authz,states,route}.ts`), final order: request id → gate → body limits → mixed credentials → Origin → authentication → strict validation → ancestry and membership → visibility → action → state → freshness → handler. Refusals are audited as `access.denied` with `{ routeId, reason }`; the organization id only for a member.
- **Origin** (FR-1.76) on every non-GET human, fresh and reset route and on every POST under `/v1/auth` (sign-in included), through the API's one `checkOrigin`, passed to the auth module as `AuthRouteEnv.originAllowed`.
- **`resolveAccess`** (`packages/db/src/repos/memberships.ts`): membership, grants and the three state rows in one statement; `listOrganizations`.
- **Migration `0007_review_reason`**: `review_reason` on organization, project and environment, present only in `needs_review`, a short code; the provisioner and the API may set it.
- **Harness**: `tests/harness/tenants.ts` (`createTenants`, seven users, two organizations; `activeTarget` for suites whose owner comes from `seedOwner`); an empty header value omits the header; `stubHook` lets a stub wait on a latch.
- D-31.

## Commits

- `contract: an action and a scope for every route`
- `contract: organizations.list body`
- `feat(api): origin check, tenant resolution, visibility and action checks`
- `test(authz): the authorization matrix, cell by cell`
- `feat(api): state precedence; test(authz): revocation takes effect on the next request` (this commit, with this note)

## Commands and results

| Command                                                                                                                      | Result                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `vitest --project unit tests/unit/authz` before `authz.ts`                                                                   | 39 failed (RED)                                                 |
| the same after                                                                                                               | 40 passed                                                       |
| `vitest --project integration tests/integration/authz` (origin, concealment) before the pipeline steps                       | 13 failed, 12 passed (the selector cases already held)          |
| the same after                                                                                                               | 25 passed                                                       |
| `matrix.test.ts`                                                                                                             | 924 cells: A 312, D 142, H 470; 0 mismatches                    |
| `matrix.test.ts` with a reader allowed to write                                                                              | 16 cells fail (the commit message of the matrix says 12: wrong) |
| `states.test.ts`, `revocation.test.ts`                                                                                       | 29 passed (first run: the state code came with Task B)          |
| `states.test.ts` with `checkStates` skipped                                                                                  | 15 failed                                                       |
| `revocation.test.ts` with a per-user cache of `resolveAccess`                                                                | 6 failed                                                        |
| `vitest --project integration tests/integration/auth tests/integration/authz`                                                | 20 files, 142 passed (before Task D's files)                    |
| `vitest --project integration tests/integration/ops tests/integration/database tests/integration/api/routes-mounted.test.ts` | 9 files, 187 passed                                             |
| `pnpm test`                                                                                                                  | 802 passed                                                      |
| `pnpm run check`                                                                                                             | exit 0                                                          |

## Deviations and decisions

- Migration number `0007` (the plan says `0006`, which Run 3.6 used).
- Routes the plan's action list does not name: `credentials.summary` → `credentials.manage`, `import.resume` → `secrets.write`.
- The state class `lifecycle` (archive, reactivate, credential revocation) gets the organization rows only; resource states for those are decided by Runs 5.2 and 5.3. `session.activity` (POST, no scope) has class `none`.
- `review_reason` is a short code (`^[a-z][a-z_]{0,63}$`); `api_runtime` also may update it (0001's rule: every column but ids and keys; a state change away from `needs_review` must clear it).
- Suites of earlier runs that used random ids on organization routes, or `organizations.list`'s stub as "a product route", now use an active target of their owner or `reference.get`; `routes-mounted` also asserts that its terminal 404 is not an `access.denied`.
- `matrix.test.ts` writes `docs/evidence/session-3/authorization-matrix.md`, which is in `.prettierignore` (generated).
- Under the parallel run of six integration folders, `ops/reset` and `ops/bootstrap`'s "killed at each point" cases timed out at 120 s; alone they pass (9 files, 187 passed). Load, as with Run 3.6's `health.test.ts` flake; watched at the gate.

## Open issues

- `operations.get` (scope `operation`) answers 404 to everyone until Run 4.1 defines how an operation id resolves to its environment.
