# Run 11.3 — The runtime credential: issue, revoke, exchange, metadata

**Date:** 25 to 26 Nov 2026. **Branch:** `session-11`. P-185 to P-190, P-196. Decisions: D-81 (new), D-83 (amended: the fleet).

## What was done

- **Task A, the credential.** A runtime credential is a row of `app.machine_credential` with `kind = 'runtime'`. `runtime_credentials.issue` (a fresh second factor) writes the operation, the row and the audit row in one transaction and shows the client secret once. `credentials.revoke` revokes it in one transaction. It is listed, counted, warned about, archived and restored with every other credential.
- **Task B, the exchange.** `POST /v1/machine/exchange` gives a 900-second, non-renewable token of the credential's one environment and stores nothing. A machine token that says it was exchanged is attributed to the credential its `meta` names. The credential's networks are checked at the exchange and on every machine request. Limits: 10 exchanges a minute for each credential, and the miss rule. `reconcile-credentials` leaves a live credential's tokens alone.
- **Task C, the metadata.** `GET …/metadata` gives every live name its version, `createdAt` and `updatedAt`, and no value. It is PostgreSQL's answer alone: OpenBao gets only the token's own lookup, and no audit row is written. The restore suite now holds a runtime credential and one of its tokens in the lost world.
- **Task D, the record.** D-81; the surfaces sweep for the client secret and the exchanged tokens; the authority matrix unchanged.

## Commits

- `d2fa17b` — `feat(credentials): the runtime credential, issued and revoked in one transaction`.
- `c02ca25` — `feat(machine): a runtime credential is exchanged for a 15-minute token`.
- `feat(machine): metadata — version and times, never a value`.
- `feat(credentials): the verifier is bound to its environment and networks`.
- `docs: D-81, the runtime credential's design and what a hostile API holds` (with this note).

## Findings

1. **A fleet of one environment did not all start (Task B).** With the CLI's five `busy` requests, 8 of 10 instances started. No rate limit refused anything: D-49's read cool-down and the two large-request slots admit about two complete reads of one environment every 1.6 s.
   - **Decision (D-83):** the CLI asks ten times over 13.75 s, from `0.2.0`. The server and D-49 are unchanged.
   - **Then:** 10 of 10, twice, in every run. Alone: one round 7.7 s, two rounds 16.8 s. Beside another suite: two rounds 19.6 s. In the run's last pass (nineteen files, two workers): 22.0 s.
   - **The specification's 20 s is met when the fleet runs alone and was missed once, by 2 s, on a loaded workstation.** It is not guaranteed. The test's own bound is 30 s.
2. **A moved row was exchanged (Task D).** The verifier covered the credential's id only. Whoever held one client secret and could write the database could point its row at another environment and get that environment's token (the test's first run: `200`), or remove its networks.
   - **Fix:** the verifier is made over the kind, organization, project, environment and networks too. A changed row is refused (`401`, no token, no audit row).
   - **What stays:** state and times are columns. A writer of the database who holds a revoked client secret can bring it back, for its own environment and networks. It is a line of `known-limits.md`.
3. **A revoked runtime credential would have left the inventory (Task A).** `credentials.list` and the summary hid every revoked row without an accessor. The filter now names the token kind.
4. **An archive with a runtime credential would never have finished (Task A).** Its drive waited for an accessor that such a row never has. The archive now revokes runtime rows in its own transaction.
5. **A forged `meta` could have listed another environment's names (Task B, found while writing its test).** A token is attributed to a runtime credential only when its policy is exactly that credential's environment role.
6. **Restore needed no change (Task C).** `restore-invalidate` and `restore-verify` work by class, not by kind. The new cases pin it.

## Commands and results

| Command                                                                                                           | Result                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `tests/integration/credentials` and `tests/integration/lifecycle` (Task A)                                        | 13 files, 110 tests passed                                                   |
| `tests/integration/openbao/issuance.test.ts`, "the token of an exchange"                                          | 21 tests passed; the four measurements of D-81                               |
| `credentials/reconcile.test.ts`, the exchanged-token case, before the change                                      | failed as intended: `unrecorded-revoked 4` (the live token was revoked too)  |
| `tests/integration/machine`, `tests/integration/limits`, `credentials/reconcile.test.ts`                          | 14 files: 95 passed, 1 failed (the fleet, finding 1)                         |
| a temporary measurement of the fleet in three shapes (not committed)                                              | `measurements.json`                                                          |
| the fleet with ten requests, and the route walks (`routes-mounted`, `authz`, `reference`, `audit/journey`, more)  | 13 files, 139 tests passed                                                   |
| `machine/metadata.test.ts`, before the route                                                                      | 7 failed as intended (`404`)                                                 |
| `machine/metadata.test.ts`, `api/routes-mounted.test.ts`, `reference/document.test.ts`                            | 3 files, 38 tests passed                                                     |
| `restore/{invalidate,verify,full}.test.ts` with a runtime credential in the lost world                            | 3 files, 22 tests passed                                                     |
| `exchange.test.ts`, the changed-row case, before the binding                                                      | failed as intended: `200` for a row moved to another environment (finding 2) |
| `tests/unit/operations/credential-secret.test.ts`                                                                 | 29 tests passed                                                              |
| `tests/unit/openbao/authority.test.ts`; `git diff main -- packages/openbao infra/openbao docs/evidence/session-2` | 8 tests passed; no difference: the matrix and the policies are byte-equal    |
| `tests/integration/machine`, `tests/integration/credentials`, `limits/machine.test.ts`, after the binding         | 19 files, 154 tests passed (the fleet: 22.0 s, finding 1)                    |
| `restore/full.test.ts`, after the binding                                                                         | 10 tests passed                                                              |
| `pnpm test` (unit)                                                                                                | 143 files, 1630 tests passed (Run 11.4's first unit tests were in the tree)  |
| `pnpm run check`                                                                                                  | green                                                                        |
| CI on the draft pull request (#27)                                                                                | green after `d2fa17b` (45684756102) and `c02ca25` (45689679245)              |

Every integration run was local, with `--maxWorkers=2` (the restore files with 1), one job at a time. The whole suite runs on CI at the freeze (D-58).

## Deviations and decisions

- **The exchange is two parts,** where the plan had one function: the pipeline authenticates the client secret, the handler mints and audits. Every route walk and the stub API need authentication in the pipeline.
- **The miss limit is checked before the bearer's shape,** as on machine routes. A bearer that is not of the client secret's shape costs no read and is not counted.
- **A new denial reason, `source`,** for a request from outside a credential's networks. No address is kept.
- **The credential is read again in the audit transaction.** A revocation during the mint wins: the token is revoked and the answer is `401`.
- **The exchange updates `last_used_at`.**
- **The fleet test asserts all twenty starts within 30 s** and records the time against the specification's 20 s (finding 1).
- **`tests/cli/run.test.ts` follows the CLI's ten requests** in the same commit. It runs in the CLI's container in Run 11.4.
- **Metadata takes the environment's lock and the per-credential slot,** and runs its recheck, the slot check and its one statement in one transaction. It leaves no read cool-down.
- **`createdAt` is the name's earliest `secret.create` event,** and `null` when none is kept: never a guess from the index's own time.
- **"Its exchange answers 401" after a restore is asserted after the gate opens** (`restore/full.test.ts`). Before that every route answers `quarantined`.
- **The provisioner's log is not searched by the surfaces sweep.** The fixture's provisioner stops after setup, and no credential request reaches a provisioner. Both API processes' logs are searched; staging's sweep searches the host's (Run 11.8).
- **The exchange tests were first run after the exchange was written.** Before it the route answered the guard's `404` to everything. The reconcile case, the four OpenBao cases, the metadata cases and the changed-row case were each seen failing first.

## Open issues

- **Run 11.4** gives the CLI's client `exchange`, switches the fleet test to it, releases `0.2.0` and runs `tests/cli` in its container.
- **`cli-v0.1.2`** still asks five times: more than about six instances of one environment started in the same second lose some (`known-limits.md`).
- **The limits suite rewrites `docs/evidence/session-6/run-6.3-starvation.json`.** It was restored before each commit.
- **Not on staging yet.** Everything here is proven on the local stores; staging is Run 11.8.
