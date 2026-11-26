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

---

# The second review: test code changed after the freeze (Run 11.8)

**Date:** 26 Nov 2026. **Reviewer:** one fresh agent, Claude Fable 5.2, read-only (git and file reads; it ran nothing).

**What it got:** `git diff 5e13f42..HEAD -- . ':!docs'` at `0770d9a` (the staging tests, their harness, `scripts/sweep-ci.ts` and its unit test, `tools/agent-runner`), the project's rules for secrets, controls and cleanup, and seven questions. It did not get the plan, the run notes or any conclusion.

**Result:** no Critical, no High, four Medium, eight Low. The four Mediums and two Lows are fixed; the five changed staging files ran again and are green. The answer is in "What was done with the second review" at the end.

The report below is as it came. Two things were changed: it named the workstation's path to the repository, which is now `ROOT`, and its closing list of files with that path is left out.

---

## Review of `git diff 5e13f42..HEAD -- . ':!docs'` (branch session-11)

Read-only: git and file reads only. Nothing was run, so every finding below is from reading the code and the committed evidence.

`ROOT` is the repository's root.

**Verdict:** no Critical and no High. No secret and no caller address is in the committed tree, and I found no path in the changed lines that prints one. There are four Medium findings: one test that is green both ways, a leak counter with two blind spots, searches without a needle control, and cleanup gaps on failure paths. Both "stale test" fixes (transport, deploy) describe the product correctly.

### Critical

None.

### High

None.

### Medium

#### M1. `cli.staging` test 2 takes its expectation from the CLI under test, so it is green both ways

- **Where:** `ROOT\tests\staging\cli.staging.test.ts:244-258` (branch on `cliVersion`), `:39-42` (evidence path), `ROOT\tests\harness\cli-linux.ts:14`.
- **What is wrong:** `exchanges` is computed from what `secrets --version` prints. The test then asserts exit 0 or exit 77 accordingly. Nothing says which outcome the run was meant to prove.
- **Failure scenario:** `MYKEY_CLI_DIST` is left set to the unpacked `cli-v0.1.2` after the no-regression run. The next plain run of `cli.staging` is "2 of 2" having asserted that the CLI does not start with a client secret. The only tell is `exchanges: false` in a different evidence file.
- **Related, same cause:**
  - Every released run writes `docs/evidence/session-11/staging-cli-released.json`, whatever the version. A 0.2.0 released run and the 0.1.2 run overwrite each other. The committed file holds only 0.1.2.
  - The tree-build run writes Session 5's file, which was restored. So no committed evidence from this file shows 0.2.0 starting with a client secret; `automation.staging` is what carries that claim.
  - `automation.staging.test.ts:175-176` always builds the tree's CLI, but `runCliInLinux` runs whatever `MYKEY_CLI_DIST` names, and its evidence records no CLI version. An old CLI fails loudly there; a different 0.2.0 bundle passes unrecorded.
- **Smallest fix:**
  - When not `RELEASED`: `expect(cliVersion).toBe(<apps/cli/package.json version>)` and `expect(exchanges).toBe(true)`.
  - When `RELEASED`: require an expected version (for example `MYKEY_CLI_EXPECT=0.1.2`), assert it, and put the version in the evidence file name.
  - In `automation.staging`, refuse to start when `MYKEY_CLI_DIST` is set, or record `--version`.

#### M2. `sweep-ci.ts`: the new pattern misses two realistic leak forms

- **Where:** `ROOT\scripts\sweep-ci.ts:17-18`.
- **The shape itself is right.** It agrees with `ROOT\packages\contracts\src\automation.ts:23` (prefix, lowercase UUID, 43 base64url characters), for both prefixes. The exchanged token is an OpenBao token and falls under the existing `hv[sbr].` rule.
- **Miss (a), the leading `\b`:** there is no word boundary when the character before `mkrc` is a word character. An ANSI colour code ends in `m`, so `ESC[31m` directly followed by `mkrc.…` is not counted. CI logs downloaded with `gh` keep colour codes. The pre-existing `\bhv[sbr]\.` has the same hole.
- **Miss (b), the exact `{43}`:** a truncated secret is not counted. The repository's own tests print `answer.body.slice(0, 200)` of issuance answers (`token-sweep.staging.test.ts:93`, `cli.staging.test.ts:147`), which can cut through the secret. The older token rule tolerates this with `{20,}`.
- **Over-count:** none that matters. The prefix plus UUID makes a non-secret match negligible; a synthetic secret of a CI stack is counted, which is the intended policy.
- **The unit test** (`ROOT\tests\unit\registry\sweep-ci.test.ts:45-58`) is a real control for the plain case: both prefixes are generated at run time with the product's lengths, plus a negative for the prefix and a placeholder. It covers neither miss, and it builds the sample by hand instead of checking it with `parsePresentedSecret`, so a later change of the product's shape would not turn it red.
- **Smallest fix:**
  - In `countFindings`, strip SGR sequences before matching (this also fixes the `hv` rule).
  - Drop `\b` from `PRESENTED` and use `{20,}`.
  - Add two unit cases (colour code directly before the secret; a secret cut to 30 characters) and one `expect(parsePresentedSecret(sample)).not.toBeNull()`.

#### M3. The three searches for the new shapes have no needle control

- **Where:** `ROOT\tests\staging\runtime-credential.staging.test.ts:360`, `ROOT\tests\staging\automation.staging.test.ts:439`, `ROOT\tests\staging\token-sweep.staging.test.ts:237`.
- **What is wrong:** all three call `countOnHost` with argument controls only. The harness says itself (`ROOT\tests\harness\staging.ts:285-286`) that only a needle control "proves the needles arrived as patterns, not only that the producer ran". Only `sweep.staging` passes one.
- **Failure scenario:** the needles do not reach grep (stdin lost through `sudo sh -c`, or a later change to `searchScript`). The pattern file is then one empty line, the argument controls are still found, and the result is "0 found, controls n of n". That is exactly what S11-13 reads as proof.
- **Mitigation:** `sweep.staging` proved the same harness path with needle controls in the same pass (10 of 10). Downgrade to Low if you accept that as covering these files.
- **Smallest fix:** pass one non-secret string known to be on each surface as the fifth argument. For example, a credential id for `pg_dump`, an exchange's request id for the API log and the audit device, and the marker path for the edge log.

#### M4. State left on staging on failure paths

- **`automation.staging.test.ts:228-237`:** if `provision()` throws after its first step, the tenant project exists but is added to `projects` only after `provision` returns. The 25-secret step is the likely place for a throw. The project is never archived, and nothing else archives it. Fix: wrap in `try/catch`; on failure, `GET /v1/automation/projects` with `auto.secret`, add every id to `projects`, and rethrow. The same applies to credentials issued by a `reissue()` that throws midway (`:346-351`).
- **`automation.staging.test.ts:121-132`:** `automationIssued.add` comes after four `expect`s. If the `cache-control` or shape assertion fails, an automation credential with all three rights and a one-hour life is never revoked. Fix: add the id to the set right after the 201 is parsed. The same order is in `runtime-credential.staging.test.ts:102-116`, where it is harmless only because the project's archive revokes its credentials.
- **`token-sweep.staging.test.ts:153-178`:** `expect` sits inside the `finally` loops. The first failed revocation skips every later one, including the new runtime and automation credentials (one hour each). This project is never archived, so nothing else revokes them. Fix: collect the statuses, revoke everything, then assert.
- **`cli.staging.test.ts:63-71, 265-267`:** `revokeAll()` never asserts that `issued` is empty. A failed revocation of the new unbound runtime credential (one hour) is silent. Fix: `expect(issued.size).toBe(0)` after it.

The two new files' `afterAll` hooks are otherwise sound: they revoke all, archive, record, then assert.

### Low

- **L1. `deploy.staging.test.ts:165` — stale title.** It still says "host-v0.6.0, back to host-v0.5.9 … each ends open; quarantined while closed". In the downgrade branch the middle step is a refusal, so a reader of "1 of 1" under that title reads a rollback that did not happen. Fix: build the title from the release directories and `downgrade`. Two small tightenings in the branch (`:177-193`):
  - `expect(samples.length).toBeGreaterThan(0)` before the "nothing quarantined" check, so it cannot pass on an empty poll.
  - Compare `reportSha256` with the one from step 1, so "the gate never closed" is shown by an unchanged record.
- **L2. `token-sweep.staging.test.ts:88-141` — no spare issuance budget.** It now issues five credentials in a row. All three kinds share `rl:issue`, five a minute (`apps/api/src/pipeline/rate.ts:61-64`). There is no `nextMinute()`, so one issuance by the previous file in the same clock minute makes the file red. Fix: `await nextMinute()` before the `try`.
- **L3. `transport.staging.test.ts:108-128` — prints the owner's address on failure (pre-existing lines, changed file).** `wg show wg0 endpoints` comes back without `secretOutput`, and `toMatchObject({ forwardedFor: workstation[0] })` prints the address if the assertion fails. That contradicts the rule `callerNetwork` keeps. Fix: `registerSecret` it and compare as a boolean.
- **L4. `tools/agent-runner/prepare.ts:27-39` — a stale build context passes.** Files are downloaded only if missing, and only the names in the `SHA256SUMS` on disk are checked. A context left from `cli-v0.1.2` keeps the old `install.sh` and sums, never checks the new archive, and the Dockerfile's `--ignore-missing` (`Dockerfile:15`) then installs 0.1.2 under a 0.2.0 label. On this workstation the directory holds only the Node archive, so it is not live here. Fix: fail unless `SHA256SUMS` lists the archive named in `FILES`.
- **L5. `cli-linux.ts:14` and `cli.staging.test.ts:39` disagree on an empty variable.** `??` keeps `""` while the test treats `""` as unset. `MYKEY_CLI_DIST=` gives a confusing Docker mount error, and a wrong directory is not checked. It fails loudly, not silently. Fix: export one `cliDist()` from the harness that treats `""` as unset and checks `secrets.mjs` exists.
- **L6. The two new files search five surfaces, not six.** There is no PostgreSQL log (`runtime-credential…:332-356`, `automation…:412-435`). `acceptance.md` S11-13 says they search "the same way" as `token-sweep`. Add the surface or correct the sentence.
- **L7. `tests/consumers/runbook.test.ts` — the changed deploy half has never been green.** `run-11.8.md` says so. Two more points for when it reruns:
  - It still writes Session 5's evidence file (`:67`) and records neither the credential kind nor the CLI version.
  - The search covers the whole client secret only (`:489`), not its secret part.
- **L8. The fleet's 20 s is recorded, not asserted, and is read two ways.** The test's bound is 60 s (`runtime-credential…:315`). The evidence field `firstRoundWithinSpec20s` compares the first round (`:322`), while `acceptance.md` S11-8 compares both rounds (19.7 s). The acceptance text is honest about the bound; pick one reading.

### Answers to the seven questions

1. **Asserts less than its title, or vacuous:** M1 (green both ways), M3 (controls do not cover needle delivery), L1 (stale title).
2. **Weakened assertions:** none.
   - **Transport:** production is open and in service, so 200 "up" is the correct fixed expectation. It still fails if production goes down. It does make this staging file red while production is closed for a `--stay-closed` deploy.
   - **Deploy:** the refusal is the product's behaviour (`ROOT\scripts\host-deploy.ts:42-45`, `ROOT\scripts\host.ts:3491-3493`, `deploy.md` "Rollback", `known-limits.md:143`). The branch catches both regressions: a downgrade that is no longer refused fails on the exit code and the message, and a same-schema rollback wrongly refused fails `toBe(0)`. What it no longer shows is a rollback on staging for this release pair.
3. **Secrets or the address reaching evidence, messages, output, argv or the tree:** no finding in the changed lines; L3 is the one pre-existing path.
   - `callerNetwork` returns the address under `secretOutput`, puts only the marker in the command, and throws a generic error.
   - No `expect` message, thrown error or `record` holds the address or a secret; `ProvisionerError` carries step, status and code only.
   - Needles cross on stdin; only ids, paths and request ids are on command lines.
   - Scanning the added lines of the whole diff (docs included) for the three shapes, canaries and addresses found only `192.0.2.0/24`.
4. **Undo on failure paths:** M4.
5. **`sweep-ci`:** M2.
6. **`MYKEY_CLI_DIST`:** M1 and L5.
7. **Anything else:** L1, L4, L6, L7, L8.

### Checked and found sound

- **`callerNetwork`** (`ROOT\tests\harness\staging-machine.ts:45-64`): the address is validated with `net.isIP` and registered; no caller prints or records it.
- **Committed evidence** (`staging-automation.json`, `staging-runtime-credential.json`, `staging-cli-released.json`, `token-sweep.txt`): ids, counts and times only. The counts match the code (48, 14 and 9 values).
- **Boundary denials each have a control in the same run:** another network against a served bound credential; a foreign project against an absent one and an owned one; 403 without the right against 201 with it; a revoked credential against a survivor.
- **Empty or short needles** cannot make a search match everything: `countOnHost` refuses needles under 8 bytes.
- **Rate windows:** the fleet takes `nextMinute()` before each batch of five issuances and before the timed start.
- **`runbook.test.ts`:** the diff removed a body slice from an `expect` message, which is an improvement, and asserts `credential.kind`.
- **`machineRequest`:** the method change is equivalent for `keys` and `resolve`; `metadata` is a GET.

### Not reviewed

- Product code frozen at `5e13f42`, including whether credential listings or audit rows expose a bound network that another test's evidence writer could capture.
- `tests/fixtures/automation/tenant-provisioner.ts` beyond its error messages and step tracking (not in the diff).
- Actual grep behaviour of `searchScript` with an empty pattern file: nothing was executed, so M3 rests on the harness's own comment.
- `docs/` changes, beyond reading `run-11.8.md`, `acceptance.md` and the four evidence files for context.
- The Windows Docker egress address against the address `callerNetwork` reads: a mismatch would fail loudly, and the committed run passed.

---

## What was done with the second review

| Finding | Grade kept | What was done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1      | Medium     | **Fixed.** `cli.staging` takes the expected version from this tree, or from `MYKEY_CLI_EXPECT` with a published bundle, and compares the CLI under test with it; the exit it expects follows from that version. The published run's journey file carries the version in its name, and the second test writes `staging-cli-runtime-credential-<version>.json` for both CLIs. `automation.staging` refuses `MYKEY_CLI_DIST` and records its CLI's version. Rerun: the tree's build 2 of 2, the published `0.1.2` 2 of 2, and the bundle with no version named does not start. |
| M2      | Medium     | **Fixed, test first.** The new unit test failed ("expected tokens 0 to be 1"), then passed: colour codes are removed before counting, and twenty characters of the secret count. The sample is checked with `parsePresentedSecret`.                                                                                                                                                                                                                                                                                                                                         |
| M3      | Medium     | **Fixed.** In all three files one control of each surface travels as the needles do (a request id, a credential or project id, a path, a second fixed line). Rerun: found on every surface, with 0 values found.                                                                                                                                                                                                                                                                                                                                                            |
| M4      | Medium     | **Fixed.** The four places. No failure path was forced on staging: the proof is that the files still pass and clean up (`cleanup` in both evidence files).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| L2      | Low        | **Fixed:** `nextMinute()` before the token sweep's five issuances.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| L5      | Low        | **Fixed with M1:** `releasedCliDist()` in the harness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| L6      | Low        | **Fixed:** `acceptance.md` says five surfaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| L8      | Low        | **Answered by a result.** The reruns gave a second fleet run of 21.7 s. `acceptance.md` S11-8 now reads both rounds against the 20 s and says it is not proven on staging. The evidence field's name is unchanged.                                                                                                                                                                                                                                                                                                                                                          |
| L1      | Low        | Deferred: the deploy test's title, and its two tightenings, need a deploy run of their own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| L3      | Low        | Deferred: `transport.staging` can print the workstation's address when its forwarded-header assertion fails. The line is older than this session.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| L4      | Low        | Deferred: `tools/agent-runner/prepare.ts` and a stale build context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| L7      | Low        | The deploy half is green since Run 11.9 (2 files, 7 of 7, 731 s). Its two smaller points are deferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
