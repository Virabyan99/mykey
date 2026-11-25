# Run 11.2 — The contract, the limits and the migration of the two new credentials

**Date:** 25 Nov 2026. **Branch:** `session-11`. P-183, P-185 to P-191. Decisions: D-15's amendment, D-83.

## What was done

- **Task A, the contract.** `ROUTES` has 57 routes (41 before). The sixteen new ones:
  - for a workload: `machine.metadata` (class `machine`) and `machine.exchange` (the new class `machine_exchange`);
  - for the owner: `runtime_credentials.issue`, `automation_credentials.list`, `.issue` and `.revoke`;
  - for an automation credential (the new class `automation`), ten routes under `/v1/automation`. Each names the right it needs.
- **The presented shapes** `mkrc.<id>.<43 characters>` and `mkac.<id>.<43 characters>`, read by `parsePresentedSecret`.
- **Existing answers gain fields only:** a project's `managedBy`; a credential's `kind`, `issuedByKind` and `boundCidrs`. The bodies of `machine.keys` and `machine.resolve` are equal byte for byte to the ones before the run (`tests/unit/contracts/machine-bodies.snapshot.json`).
- **Limits** (D-83): the lifetimes and CIDR counts of both credentials, 10 exchanges a minute per credential, 120 requests a minute per automation credential. Runbook `limits.md` has the table.
- **Audit:** three actions (`machine.exchange`, `automation_credential.issue`, `automation_credential.revoke`), and a coverage entry for each of the sixteen routes.
- **Task B, the schema.** Migration `0019_automation_and_runtime`:
  - the table `app.automation_credential`;
  - five columns on `app.machine_credential` (`kind`, `verifier`, `verifier_key_id`, `bound_cidrs`, `issued_by_kind`), all with defaults or nullable;
  - `app.project.managed_by`;
  - the actor kind `machine` on `app.secret_version_event`;
  - by hand: the grants of the new table and its `capture_barrier` trigger.
- **No route of the two new classes answers yet.** This build cannot authenticate them, so `apps/api/src/pipeline/route.ts` ends each in the terminal 404 for every caller. Run 11.3 replaces that for `machine_exchange`, Run 11.5 for `automation`.

## Commits

- `ca6cce0` — `contract: automation and runtime credentials, exchange and metadata (41 → 57 routes)` (62 files).
- This note's commit.

## Commands and results

| Command                                                                                            | Result                                                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `vitest --project integration tests/integration/database`, before the grants                       | 9 failed, as intended (red)                                               |
| `pnpm exec vitest run --project unit`                                                              | 142 files, 1598 tests passed                                              |
| a batch of 34 integration files that walk `ROUTES` or read credential and project rows (first run) | 10 files failed (below); 24 passed                                        |
| those 10, with `api/routes-mounted` and `authz/revocation`, after the changes                      | 12 files, 126 tests passed                                                |
| `tests/integration/audit`, `metrics/metrics.test.ts`, `tests/integration/database`                 | 12 files, 178 tests; 1 failed (`audit/journey`), then 7 of 7 after change |
| `tests/integration/deploy`, `restore/full.test.ts`, `tests/fault/restore/interrupted.test.ts`      | 7 files, 27 tests passed                                                  |
| `pnpm run check`                                                                                   | green                                                                     |
| CI on the draft pull request (#27), after the push                                                 | green: `check` and `secret-scan` (run 45680697758)                        |

Every integration run was local, with `--maxWorkers=2`, one job at a time. The whole suite runs on CI at the freeze (D-58).

**The ten files that failed first, and why.** None showed a defect in the product except the first:

- `capture/barrier`: **a finding.** A new table of `app` had no `capture_barrier` trigger, so a write to it during a capture would not have been refused. The trigger is now in `0019`.
- `credentials/inventory`: the three new fields of the view.
- `authz/matrix`, `authz/revocation`, `auth/factors-http`, `auth/fresh`, `reference/document`: their tables of valid requests had no entry for the new routes.
- `authz/origin`, `browser-security/origin`, `isolation/cursors`, `limits/capacity`: they count or walk routes by class or by name.
- `audit/journey`: an audit action must have a writer; the three new ones get theirs in Runs 11.3 and 11.5.
- `tests/unit/release/host-build.test.ts` and five integration or harness files name the newest migration.

## Deviations and decisions

- **A route of the two new classes answers 404 to everyone**, where the plan says such a route "passes every check of the pipeline" without a handler. Passing the checks would run validation, the capture rule and the capacity rule for a caller nobody has identified.
- **A member calling `automation_credentials.*` gets 403 `action_denied`**, as on `credentials.summary`, not the 404 in the plan's Run 11.5 text. A second concealment rule for one route family is not added.
- **Audit details keep the rights as three booleans**, and the right `secrets.create` under the key `keysCreate`: details hold no arrays, and `tests/unit/audit/scope.test.ts` refuses a key that contains "secret".
- **`machine.exchange`'s details** are `{credentialId, ttlSeconds}`; the plan had `{credentialId}`.
- **`tests/unit/contracts/no-destroy.test.ts` excepts `machine.metadata` by id** and asserts that it is a GET with no body and no query. The test refuses the word "metadata" in a route id.
- **On `automation_credentials.issue`, a `replaces` that names no credential answers `not_found`.** No new code.
- **`packages/db/src/repos/automation.ts` is not written in this run.** Nothing reads it before Run 11.5, which writes it test first.
- **The database says `issued_by_kind` is `user` or `machine`; the API's view says `user` or `automation`.** One mapping, in `credentialView`.
- **`auth/fresh.test.ts`:** the routes that need a fresh second factor are now the four of FR-1.77 and the two new issuances (Doc 10 §4.1 rule 6).
- **`authz/origin.test.ts`:** the Origin rule covers every non-GET route that a browser session can send. The two new classes present a bearer, as `machine` does, and are outside it (D-15's amendment).

## Open issues

- **Tests that hold "this build cannot authenticate" until a later run.** Each names its run in a comment:
  - Run 11.3: the guard in `route.ts` for `machine_exchange`; `machine.exchange` in `audit/journey.test.ts`'s `PENDING_WRITERS`; the stub lists of `auth/fresh` and `auth/factors-http` for `runtime_credentials.issue`.
  - Run 11.5: the guard for `automation`; `unauthenticatedClass` in `authz/requests.ts` and `reference/document.test.ts`; the 404 expectations in `api/routes-mounted`, `authz/matrix`, `capture/barrier` and `limits/capacity`; `OWED` in `isolation/cursors`; `NO_HANDLER` in `browser-security/origin`; the other two `PENDING_WRITERS`.
- **The two new rate limits are numbers only.** They are enforced from Runs 11.3 and 11.5 (`limits.md` says so).
- **A write to `app.automation_credential` during a capture raises `MKC01`.** `last_used_at` must be handled as the machine path handles it (Run 11.5).
- `docs/evidence/session-4/authorization-matrix.md` was regenerated by `authz/matrix.test.ts`: 1036 cells (924 before), no mismatch.
