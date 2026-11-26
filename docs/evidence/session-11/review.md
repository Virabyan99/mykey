# Session 11 — the fresh-context review, and what was done with it

**Date:** 26 Nov 2026 (Run 11.8, the freeze). **Reviewer:** one fresh agent, Claude Fable 5.2, read-only.

**What it got:** `git diff 472cda42a52c..87d7871` without `docs/plans` and `docs/evidence`, the specification (`docs/mykey-automation-credential-spec.md`), `docs/runbooks/known-limits.md`, Doc 10 §4.1, and the six questions of the plan. It did not get the plan or the run notes.

**Result:** no Critical, no High, one Medium, seven Low. The Medium and three Lows are fixed test-first. Four Lows are lines of `known-limits.md`. The answer is in "What was done" at the end.

The report below is as it came. One line was changed: it named the workstation's path to the repository, which is now "the repository's root".

---

# Review of `session-11` (`472cda42a52c..HEAD`), security and correctness

Read-only review of the code and tests; nothing was run, so every conclusion is from reading. `docs/plans/` and `docs/evidence/` were not opened. No Critical or High finding.

All paths are under the repository's root.

## Findings

### Medium

**M1. A revoked, expired or out-of-network credential is never counted by any limit except the source limit, and each request writes an audit row.**

- Where: `apps/api/src/pipeline/route.ts:130-154` (`underMissLimit` counts only `MISSED_LOOKUP`), `route.ts:364-388` (`rl:exchange` / `rl:automation` are hit only after authentication succeeded), `apps/api/src/pipeline/exchange.ts:105-108`, `apps/api/src/pipeline/automation.ts:141-152`.
- What is wrong: the verifier of a dead row still matches, so the request is "attributable". It is neither a miss (30 a minute per source) nor a request of the credential (10 or 120 a minute). It costs one read, one HMAC and one committed `access.denied` row, bounded only by `rl:source` (300 a minute per source). A revoked 30-day token fails `lookup-self`, counts as a miss and writes no audit row.
- Scenario: a client secret leaks and the owner revokes it. The party holding it sends 300 requests a minute from each of N addresses to `POST /v1/machine/exchange`, for ever. Every one answers 401 and inserts an audit row, about 432,000 rows a day per address. The host's capacity record then turns expanding routes into 507. Revocation, the owner's only remedy, does not end it.
- Second consequence: 31 requests in a minute tell a once-real secret from a made-up one. The made-up one meets 429 on the 31st; the dead one answers 401 for ever. The same applies to a secret presented from outside its network.
- Sure: CONFIRMED by reading the path end to end. The disk consequence is arithmetic, not measured.

### Low

**L1. The automation admission recheck reads the credential without a lock.**

- Where: `apps/api/src/pipeline/automation.ts:283-296`, `packages/db/src/repos/automation.ts:299-313` (`automationCredentialNow` is `findAutomationForAuth`, no `FOR SHARE`).
- What is wrong: the comment at `automation.ts:271-277` says a credential revoked since the pipeline looked "refuses the change in its own transaction". That holds only when the revocation committed before this read. The two sibling paths lock: `apps/api/src/routes/machine.ts:38-42` and the exchange's transaction use `FOR SHARE`.
- Scenario: `automation.runtime_credentials.issue` passes the recheck. `automation_credentials.revoke` then takes `FOR UPDATE` (`repos/automation.ts:187`), commits and answers 200. The issuance commits afterwards. The owner holds a 200 for the revocation and a runtime credential issued after it, which nothing stops (known-limits line 87).
- Test gap: `tests/integration/automation/provisioning.test.ts:525-558` covers only a revocation that lands before the recheck.
- Sure: CONFIRMED by reading. The window is one transaction.

**L2. Revoking the new kinds is not exempt from the limits, though `credentials.revoke` is.**

- Where: `apps/api/src/pipeline/rate.ts:72-76` (`SESSION_EXEMPT` lacks `automation_credentials.revoke`), `route.ts:386-388` (`automation.runtime_credentials.revoke` is counted under `rl:automation`).
- Scenario: an owner whose session already made 120 requests in the minute gets 429 on revoking a leaked automation credential. A script that used its 120 requests cannot revoke a runtime credential until the window ends.
- Sure: CONFIRMED.

**L3. Nothing bounds what one automation credential makes except 120 requests a minute.**

- Where: `rate.ts:54-66` (`rl:issue`, 5 a minute, covers the three human issuances only), `packages/contracts/src/capacity.ts:67-73`, `packages/contracts/src/limits.ts` (no count of projects or credentials per organization).
- Scenario: a leaked secret with `projects.create`, or a script in a loop, makes up to 120 projects a minute. Each has a `development` environment the provisioner must set up, and projects cannot be deleted. With `runtime_credentials.manage` it issues 120 runtime credentials a minute where a person may issue 5.
- Not in `known-limits.md` or `limits.md`.
- Sure: CONFIRMED for the missing limits; PLAUSIBLE for the effect on the provisioner's queue, which was not traced.

**L4. `machine.metadata` returns every live name with no audit row, while `machine.keys` audits the same names.**

- Where: `packages/audit/src/coverage.ts:64-67`, `apps/api/src/routes/machine.ts:110-134`; asserted by `tests/integration/machine/metadata.test.ts:263-278`.
- What is wrong: a token holder who wants the names unrecorded asks `metadata` instead of `keys`. It is a recorded decision in the coverage table, but no line of `known-limits.md` says it. Doc 10 §4.1 rule 8 is the rule it touches; whether names are "sensitive" is the owner's call.
- Sure: CONFIRMED.

**L5. `automation.projects.create` tells its caller that a project name exists outside its chain.**

- Where: `apps/api/src/routes/resources.ts:158` (`name_taken` → `409 already_exists`), uniqueness per organization.
- Scenario: a credential with `projects.create` learns that the owner, or another chain, has a project of that name. Every wrong guess makes a project.
- The spec's row A1 says "`already_exists` as today", so this is as specified. It is reported because it is on the brief's list ("exists" against "not yours").
- Sure: CONFIRMED by reading; the cross-chain case has no test.

**L6. Two address cases have no test and depend on behaviour outside this repository.**

- Where: `packages/operations/src/credentials/secret.ts:129-171`, `apps/api/src/pipeline/source.ts:15-28`.
- (i) An IPv4-mapped IPv6 network (for example `::ffff:10.0.0.0/104`) is accepted at issue as an IPv6 network. The source is normalised to IPv4 before `BlockList.check`, so the match depends on Node's mixed-family rule. At worst the credential never works (fails closed).
- (ii) A multi-valued `X-Forwarded-For` falls back to the edge's own address, 10.78.1.2. This is safe only while Traefik replaces a client's header, which is its default; no `forwardedHeaders` setting exists under `infra/`. If the edge ever appended, every such caller would read as 10.78.1.2 and match a credential bound to a network containing it. Known-limits line 70 covers the principle, not this case.
- Sure: PLAUSIBLE, not executed.

**L7. One log search's control is vacuous.**

- Where: `tests/integration/automation/provisioning.test.ts:659-663`.
- What is wrong: `expect(lines.includes(made.projectId) || lines.length > 0).toBe(true)` is true for any non-empty log. It does not show the log saw the run's requests. `tests/integration/automation/issue.test.ts:276-278` does it properly, by request id.
- Sure: CONFIRMED.

## The six questions

**(a) Can a client secret, an automation secret or an exchanged token reach a forbidden surface? No path found.**

- Database: only a 32-byte HMAC and its key id are stored (`secret.ts:66-85`, `packages/db/migrations/0019_automation_and_runtime.sql`). The API role cannot update `verifier`, `kind`, `bound_cidrs`, `rights`, `owner_id` or `managed_by` (`tests/integration/database/privileges.test.ts`, the Session 11 cases).
- Operation `result` and `expected`: `{credentialId}` only (`packages/operations/src/credentials/runtime.ts`, `automation.ts`). An exchange makes no operation.
- Audit `details`: ids, lengths, counts and booleans (`packages/audit/src/events.ts`); the exchange row is `{credentialId, ttlSeconds}`.
- Logs: refusals log `cause` only (`exchange.ts:62-66`, `automation.ts:115-119`).
- Error bodies: text comes from a table by code and `ApiError.reason` is never sent (`apps/api/src/pipeline/respond.ts`). The replay answer `credential_not_replayable` carries `{credentialId, state}`.
- URL: the bearer is a header in the server and the CLI (`apps/cli/src/client.ts`); the exchange has no body or query.
- `cache-control: no-store` is on every JSON answer, and asserted for the three issuances and the exchange.
- Browser: both issue routes are in `SECRET_BEARING`, sent by `callSecret`, held in `useEphemeral`. `apps/web/src` has no storage call and one `setQueryData`, for the session (`apps/web/src/api/query.ts:49`).
- Tests with controls: `tests/integration/credentials/runtime.test.ts:147-220`, `issue.test.ts:230-280`, `provisioning.test.ts:636-657`, `tests/browser/automation.test.ts:173-183` and `276-285`.
- Not shown by any test: the exchanged token's absence from the API log.

**(b) Can an automation credential read a value, or reach a project its chain does not manage? Can it be widened? No.**

- Values: no automation route has a value in a response schema (`tests/unit/contracts/routes.test.ts`, with the reveal as control). `automation.secrets.list` returns five fields (`provisioning.test.ts:222-247`). The two-step read through `runtime_credentials.manage` is known-limits line 86, which states the code correctly.
- Other projects: `authorizeAutomation` resolves the path through `managed_by = owner` before the right is looked at, with one 404 (`automation.ts:236-245`). Lists filter by chain. The automation revoke answers 404 for a 30-day token's id (`provisioning.test.ts:479-488`).
- Replay: the key includes the credential's id, and the lookup comes after the path and right check (`route.ts:407-468`). A replayed issuance never shows the secret (`provisioning.test.ts:504-520`).
- Operation id: only an operation whose principal is a machine of the caller's chain (`automation.ts:216-231`). Denials and a control are at `provisioning.test.ts:284-333`.
- Timing of a revocation: see L1. A `managed_by` change cannot race, because the project is locked `FOR SHARE` and the API role cannot write the column.
- Widening: rights, networks and chain are inside the verifier (`automation.ts:137-140`) and not updatable by the API role. `replaces` needs an owner or admin with fresh TOTP. Both roles already have every right in the organization (`packages/contracts/src/authz.ts:54`), so joining a chain gives them nothing new.

**(c) Can a token be attributed to the wrong credential through `meta`? Can a token cross environments or outlive a revocation in the product? No.**

- Only the issuer identity can set `meta`. A machine token's sole policy is `machine-env-<eid>` (asserted at `tests/integration/machine/exchange.test.ts:219-226`), and `packages/openbao` and the policy files are unchanged in this diff.
- A 30-day token's meta is `{credential_id, operation_id}` (`packages/operations/src/credentials/issue.ts:366`), never `exchange`, so it is always looked up by accessor.
- An exchanged token is accepted only if its policy equals the named row's environment (`apps/api/src/pipeline/machine.ts:186-233`). The forged cross-environment case answers 401 on both paths, with a control (`exchange.test.ts:432-465`).
- A forged token naming another runtime credential of the same environment would read the same values, under that credential's name, networks and revocation. It needs issuer power, which already has everything.
- Cross-environment: `exchange.test.ts:405-430`.
- Revocation: the next exchange and the already minted token answer 401 at once (`exchange.test.ts:371-391`). In OpenBao the token lives up to 15 minutes, which known-limits line 64 states accurately.
- After a restore both kinds and their exchanged tokens are refused (`tests/integration/automation/recovery.test.ts:116-136`).

**(d) Is an existing assertion weaker than before? Are the two machine bodies and the token block unchanged? None weaker found; both unchanged.**

- Changed expectations that follow behaviour: 41 → 57 routes, seven → eight routes without an idempotency key, 15 → 16 tables, `0018` → `0019`, seventeen → eighteen screens.
- `tests/cli/run.test.ts`: the CLI's `busy` retries went from 5 to 10. This is a behaviour change with its assertion moved, not a weakening.
- `tests/harness/credentials-fixture.ts:216-221`: the catalogue side of `expectCatalogMatchesBackend` gained `AND kind = 'token'`. The OpenBao side is unchanged, so a leftover exchanged token still fails the count.
- `tests/unit/contracts/no-destroy.test.ts` exempts `machine.metadata` by id, with an added assertion that it is a GET without a body.
- `tests/unit/runbooks/token-step.test.ts` now also strips the automation step before comparing surfaces.
- `machine.keys` and `machine.resolve`: `keysBody`, `resolveBody` and the `MACHINE` error list are identical to the base (`git show 472cda42a52c:packages/contracts/src/routes.ts` against HEAD). The snapshot file is new in this change, so it proves nothing by itself.
- Token block: the `bash -c` block is in no hunk of the four runbook diffs. The CLI version in them moved to `cli-v0.2.0`.
- Not compared: `tests/harness/kept.ts` against the `IN_PAGE` block it replaced, and the added parts of `tests/unit/web/copy.test.ts` and `claims.test.ts`.

**(e) Does any path still treat a row without an accessor as an unfinished issuance? No.**
All six places that test the accessor for null were read:

- `packages/db/src/repos/credentials.ts:314` and `credentials-summary.ts:41` are limited to `kind = 'token'`.
- `packages/operations/src/credentials/revoke.ts:190` refuses a non-token before the accessor check at 201.
- `packages/operations/src/lifecycle/archive.ts:349` sees only `revoking` rows; `closeCredentials` sends runtime rows straight to `revoked` (`packages/db/src/repos/lifecycle.ts:93-98`).
- `packages/operations/src/lifecycle/reactivate.ts:167` skips a null accessor after requiring `revoked`.
- `packages/operations/src/reconcile/credentials.ts:174` acts only on `revoking`.
- Issuance blocking keys on `issuing` and `needs_review`, and a runtime row is `active` from insert.
- The restore updates by state alone (`apps/ops/src/commands/restore-invalidate.ts:56-68`).
- Tests: `tests/integration/credentials/runtime-everywhere.test.ts:152-207`.

**(f) Is every denial paired with a success, and every "not found" search with a control? Mostly; five exceptions.**

- `provisioning.test.ts:659-663`: the vacuous control (L7).
- `tests/integration/automation/boundary.test.ts:172`: the log search for the automation prefix has no control.
- `boundary.test.ts:196`: the search of one audit row for `127.0.0.1` has no control showing an address would be found. `exchange.test.ts:329-336` has the same shape; its rows are at least shown to exist.
- `tests/cli/exchange.test.ts:234-246`: the child's environment is searched for three digests with no control in that test (line 116 of the same file shows digests are findable).
- `tests/integration/limits/machine.test.ts:215-223`: the title says "costs no read", but only "not counted" is asserted.
- Paired correctly: the refused bearers (`exchange.test.ts:241-274`), state and source refusals (`297-339`), the forged meta (`432-465`), the audit outage (`579-599`), the moved row (`623-692`), both miss limits and both per-credential limits (`limits/machine.test.ts:184-319`), the operations boundary, and the metadata value search (`metadata.test.ts:171-200`).

## Not reviewed

- `docs/plans/` and `docs/evidence/`, as instructed.
- Anything executed: no test, build, CI run or host.
- The uncommitted change in `apps/web/src/screens/project.tsx` and the untracked `docs/evidence/session-11/claims.md`.
- Whether release `cli-v0.2.0`, which the runbooks now download, exists.
- Traefik's forwarded-header behaviour on the hosts, and Node's `BlockList` for mapped networks (L6).
- The workspace's copy and help text for truth, and `apps/web/src/connect/runbooks.ts` except through the Markdown runbooks.
- `docs/runbooks/automation.md` and the `restore.md` diff, beyond searches.
- `tests/harness/kept.ts`, `tests/harness/automation.ts`, `tests/cli/server.ts`, and the new parts of `surfaces.test.ts`, `reconcile.test.ts` and `restore/full.test.ts`, line by line.
- The person's own admission recheck, which is outside this diff, for the pattern of L1.

---

## What was done

Severities are the reviewer's, except L1: it was raised, because a revocation that answered must stop its credential.

| Finding                  | Done                                           | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M1**                   | **Fixed**                                      | A credential that is revoked, expired or called from outside its networks is now a miss of its source, as a secret nobody can attribute is (`countsAsMiss` in `apps/api/src/pipeline/route.ts`). The 31st such refusal of a source in a minute is `429` before the database is read, and writes no audit row. A dead secret and a made-up one now meet the same answer. Three tests in `tests/integration/limits/machine.test.ts`, each seen failing first: the exchange, a token of an exchange, an automation credential. **What is left** is a line of `known-limits.md`: the rule bounds one source, so a dead secret sent from many addresses still writes 30 rows a minute for each. |
| **L1**                   | **Fixed**                                      | The recheck reads the credential `FOR KEY SHARE` (`automationCredentialNow`). A revocation, which locks the row `FOR UPDATE`, waits for a change that already looked; a change waits for a revocation that holds the row and then reads `revoked`. Test: `provisioning.test.ts`, "a revocation that holds the row while the change rechecks is waited for", seen failing first (the change answered 201 while the revocation held the row).                                                                                                                                                                                                                                                |
| **L2**                   | **Fixed for the owner; a line for the script** | `automation_credentials.revoke` is in `SESSION_EXEMPT`, as `credentials.revoke` is (`tests/unit/api/rate.test.ts`, `tests/integration/limits/rate.test.ts`, seen failing first). The script's own revoke route stays under its credential's 120 a minute: a line of `known-limits.md`.                                                                                                                                                                                                                                                                                                                                                                                                     |
| **L3**                   | Line                                           | `known-limits.md`, "Nothing bounds what one automation credential makes except its 120 requests a minute." No limit was added: the networks, the lifetime and the inventory are the controls, and a count per organization is a design question for the owner.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **L4**                   | Line                                           | `known-limits.md`, "`machine.metadata` writes no audit row." The decision is in `AUDIT_COVERAGE`; whether names are sensitive enough to audit is asked of the owner in the report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **L5**                   | Line                                           | `known-limits.md`. As specified (the spec's row A1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **L6**                   | Line                                           | `known-limits.md`, both cases. The first was not run. The second is shown for today's edge by `tests/staging/transport.staging.test.ts` ("ignores forwarded headers sent by the client"), which Run 11.8 ran on both hosts: the reviewer did not have that file's result.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **L7**                   | **Fixed**                                      | The control is now a request id of the chain's own request, found in the log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| (a), last line           | No change                                      | `tests/integration/credentials/surfaces.test.ts` searches two exchanged tokens in both API processes' logs, with the exchange's request as its control. The reviewer did not read that file line by line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| (f), the four other gaps | **Deferred**                                   | Minor: a missing control in `boundary.test.ts:172` and `:196`, in `tests/cli/exchange.test.ts:234`, and a title that says more than `limits/machine.test.ts:215` asserts. They are listed in the report for the owner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

After the fixes: the three changed files' suites, then `tests/integration/machine`, `automation` and `credentials` locally, then the full CI on the pull request (`run-11.8.md`).
