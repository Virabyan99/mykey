# Run 5.1 — Token issuance and inventory

**Result: DONE on 15 Nov 2026.**

- The owner (or an admin) with a fresh second factor issues a machine token for an environment and sees it once, in the 201 of `credentials.issue`. A replay of that request answers `409 credential_not_replayable` with the credential's id and current state, never the token.
- Issuance has a marker: the credential is `issuing` and the operation `executing` in one committed transaction before OpenBao is asked; a failure after it delivers nothing and leaves the issuance unresolved (`needs_review` / `uncertain`), which blocks the next issuance for that environment.
- The inventory (`credentials.list`) shows the catalog's view, newest first, never an accessor or a token.
- No token bytes exist in PostgreSQL, the API's log lines, `audit.event`, schema `jobs` or OpenBao's audit device.
- Decisions: D-40 (issuance part).

FR-1.39 SPIKE_PASS — issue: `tests/integration/credentials/protocol.test.ts` (12), `tests/integration/credentials/issue.test.ts` (8), `tests/integration/openbao/issuance.test.ts` ("token metadata, lifetime and issuer sessions", 8).
FR-1.41 SPIKE_PASS — inventory: `tests/integration/credentials/inventory.test.ts` (5), `tests/integration/credentials/surfaces.test.ts` (5), `tests/unit/contracts/token-fields.test.ts` (2).

FR-1.40 (native scope) is asserted here for what was created (the token reads its environment's names in OpenBao; `checkIssuedToken` requires exactly the machine policy) and gets its status in Run 5.4 Task C.

## What was done

- **OpenBao client** (`packages/openbao/src/client.ts`): `TokenInfo` gains `creationTtlSeconds`, `numUses`, `expireTime`, `issueTime` and `meta`; `tokenCreateFromRole` sends `meta` when given.
- **Issuer identity** (`apps/api/src/runtime-bao.ts`): `issuerBaoFromDirectory` — one login per step, `close()` revokes it and never throws. `RuntimeBao` gains `organizationId()` and `withToken()` (used from Run 5.4). The API, the test API and the child API process hold the issuer beside the runtime identity. The self-check logs `issuerLogin`.
- **Verification** (`packages/operations/src/credentials/verify.ts`): `checkIssuedToken` (one fault per property) and `revokeAndVerify` (absence proven by a 400 lookup).
- **Migration `0013_credential_lifecycle`**: the unresolved-issuance unique index, an `(environment_id, state)` index, and the narrowed `UPDATE` grant of `api_runtime`. Privilege matrix and `db-globals-inventory.md` extended in the same commit.
- **Repository** `packages/db/src/repos/credentials.ts` and **protocol** `packages/operations/src/credentials/issue.ts` (D-40 "Issuance").
- **Contract** (`contract: machine credentials`): the credential view, the 201 of `credentials.issue`, the page of `credentials.list`; `credential_not_replayable` takes `{ credentialId, state }` details. Both routes left the pending snapshot.
- **Routes** `apps/api/src/routes/credentials.ts`; `replayAnswer` gains the one special row; the pipeline's replay step adds the details.
- **Audit** actions `credential.issue` and `credential.revoke`.
- **Harness**: `tests/harness/credentials-fixture.ts` (`createCredentialsFixture`, `issueFor`, `machineAccessors`, `expectCatalogMatchesBackend`, `clearCredentials`); the secrets fixture installs the issuer files, takes extra test routes and a broken runtime credential (Run 5.4).

## Commits

- `8a4fcbb` docs(evidence): session 5 owner requests
- `401fec4` feat(openbao): token metadata and lifetime fields; issuer sessions
- `edea921` contract: machine credentials
- `bb1e782` feat(operations): machine credential issuance with a marker
- this commit: feat(api): issue a machine token once; credential inventory

## Commands and results

| Command                                                                                                                   | Result                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `vitest --project unit tests/unit/operations/credentials-verify.test.ts` before `verify.ts`                               | RED (16 failed: no export)                                                        |
| the same after                                                                                                            | 16 passed                                                                         |
| `vitest --project integration tests/integration/openbao/issuance.test.ts` before                                          | RED: 8 new cases failed (no fields, no `issuerBaoFromDirectory`)                  |
| the same after                                                                                                            | 17 passed (two cases corrected after the first run: see the observations of D-40) |
| `tests/unit/contracts/token-fields.test.ts` before the contract commit                                                    | RED (found no token field)                                                        |
| the same after                                                                                                            | 2 passed                                                                          |
| `tests/integration/credentials/protocol.test.ts`                                                                          | 12 passed                                                                         |
| mutation: the finalize no longer re-reads the parents                                                                     | "an archive that took precedence wins" failed (201 instead of 409); restored      |
| `tests/unit/operations/replay.test.ts` against the replay code before the change                                          | RED (1 failed)                                                                    |
| the same after                                                                                                            | 19 passed                                                                         |
| `tests/integration/credentials/{issue,inventory,surfaces}.test.ts`                                                        | 18 passed                                                                         |
| `vitest --project integration --maxWorkers=2 tests/integration/credentials tests/integration/authz tests/integration/api` | 152 passed                                                                        |
| `vitest --project integration tests/integration/api/selfcheck.test.ts tests/integration/database`                         | 135 passed                                                                        |
| `pnpm test`                                                                                                               | 897 passed                                                                        |
| `pnpm run db:check`                                                                                                       | migrations match the schema                                                       |
| `pnpm run check`                                                                                                          | exit 0                                                                            |

## Deviations and decisions

- The contract commit and the two handlers came at the start of Task B: Task B's tests go through the route.
- `0013` reaches P-86's grant (`accessor`, `effective_expires_at`, `state`, `last_used_at`) by revoking the other four columns that `0001` granted.
- The audit details of `credential.issue` hold the name's length, not the name (as `project.create`): the audit schema walker admits no free text of 64 characters or more.
- Token roles have no `token_max_ttl`; the shorter-maximum cases set `token_explicit_max_ttl` 60.
- "OpenBao stopped" cases (issuer login, `not_sent`) are proven with the target on a closed port instead of stopping OpenBao on the shared stack, which other suites use at the same time.
- `ttlSeconds` `1.5` and `"60"` are `400 malformed_request`, not 422: the pipeline answers a wrong type with 400 and a broken rule with 422 (`validate.ts`, Doc 06 §9). `0`, `−1` and `2,592,001` are 422.
- A lookup of the new token that fails is treated as "not provably what was asked for": revoked and verified; proven → `rejected` `dependency_unavailable` without review.
- `status.sh` reports no `runtimeLogin` today (the staging test reads the `selfcheck` log line), so `issuerLogin` lives in the same log line and is checked the same way (Run 5.2 Task D).
- `surfaces.test.ts`: the log control is the route's request line; the request log carries no credential id.
- `issue.ts` was written before `protocol.test.ts` first ran; a mutation run (above) showed the tests catch a broken finalize.
- Two older suites assumed the credential routes have no handler: `routes-mounted.test.ts` lists them as handled, and `authz/states.test.ts` answers them through the stub (the state table is about the pipeline).

## Open issues

- The checkpoint `pairs-lock-session-gate` is due from 10:42:20 UTC; this run ended at about 07:45 UTC. It is recorded at the start of the first run that begins after that time.
- The sweep does not yet settle an issuance whose unknown outcome could not be written (Run 5.2 Task C).
