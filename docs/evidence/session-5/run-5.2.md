# Run 5.2 — Revocation, the fault table and the operator's inventory

**Result: DONE on 15 Nov 2026.**

- The owner (or an admin) revokes a machine credential. It is `revoking` in a committed transaction before OpenBao is asked, so the product denies it first. It reads `revoked` only after a lookup proved the token gone. A revocation that could not be proven stays `revoking`, is never shown as revoked, and a new request finishes it.
- The API's sweep settles credential work whose executor stopped. `ops reconcile-credentials` settles an environment from OpenBao: it revokes every token nobody records, finishes `revoking` rows, and closes unknown issuances when their token was found or the executors are excluded.
- The fault table (AC-1.40): the response lost at every boundary of issuance and revocation never leaves a working token that nobody knows about once the operator has run.
- On staging: issuance, inventory, replay, revocation and the token searched on the host; the drill of an unknown issuance, settled by `quiesce` → `reconcile-credentials` → `resume`.
- Decisions: D-40 (revocation, sweep, `reconcile-credentials` and observations added).

FR-1.42 SPIKE_PASS — revocation: `tests/integration/credentials/revoke.test.ts` (9), `tests/fault/credentials/revocation.test.ts` (3), `tests/staging/credentials.staging.test.ts` (the journey).
FR-1.43 SPIKE_PASS — uncertain or lost issuance: `tests/integration/credentials/sweep.test.ts` (6), `tests/integration/credentials/reconcile.test.ts` (6), `tests/fault/credentials/issuance.test.ts` (8), `tests/staging/credentials.staging.test.ts` (the drill); the lost-delivery procedure in `docs/runbooks/machine-credentials.md`.
AC-1.40 SPIKE_PASS — the fault table: `docs/evidence/session-5/fault-table.md`.

## What was done

- **Contract** (`contract: credential revocation`): `credentials.revoke` answers 200 with the operation envelope, `result: { credentialId, state: "revoked" }`.
- **Revocation** `packages/operations/src/credentials/revoke.ts` and route `credentialsRevokeHandler` (D-40 "Revocation"). `@mykey/db` gains `settleRevocations` and `liveRevocation`.
- **Sweep** `packages/operations/src/credentials/sweep.ts`, run by the API's tick after the secret rules (`apps/api/src/operation-sweep.ts`).
- **Operator** `packages/operations/src/reconcile/credentials.ts` (`@mykey/operations/operator`) and `ops reconcile-credentials` (`apps/ops/src/commands/reconcile-credentials.ts`); audit action `operator.reconcile_credentials` (counts only).
- **Fault table** `tests/fault/credentials/{fixture,issuance,revocation}.test.ts` and `fault-table.md`.
- **Runbooks:** `machine-credentials.md` (new: issue, inventory, revoke, the states, lost delivery, unknown issuance, the FR-1.45 residual), `reconciliation.md` gains "Credentials".
- **Staging** (P-102): the issuer identity's first deploy. API `930ada3d4871` (`sha256:cba06d1a…`) and the matching provisioner (`sha256:f4d0e45c…`), migration `0013` applied. The self-check logged `runtimeLogin: ok` and `issuerLogin: ok`, from the bound address `10.78.3.3/32`. Then `tests/staging/credentials.staging.test.ts` ran (results in `run-5.2-staging.json`).

## Commits

- `2a42526` contract: credential revocation
- `646a041` feat(api): revoke a machine credential, denied first and verified
- `697e56e` feat(ops): credential sweep and reconcile-credentials
- `8ccf939` test(fault): credential issuance and revocation at every boundary
- `930ada3` test(auth): credential routes answer through the stub in the factor suites
- this commit: test(staging): credential issuance, revocation and the inventory drill

## Commands and results

| Command                                                                                     | Result                                                                                                                                |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/credentials/revoke.test.ts` before `revoke.ts`                           | RED (9 failed)                                                                                                                        |
| the same after                                                                              | 9 passed                                                                                                                              |
| `tests/integration/credentials/sweep.test.ts` before `sweep.ts`                             | RED (6 failed: no export)                                                                                                             |
| `tests/integration/credentials/reconcile.test.ts` before the command                        | RED (6 failed: unknown command, exit 64)                                                                                              |
| both after                                                                                  | 12 passed                                                                                                                             |
| `tests/unit/audit/events.test.ts` before the action                                         | RED (1 failed); after: 14 passed                                                                                                      |
| `vitest --project integration --maxWorkers=2 tests/fault/credentials`, three times in a row | 11 passed each time                                                                                                                   |
| mutation: `reconcile-credentials` without the meta link                                     | 5 issuance rows failed; reverted                                                                                                      |
| mutation: an unproven revocation back to `active`                                           | the "drop" revocation row failed; reverted                                                                                            |
| `vitest --project integration --maxWorkers=2` (the whole suite)                             | 1,121 passed, 2 failed (`auth/factors-http`, `auth/fresh`: stub-only APIs met the credential handlers); fixed in `930ada3`: 21 passed |
| `pnpm test`                                                                                 | 899 passed                                                                                                                            |
| staging deploy: `push`, `image api`, `image provisioner`, `db-init` (applied `0013`), `up`  | gate open, `reviewOpen: 0`, `operationsUnresolved: 0`, `provisioner: healthy`, `/health` 200, no restarts                             |
| `vitest --project staging tests/staging/credentials.staging.test.ts` (09:16–09:20 UTC)      | 2 passed                                                                                                                              |
| `pnpm run check`                                                                            | exit 0                                                                                                                                |

## Staging

- **Journey:** issue (300 s) → the inventory shows `active` → the replay answers `409 credential_not_replayable` with `{ credentialId, state: "active" }` → revoke 200 → the inventory shows `revoked`. The token was searched on the host (on fd 3, counts only): the API's log 0, a `pg_dump` 0, Traefik's access log 0, each control found.
- **Drill:** three issuances at a time in each of two environments; OpenBao paused 8 s at 09:16:37 UTC. One attempt was enough: 90 × 201, 16 × `503 busy`, 4 × `409 state_conflict`, and 2 × `503 outcome_unknown`, one per environment. A new issuance for the environment answered `409 state_conflict`.
  - The probe delivered `operations_unresolved` at 09:18:27.
  - `quiesce` at 09:18:45, then `ops reconcile-credentials --executors-excluded yes` for each environment: exit 0, `issuances-settled 1` each.
  - `resume` and `gate open` at 09:19:41. A new issuance → 201, revoked.
  - The alert cleared at 09:19:44. `status`: gate open, `reviewOpen: 0`, `operationsUnresolved: 0`.
- All 94 credentials of the project read `revoked` afterwards.
- The plan's fallback (stopping the API about 150 ms after an issuance) was not needed: the pause method carried over.

## Deviations and decisions

- Task C came before Task B: the fault rows end with the sweep and the operator command.
- `reconcileCredentials` takes `{ pool, admin, bao, requestId }` and `{ scope, executorsExcluded }`, and answers `{ kind: "busy" }` when the lock is held 2 s. Lookups and revocations need a client in the namespace, the lock needs the scope, and operators have no id (as `reconcile-environment`). `left` admits a null credential id: a token no row names whose `meta` names no credential either.
- `sweepCredentials` takes an optional environment; the command runs it first for its environment, with no stale time when the executors are excluded.
- The expiry rule writes no audit row: it is not an operation.
- `unproven` revocations are listed in `left` and exit 3, like `needs_exclusion`.
- A second revoke while the first holds the lock is answered before the lock (`liveRevocation`), as `409` with the first's id.
- Seams instead of stopping shared services: "OpenBao paused during the revoke" is the relay in hold mode; "stopped before the call" is the relay's upstream on a closed port.
- The fault table's "holds the request 10 s past the deadline" is 3 s past it: see `fault-table.md` and D-40's observations (a request that reaches OpenBao more than about 10 s after its connection opened is never served).
- The tick's wiring has no test of its own (its unit test injects the sweep); the commands run the sweep themselves.
- Two older suites (`auth/factors-http`, `auth/fresh`) answer the credential routes through the stub: their APIs hold no issuer identity.

## Open issues

- The checkpoint `pairs-lock-session-gate` is due from 10:42:20 UTC; this run ended at about 09:30 UTC. It is recorded at the start of the first run that begins after that time.
