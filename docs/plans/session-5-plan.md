# MyKey Stage 1 — Session 5 (Machine access, CLI and API reference) Execution Plan

> **For the executing agent:** carry this plan out run by run, in the order given in "Run order". If you have the superpowers skills, use `superpowers:executing-plans` (inline execution is the owner's standing preference; one fresh-context review at the gate). Steps use checkbox (`- [ ]`) syntax for tracking. You do not re-decide anything in Doc 10 §3 / §8 or in the "Planner decisions" table below; if one proves wrong, write a one-paragraph decision record and continue (Doc 10 §1). One fallback of Doc 10 §8.1 is open in this session: **CLI packaging** (Run 5.7). P-98 says how its proof is run and what the planner expects it to show.

**Goal:** By the end of Day 8 (17 November 2026), on staging, the owner issues a machine token for an environment and sees it once; a fixture application started with `secrets run` receives the complete current secret set of that environment with no `.env` file; the owner revokes the token and the next start is denied; an archived environment serves no machine and holds no working token; the CLI is installed from released artifacts and passes one test suite on Linux x64, Linux arm64, macOS x64 and macOS arm64; and an owner or admin reads the API reference in the browser without one request leaving the service.

**Architecture:** The API gains its second OpenBao identity: the organization's `issuer` AppRole (D-18), used for one login per issuance, revocation or archive step and revoked at the end of that step. A machine credential is a row in `app.machine_credential` plus an orphan, non-renewable OpenBao token that PostgreSQL never sees: only the accessor is stored. Issuance and revocation are operations with a marker written before the one backend change, under the environment's advisory lock (D-36): the credential row reaches `issuing` or `revoking` in the same commit as the marker, so a credential is denied by the product before the backend is asked, and a token is delivered only after its accessor, expiry and `active` state are committed. Whatever cannot be proven afterwards stays closed (`needs_review`, `revoking`), raises the existing alert and is settled by an operator command from the namespace's own accessor list. Archive is a coordinator over the same revocation step: it closes the resource first, revokes and verifies every credential of the catalog, and only then calls the resource `archived`; because every one of its backend changes is an idempotent revocation verified by absence, the API's 30-second tick may continue an interrupted archive. A machine request is authenticated by asking OpenBao who the presented token is, and every backend read of that request is made with the presented token itself; the complete read of Run 4.8 (`readEnvironment`) is reused unchanged in its order, with the reader swapped. The CLI is one bundled JavaScript file that speaks only to the product API over verified HTTPS, validates the complete response before it starts anything, and never writes a value or the token anywhere but the child's environment or the one exclusive export file. The API reference is a single self-contained document served by the API to an owner or admin.

**Tech stack:** everything pinned in Sessions 1–4. Planned additions, each pinned in the run that adds it after the advisory check of Run 1.3 Step 2: `esbuild` as a direct development dependency (the version already in `pnpm-lock.yaml`), for the CLI bundle (Run 5.5); the four official Node 24.22.2 release archives by SHA-256 (Run 5.7); `next` and, for Python, `fastapi` and `uvicorn` with hashes, plus one Python base image by digest, for the fixture applications only (Run 5.8); `playwright` with its Chromium build, for the network capture (Run 5.9). No pre-release version of any of them.

**Spec:** `docs/doc_10_mykey_stage_1_compressed_implementation_plan_v1.0.md` §1–§5, §7 "Session 5", §8, §9, §10. Behaviour: Doc 04 §3 (FR-1.17, FR-1.18), §6 (FR-1.39–1.45), §7 (FR-1.46–1.51, FR-1.79, FR-1.85 and the CLI contract table), §8 (FR-1.52–1.54); acceptance AC-1.11, 1.19, 1.20, 1.21, 1.22, 1.37, 1.40, 1.42 (synthetic rehearsal, D-03). Design: Doc 06 §5 (machine roles), §6.1, §7.1, §7.3, §8 (machine resolve), §9, §10, §11, §18.4. Previous sessions: `docs/evidence/session-4/report.md` ("What Session 5 must know"), D-17, D-18, D-20, D-24, D-34 … D-38; `docs/evidence/session-2/run-2.2.md` and `run-2.8.md`. Old runbooks for ideas only: D08-S26–S32.

**Provider facts used here** come from the tests of Run 2.2 on OpenBao 2.7.2 (`tests/integration/openbao/issuance.test.ts`, D-18): the issuer sequence login → create from the token role → lookup by accessor → revoke-self; a created token is an orphan, non-renewable service token with exactly one policy and `num_uses` 0; its lifetime is read from `creation_ttl` and `expire_time`, never from `explicit_max_ttl`; `meta` and `display_name` are accepted; revoke-by-accessor answers 204 for a live token and 200 for an unknown one, so revocation is proven only by a lookup that answers 400 "invalid accessor"; a read with a revoked or expired token answers 403 and cannot be told from a policy denial; an accessor of another namespace answers 500. Nothing was executed for this plan. Five facts are **source or documentation reading** only, and the test named beside each is the first real evidence — when the observation differs, the observation wins and goes into the run note:

- `meta` given at `auth/token/create/<role>` comes back unchanged from `lookup-accessor` and from `lookup-self` (Run 5.1 Task B);
- `LIST auth/token/accessors` in a namespace also lists the login tokens of the AppRoles of that namespace, so the operator's inventory must select by policy name, not by count (Run 5.2 Task C);
- a lookup by accessor right after a successful revoke-by-accessor answers 400 at once; an **expired** token's accessor may still answer 200 for a moment (D-18), which is why the verification looks three times (Run 5.2 Task A);
- Node's single executable applications are marked "Stability: 1.1 – Active development" in the Node 24 documentation, need the separate tool `postject`, and are not supported on macOS x64 (read on 14 Nov 2026 at `nodejs.org/docs/latest-v24.x/api/single-executable-applications.html`; Run 5.7 Step 1 reads the page of the pinned version again);
- the option names that switch off Scalar's request execution, telemetry, default fonts and developer tools are those of the pinned `@scalar/api-reference`; they were not read for this plan (Run 5.9 Task B reads the package's types, and the network capture is the proof either way).

---

## Global constraints

Every run's requirements include this section and the "Global constraints" of the plans of Sessions 1–4 (synthetic data only, real stores for proof, a skipped test is not a pass, the forbidden components, pins, limits live once in `@mykey/contracts`, remote work through `scripts/host.ts`, secrets only on stdin, one pipeline, contract commits, a denial must be a denial, database time, values in code and in tests, no retry of an effect, the lock connection, the invariant check).

- **Doc 10 §4.1 is at stake in every run of this session.** Read the eleven rules before starting. The ones this session can break: rule 1 (a machine token, or anything derived from one without a key, in PostgreSQL — credential row, operation, step, audit detail, job; **machine tokens are stored nowhere, not even encrypted**), rule 2 (a token or a value in a log line, an error body, a test failure message, a process argument or the transcript), rule 3 (a timeout called a failure; a token created twice by a retry), rule 4 (a partial set returned as complete, or a child started with one), rule 8 (a value released before its audit row is committed), rule 11 (`revoked` or `archived` without a verification in the backend).
- **Tokens in code.** A machine token lives in the memory of two requests only: the one that issues it and each one that presents it. It is held in a variable or field named `token` (the log's second pass redacts that key, `apps/api/src/log.ts`), is never passed to a logger, an `Error` message, an audit detail, a job, a column or a cache, and is never part of a URL. An `OpenBaoClient` built from a presented token is used for that request and dropped.
- **Tokens in tests.** A token never appears in a test name, a snapshot, an assertion that prints on failure, or a child's argument list. Compare `sha256(token)` digests, lengths or booleans (`expect(text.includes(token)).toBe(false)`). A test that needs a token on a host sends it on stdin or fd 3 (`countOnHost`), never in a command line.
- **A change is sent once.** `tokenCreateFromRole` is sent once per issuance, whatever happens. `tokenRevokeAccessor` is the one backend change of this product that may be sent again for the same accessor — by a new revoke request, by the archive coordinator or by the operator — because it is idempotent and proven only by absence (FR-1.42 "repetition is safe"; D-18). Nothing else is repeated; a lookup is a read and may be repeated.
- **After a marker, every failure is `unknown`.** As in Session 4: from the commit that writes the operation as `executing` (issuance, revocation), an exception, a lost connection or a deadline answers `503 outcome_unknown` with the operation id — except the definite backend refusals P-87 and P-89 name.
- **Closed first.** A credential is `revoking` and a resource is `revoking` in a committed transaction before the backend is asked to revoke anything; no state ever reads `revoked` or `archived` before a lookup proved the absence.
- **The machine path never falls back.** No machine request reads OpenBao with the runtime identity, and no error path of a machine route may reach `deps.bao.clientFor` (Review focus 2).
- **Statuses.** Session 5 proves product code against real stores, on staging and on the four runners, not on the frozen release candidate: the registry moves an item to `SPIKE_PASS` or `FAIL`, never to `PASS` (P-84). A `SPIKE_PASS` needs a run note that states the id and the status on one line.
- **Migrations.** One migration per run that needs one, numbered in merge order from `0013`; never edit a merged migration. Every new table, column, index, function or grant extends `tests/harness/privilege-matrix.ts` and `docs/runbooks/db-globals-inventory.md` in the same commit. Read the generated SQL (CLAUDE.md "New migration").
- **Staging.** A staging test begins by asserting its target, creates its own project and environments with fresh names, revokes every credential it issued and undoes every state change in `finally`. Inside a run, execute one file: `node scripts/require-staging-env.ts && pnpm exec vitest run --project staging tests/staging/<file>`. A staging run rewrites committed evidence files of earlier runs: restore them before committing.
- **Production is not touched** before the gate run, and there only with the owner's word.
- **The workstation.** One heavy job at a time: the integration suite (`--maxWorkers=2`), a staging file, a Docker build, the CLI container suite and the browser capture never run together. The workstation is Windows; the CLI refuses native Windows on purpose, so its process tests run in a Linux container (`pnpm run test:cli`, P-97) and on the runners. Regexes and escapes are written with the editor tools, never through the shell.
- **CI costs minutes the repository barely has** (P-99). Prove every run locally. Nothing is pushed for CI before the gate; the pull request is opened at the gate and fixes are pushed to it in batches. `cli-matrix` runs by hand, once, from released artifacts, after the same suite is green in the local Linux container. After every push to the pull request: `gh run list --branch session-5 --limit 3`.
- **Every run ends with:** `pnpm run check` green, the run's tests green, a commit on branch `session-5`, and a run note `docs/evidence/session-5/run-5.N.md` (template of Run 1.1: `What was done`, `Commits`, `Commands and results`, `Deviations and decisions`, `Open issues`).
- **Git.** Never commit on `main`. Worktrees and clones, when used, live under `C:/Users/gmpar/mykey-wt/` and `C:/Users/gmpar/mykey-gate/` (outside OneDrive). The pull request to `main` is merged only when the owner says so.

## Review focus

Five conditions the specifications imply but do not spell out, most likely to bite first. Each has a test pinned in the run named.

1. **A token exists that nobody recorded, or is delivered without a record.** The create call succeeds and the finalizing commit fails; the answer is lost on the way back; the request is replayed and creates a second token. → P-87 and P-88: the token leaves the API only after the commit of accessor, expiry and `active`; a replay never executes. Run 5.2 Task B kills the API and cuts the connection at each of six boundaries and then asks the namespace itself: every accessor that carries a machine policy is either an `active` row of the catalog or is gone after `ops reconcile-credentials`, and until then a new issuance for that environment is refused.
2. **A machine request is answered with the service's own authority.** A code path of resolve reaches `deps.bao.clientFor`, or a helper written for humans is reused and reads as `runtime`; then a revoked token still gets values, and the native scope of FR-1.40 proves nothing. → Run 5.4 Task B: the API runs with a runtime credential that OpenBao refuses (a wrong secret id) and machine `keys` and `resolve` still answer 200; with a working runtime credential and the machine token revoked between authentication and the first read, the answer is `401` and no value is in the body.
3. **Anyone holding a dead token can close an environment.** `readEnvironment` treats a `denied` read as drift and sends the environment to review (P-68, P-72); a revoked or expired machine token is denied by OpenBao in exactly the same way. → P-94: a denied read under a presented token asks `lookup-self` once more; a dead token is `401 unauthenticated` and nothing else changes. Run 5.4 Task B revokes the token directly in OpenBao mid-request and asserts the environment is still `active` and the next human export succeeds.
4. **The CLI starts the application with something less than the complete set.** A body cut by a proxy at a JSON boundary that still parses, a `count` that disagrees with the entries, a 200 from something that is not the API, a redirect followed with the bearer attached, a second response reused from a cache. → Run 5.6 Task A drives a test server through each of these and asserts in every case: exit code of the contract, **no child process created** (a marker file the child would write does not exist), nothing on disk.
5. **The token leaks sideways on the consumer's machine.** In the child's environment, in `/proc/<pid>/cmdline` or `environ` of a process that is not the CLI, in shell history through the runbook's own commands, in an image layer, in the export file, in an error message. → Run 5.6 Task A reads the child's environment and the argument lists of every process of the test's process group; Run 5.8 executes the runbook's commands in a fresh container and searches history files, the image and the repository for the token's bytes.

## Planner decisions

Settled here so the executor does not have to choose. Each one marked **DR** gets a decision record in the run shown.

| # | Decision | Why | Run |
| --- | --- | --- | --- |
| P-84 | The registry ceiling in Session 5 is `SPIKE_PASS` (as P-38, P-61). "PO-2 proven with the product's issuer", "the CLI passes on four platforms from released artifacts" and "G-MACHINE closed on staging" are sentences of the session report with test names, not `PASS`. | Gate R counts scenarios on one frozen build; `registry-verify.ts` lifts the rule in Run 8.7. | all |
| P-85 | The API holds the `issuer` AppRole beside `runtime`: `issuerBaoFromDirectory` reads `issuer-role-id` and `issuer-secret-id` from the directory that already holds the runtime files (`scripts/host.ts` installs them today). One **issuer session** per issuance, per revocation and per environment of an archive: `appRoleLogin` (a token of 60 s), the step's calls, `tokenRevokeSelf` in `finally`. A login that fails is answered before any row is written. A failed revoke-self is logged and nothing else: the token dies within 60 s. The start-up self-check logs `issuerLogin` and `status.sh` reports it; it does not gate `/health` (as P-62). **DR D-40.** | D-18 tested this sequence and no other. A login is not a change of the product's state, so it comes before the marker. | 5.1 |
| P-86 | The credential record. States: `issuing → active → revoking → revoked`; `issuing → needs_review` (the issuance could not be proven); `active → expired` (written by the sweep; **every check compares `effective_expires_at` with `now()` itself and never trusts the stored state**). A definite backend refusal of the create leaves the row `revoked` with a null accessor: such a row was never a token and the inventory does not list it. Migration `0013`: `GRANT UPDATE (accessor, effective_expires_at, state, last_used_at) ON app.machine_credential TO api_runtime`; a partial unique index `machine_credential_unresolved_issuance_key (environment_id) WHERE state IN ('issuing', 'needs_review')`; an index `(environment_id, state)`. The unique index **is** the rule "an unknown issuance blocks new issuance for that environment". No state is added to the check constraint. **DR D-40.** | Doc 06 §7.3; FR-1.39, FR-1.43. `api_runtime` has no `DELETE`, and a row that explains a failed attempt is worth keeping. | 5.1 |
| P-87 | Issuance, in order, all under the environment's advisory lock on its dedicated connection: (a) issuer session; (b) **one** transaction: replay recheck, capture mode `idle`, gate open, parents and the caller's authority re-read, project and environment `active` and `kv_ready`, the credential row `issuing` (a unique violation → `409 state_conflict` with the blocking operation's id), the operation as `executing` with a dispatch attempt id, a step whose `target` is the credential id, audit `credential.issue` with outcome `intent` — this commit is the marker; (c) `tokenCreateFromRole(machineName(environmentId), ttl, correlation, { credential_id, operation_id })`, once; (d) `tokenLookupAccessor`: orphan, not renewable, type `service`, policies exactly `[machineName(environmentId)]`, `num_uses` 0, `creation_ttl` positive and at most the request (FR-1.39: the backend may give less), `meta` equal to what was sent; (e) **one** transaction: project and environment still `active` (locked `FOR SHARE`), `activateCredential` (accessor, `effective_expires_at` from `expire_time`), `finishOperation` succeeded with `{ credentialId, state, effectiveExpiresAt }`, audit `success`; (f) unlock, answer. Backend answers to (c): `denied`, `sealed`, `invalid` with a 4xx status or status 0 → **definite**: operation `rejected` (`backend_inconsistent` and the environment to review for `denied`; `backend_sealed`; `dependency_unavailable`), credential `revoked` with no accessor. Everything else → **unknown**: operation `uncertain`, credential `needs_review`, `503 outcome_unknown`. A token that fails (d), or a parent that is no longer `active` in (e): revoke it by accessor, verify the absence, credential `revoked`, operation `rejected` (`backend_inconsistent` and the environment to review; or `state_conflict`); when that revocation cannot be verified the accessor is stored, the credential is `revoking`, the operation `uncertain`. **DR D-40.** | Doc 06 §7.3 ("credential `issuing` + operation before dispatch"); FR-1.39 ("no token becomes usable after archive takes precedence"); P-68 for the answer table. One transaction for admission and marker: there is no state of a credential for "admitted but never dispatched". | 5.1 |
| P-88 | Delivery and replay. The 201 body is `{ operationId, credential: <the inventory shape>, token }` with `cache-control: no-store`; it is the only response schema of the contract with a field that holds an OpenBao token (FR-1.53; a unit test walks every schema). A replay of an issuance never executes: `executing` → 202 with the envelope; `succeeded` → `409 credential_not_replayable` with details `{ credentialId, state }`, the state read now (so it may be `revoked` or `expired`); `rejected` → its stored error; `uncertain` → `503 outcome_unknown`. **DR D-40.** | FR-1.43, word for word. | 5.1 |
| P-89 | Revocation, under the environment's lock: (a) issuer session; (b) one transaction: replay recheck, authority, the credential `FOR UPDATE` — admitted from `active`, `expired`, and from `revoking` when no revoke operation of that credential is `executing` with a heartbeat younger than 120 s; `revoked` → `409 state_conflict`; `issuing` and `needs_review` → `409 state_conflict` with the issuance's operation id (the operator settles those) — state `revoking`, the operation as `executing`, step target = credential id, audit `intent`: the marker, and from this commit the product denies the credential; (c) `tokenRevokeAccessor`, once per request; (d) up to three `tokenLookupAccessor`, 200 ms apart: `invalid` with status 400 is absence; (e) one transaction: credential `revoked`, this operation `succeeded`, every `uncertain` revoke operation whose step targets this credential `succeeded` too, audit `success`. `sealed` or `denied` from (c) → operation `rejected` (`backend_sealed`; `backend_inconsistent`), credential stays `revoking`. Anything else that is not proven absence → operation `uncertain`, credential stays `revoking`, `503 outcome_unknown`. The inventory shows `revoking` as `revoking`. **DR D-40.** | FR-1.42, Doc 06 §7.3; D-18 (what proves a revocation). | 5.2 |
| P-90 | Unresolved credential work. The sweep (every 30 s, PostgreSQL only) gains two rules: an issuance `executing` with a heartbeat older than 120 s → `uncertain`, its credential `issuing → needs_review`; a revocation likewise → `uncertain`, its credential stays `revoking`; both write `system.operation_stuck` and clear `executor_boot_id`. It also writes `active → expired` for rows past their expiry. The operator command `ops reconcile-credentials --environment <id> [--executors-excluded yes]` settles an environment from the backend: it lists the namespace's accessors with the provisioning authority, keeps those whose policies name `machine-env-<environmentId>`, revokes and verifies every one that is not the accessor of an `active` row, re-sends and verifies the revocation of every `revoking` row, and then settles: a `needs_review` credential → `revoked`, its operation → `rejected` — but only when a token carrying that operation's id in `meta` was found and revoked, or when `--executors-excluded yes` was given (exit 3 without it, as `reconcile-operation`); a `revoking` credential proven absent → `revoked`, its operations → `succeeded`. One audit row `operator.reconcile_credentials` with counts. `status.sh` needs no change: `operationsUnresolved` already counts these operations. **DR D-40.** | FR-1.43 ("until inventory identifies and invalidates unrecorded tokens and excludes delayed issuance"); D-20 (a create that was sent may still arrive: only exclusion ends that); D-38 for the command's shape. | 5.2 |
| P-91 | Archive runs **inside its request** and is continued by the API's tick. Admission (one transaction, under the environment's lock for an environment archive): the resource `active → revoking` with `archive_operation_id`; for a project also each of its `active` environments `→ revoking` with `archive_origin = 'project'`; an environment archived on its own keeps `archive_origin = 'self'` and is not touched by a later project archive; every `active` or `expired` credential of the affected environments `→ revoking`; the operation as `executing`; audit `intent`. A project with a `pending` environment, and any resource with an effect slot held, is refused with `409 state_conflict` and the blocking operation's id. Then `driveArchive(operationId)`: for each affected environment in turn — its advisory lock (busy → later), any credential that became `active` meanwhile `→ revoking`, one issuer session, revoke and verify each `revoking` credential → `revoked` — and when no credential of the scope is in another state than `revoked`: the resource and its project-origin children `→ archived`, the operation `succeeded`, audit `success`. Whatever stops it (a lock that is busy, a revocation not proven, a credential in `issuing` or `needs_review`, a crash) leaves the operation `executing` and **does not touch the heartbeat**; `continueArchives` in the 30-second tick calls `driveArchive` again for every archive operation whose heartbeat is older than 120 s, and after 120 s the existing alert `operations_unresolved` is up until it finishes. An archive operation is never `uncertain` and is not in `SWEPT_ACTIONS`. The answer is 200 when it finished inside the request and 202 with the envelope otherwise. State changes go through one function `app.lifecycle_transition(kind, organization_id, id, operation_id, step, origin)`: `SECURITY DEFINER`, fixed `search_path`, owned by `migration_owner`, `EXECUTE` for `api_runtime` only; steps `begin_archive` (`active → revoking`), `finish_archive` (`revoking → archived`, same operation, and no credential of the scope outside `revoked`), `reactivate` (`archived → active`, clears origin and operation); it never touches `needs_review`. Migration `0014`. **DR D-41.** | FR-1.17; Doc 06 §7.1. The issuer credential lives in the API (D-18) and is bound to its address, so the coordinator cannot be a provisioner job. Every backend change of an archive is an idempotent revocation verified by absence — the compare-then-act argument of P-55 — so continuing it is safe where continuing a secret write is not (P-69 stays as it is). Migration `0010` took the state columns from the API on purpose; a function with a closed transition table gives back three moves and no more. | 5.3 |
| P-92 | Reactivation is database work and reads only. Environment: it must be `archived` with `archive_origin = 'self'` and its project `active`; verified before the transition: the token role and policy `machine-env-<id>` exist and the policy's digest equals `environment.policy_digest` (issuer session, read-only); the names OpenBao lists equal the index's (runtime identity; the check of `readEnvironment` step 2); every credential of the environment is `revoked` and each stored accessor still answers 400. Project: it must be `archived`; the same verification for each child with `archive_origin = 'project'` and this project's `archive_operation_id`; all pass → the project and those children `active`; children archived on their own stay `archived`. A failed verification changes nothing and answers `503 backend_inconsistent` (the operation `rejected`); the resource stays `archived`. Reactivation never creates, renews or re-activates a credential. **DR D-41.** | FR-1.18. | 5.3 |
| P-93 | Machine authentication is a pipeline step for auth class `machine`, before validation: exactly one `Authorization` header of the form `Bearer <token>`, the token at most `LIMITS.body.bearerMaxBytes` and of the characters `A-Za-z0-9._-`; a cookie beside it is `400 mixed_authentication` (already so); anything else `401 unauthenticated`. The namespace is the process's own organization (`RuntimeBao.organizationId()`), never taken from the request. `tokenLookupSelf` with the presented token: `denied` or `invalid` → 401; `sealed` → `503 backend_sealed`; otherwise `503 dependency_unavailable`. The accessor must be that of a row of `app.machine_credential` in this organization, `active`, with `effective_expires_at` in the future on database time → otherwise 401. The path's `:project` and `:envName` must resolve to exactly the row's project and environment → otherwise `404 not_found`, the same for an absent and a foreign target. Project and environment must be `active`: `revoking` or `archived` → `403 action_denied`; `needs_review` → `503 backend_inconsistent`. Any query parameter and any body key is `400 forbidden_selector`. The principal is `{ kind: "machine", credentialId, scope, reader }`, where `reader` is the client built from the presented token. `last_used_at` is written at most once a minute per credential, outside the request's outcome. Denials of a **recognized** credential (wrong scope, dead state, closed parent) are audited as `access.denied` with a machine actor; a token nobody can attribute is counted in the log only. A bearer on a human route stays `401`. The rate limit of 60 a minute per credential is Run 6.3's, with the other limits. **DR D-42.** | FR-1.44; Doc 06 §7.3. An unattributable 401 must not be a way to fill the audit table. | 5.4 |
| P-94 | Machine reads. `EnvironmentReadRequest` gains `reader?: { client: OpenBaoClient; alive: () => Promise<boolean> }`; with it, `readEnvironment` never calls `deps.bao.clientFor`, and a read answered `denied` calls `alive()` (one `tokenLookupSelf`): false → refused `unauthenticated`, nothing marked; true → the drift path as today (the token is valid and its policy does not let it read: that is a broken machine policy). `machine.resolve` is `readEnvironment` inside the large gate, with a recheck that re-reads the credential (`FOR SHARE`: `active`, unexpired), the parents and the gate, and an audit row `machine.resolve` with a machine actor committed before the body leaves. `machine.keys` is `readEnvironmentNames`: the same lock, recheck, slot and review checks, the names OpenBao lists (with the presented token) compared with the index's, and the **live** names returned; its audit row is `machine.keys`. Both bodies carry `apiMajor`, `environmentId`, `generation`, `count` and `complete: true`; both answer as one buffered body with `content-length`, `cache-control: no-store` and no compression. **DR D-42.** | FR-1.44 ("read OpenBao using the presented token itself"), FR-1.47; Doc 06 §8; item 1 of "What Session 5 must know". | 5.4 |
| P-95 | Audit actions of this session: `credential.issue`, `credential.revoke`, `machine.keys`, `machine.resolve`, `project.archive`, `project.reactivate`, `environment.archive`, `environment.reactivate`, `operator.reconcile_credentials`. Details: `credentialId`, the credential's `name` (checked with the project-name pattern), `ttlSeconds`, counts, `generation`. Never an accessor, a token, or a digest of one. | FR-1.56; the closed list of `packages/audit/src/events.ts`. An accessor is not a credential, but it is what revocation is addressed to; the catalog is its one home. | 5.1–5.4 |
| P-96 | The CLI. Source in `apps/cli/src`, bundled by `esbuild` into one file `apps/cli/dist/secrets.mjs` that imports only `node:` modules (it may bundle `@mykey/contracts` and the dotenv codec; nothing else of the workspace). Commands: `secrets keys`, `secrets run [--override] -- <command> [args…]`, `secrets export --out <path>`, `secrets --version`; selectors `--project <id>` and `--env <name>`, or `SECRETS_PROJECT` and `SECRETS_ENVIRONMENT` (a flag wins). API URL from `SECRETS_API_URL`, else `${XDG_CONFIG_HOME:-$HOME/.config}/mykey/config.json` holding `{ "apiUrl": "https://…" }` and nothing else. Token from `SECRETS_MACHINE_TOKEN`, or from stdin with `--token-stdin` for `keys` and `export` only; both at once, or any flag that would carry a token, is a usage error. Transport: `node:https` directly — verification always on, no redirect followed, no proxy, one request per call, `GET /v1/version` without a credential first and the bearer sent only after its `apiMajor` matched. Refused before any request (exit 78): a URL that is not `https:`, or has userinfo, a fragment or a query; `NODE_TLS_REJECT_UNAUTHORIZED=0`; `NODE_OPTIONS`, `NODE_USE_ENV_PROXY`, or an `execArgv` carrying `--require`, `--import`, `--loader`, `--experimental-loader`, `--inspect*` or `--insecure-http-parser`; platform `win32`; a Linux without glibc; an architecture outside the four targets. `NODE_EXTRA_CA_CERTS` is allowed: it adds trust and removes none. Exit codes — the table of Doc 04 §7 is the authority, this is the planner's reading of it and a difference goes into the run note: 64 usage; 65 malformed or incomplete data; 69 unavailable (network, TLS, 5xx, `environment_changed`, `key_under_review`, `quarantined`); 73 export target; 75 capacity (`429`, `busy`, `507`, an environment too large for the platform's limits); 76 API major mismatch; 77 authentication, scope or resource denied (401, 403, 404); 78 unsupported configuration or platform; for `run`, the child's status or 128 + the signal number. One line on stderr: `secrets: <category>: <text> (code: <contract code or none>, requestId: <id or none>)`. **DR D-43.** | FR-1.46–1.50, FR-1.79; Doc 06 §10; the nine requirements of D-24. `fetch` follows redirects and hides the socket; `node:https` does neither. | 5.5, 5.6 |
| P-97 | CLI proof, three layers. (1) Project `cli` (`tests/cli`): the CLI as a child process against `tests/cli/server.ts`, a local HTTPS server with a certificate made at run time (`openssl`, present on the runners and in the container) that answers from the schemas of `@mykey/contracts` and can be told to misbehave. These tests need POSIX; on Windows the project's setup fails with the line "run `pnpm run test:cli`". (2) `pnpm run test:cli` (`scripts/test-cli.ts`): natively on Linux and macOS; on Windows it copies the working tree into a Docker volume, installs in the pinned Node image (`linux/amd64`) and runs project `cli` there. (3) Real stores: `tests/integration/machine/cli-client.test.ts` imports the CLI's own client module and runs it against the real API of the fixture — the same code path, on every platform — and asserts that every body the real API sends parses with the CLI's validator; the process against real stores is the staging journey (Run 5.6 Task C, the gate), with the CLI in the Linux container when the workstation is Windows. With `MYKEY_CLI_BIN` set, layer 1 runs that binary instead of the bundle: this is how the matrix tests the installed artifact. | The test server proves the CLI's behaviour towards HTTP, which is the CLI's whole world; "mocks are not proof" is about the two stores, and layer 3 is where the stores are real. macOS runners have no Docker, so the matrix suite cannot need a stack. | 5.5–5.7 |
| P-98 | CLI distribution. **The proof of the first choice is Run 5.7 Step 1 and it is a reading, not a build:** if the documentation of Node 24.22.2 still marks single executable applications below "Stability: 2 – Stable", or leaves one of the four platforms unsupported, the standalone executable fails D-01 and D-24 (9) ("no pre-release dependency") and the §8.1 fallback is taken at once — the planner expects exactly this (see "Provider facts"). No executable is built to find out what the documentation already says. The fallback, a pinned Node package with a tested installer: a release `cli-v<version>` on the private repository, made **on the workstation** with `gh release create` (no Actions minutes), holding `mykey-cli-<version>.tgz` (`secrets.mjs`, `package.json`, `LICENSE`), `install.sh` and `SHA256SUMS`. `install.sh` (POSIX `sh`, no `sudo`): maps `uname -s` / `uname -m` to one of the four targets and refuses everything else; takes the official `node-v24.22.2-<target>.tar.gz` from the directory it runs in, or else from `https://nodejs.org/dist/v24.22.2/` with `curl --proto '=https' --tlsv1.2 --fail`; verifies it and the CLI archive against SHA-256 sums written into the script from `infra/dependencies.lock.json` at build time; unpacks into `${MYKEY_HOME:-$HOME/.local/share/mykey}/cli/<version>/`; writes the launcher `$HOME/.local/bin/secrets` (`exec "<dir>/node/bin/node" "<dir>/secrets.mjs" "$@"`); edits no shell profile; `--uninstall` removes what it wrote. A machine gets the release with `gh release download` (the repository is private). **DR D-44.** | Doc 10 §8.1, D-09, D-24 (9). The bundle is the same bytes on every platform, so nothing is cross-compiled: what differs per platform is the official Node archive, the installer's choice of it and the operating system's behaviour — the three things the matrix tests. | 5.7 |
| P-99 | The Actions budget. The private repository gets 2,000 minutes a month, Session 4 used over 1,800 of November's, and the agent's token cannot read the remainder (the billing endpoint needs the `user` scope). Planned cost of this session: one full run on the pull request (about 50 minutes) and one `cli-matrix` run of about five minutes per runner — Linux counts once, macOS ten times: about 110 billed minutes. Together about 160; one repetition of either does not fit what is left of November. So: the session start asks the owner for one thing (a small spending limit for Actions, or the remaining minutes — see "Session start"); without an answer, the gate runs the matrix once and the pull request's CI once and stops there, and whatever did not run is named in the report with its item left `OPEN`. Projects `browser` and `consumers` do not join CI in this session; they run on the workstation and at the gate. | "Actions minutes are scarce; the owner wants CI cost at a minimum" (CLAUDE.md). AC-1.37 needs real runners; nothing else of this session does. | 5.7, 5.10 |
| P-100 | Consumer fixtures. `tests/fixtures/consumers/next-app` and `fastapi-app`: each a minimal server with one route `GET /check` that answers the names of the environment variables it was started with and the SHA-256 of each value, never a value; each with a Dockerfile on a base image pinned by digest and its dependencies pinned (`next` exact in a lockfile of its own; `fastapi` and `uvicorn` with `--require-hashes`). The two runbooks carry their commands in fenced `sh` blocks; a block preceded by the comment `<!-- rehearsed -->` is executed, in order, by `tests/consumers/runbook.test.ts` in a fresh container of the pinned Node image — so the runbook that is tested is the runbook that is read. The token reaches the application's host as a file `0600` owned by the launching user, read by a launch wrapper (`secrets-launch.sh`, shipped in the runbook) that exports `SECRETS_MACHINE_TOKEN` for `secrets run` only; in the deployment procedure the file is mounted into the container at run time and is no layer of the image. Project `consumers` in `vitest.config.ts`. | FR-1.85, PO-20, AC-1.42 as the synthetic rehearsal of D-03. | 5.8 |
| P-101 | The reference. `GET /v1/reference` answers **one** HTML document: Scalar's standalone script from the pinned `@scalar/api-reference`, inlined at start-up, the served OpenAPI document as a data block, and the configuration that switches off request execution, the client, telemetry, default fonts and developer tools. Headers: `content-security-policy: default-src 'none'; script-src 'sha256-<the two inline scripts>'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `cache-control: no-store`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`. `GET /v1/openapi.json` answers the generated document **reduced to the routes that have a handler in this build**. Both routes take the new action `reference.read`, allowed to the owner and the admins of the process's organization with a complete session; everyone else gets the hidden 404. The route list stays frozen (D-15): no asset route is added, which is why the document is self-contained. `contracts:check` gains a compatibility check against `packages/contracts/openapi/baseline-v1.json`: a removed path, method, response field or enum value, or a new required request field, fails until `API_MAJOR` moves. The capture is a Playwright test in a new project `browser`. **DR D-45.** | FR-1.52–1.54; Doc 06 §18.4; `apps/web` is still empty, and the reference must not wait for Session 7. A style hash is not possible for a library that writes its styles at run time; styles cannot make a request under this policy (`img-src data:`, `font-src 'none'`). | 5.9 |
| P-102 | Deploys to staging happen in Runs 5.2 (the issuer identity and the first issuance and revocation on the host), 5.4 (machine routes and archive) and 5.10 (the final commit). The other runs are proven on the local stack; Run 5.6 Task C runs the CLI against the build Run 5.4 deployed. | A deploy closes staging for about ten minutes. The host-only risk is the issuer's bound address (`10.78.3.3/32`), and it is met in the first deploy. | 5.2, 5.4, 5.10 |
| P-103 | Carried minors of the Session 4 report. **M-2:** at import apply and resume, an entry classified `unchanged` is compared again with the index row (version and state tag) under the lock; when it moved, the import stops as a changed entry does today. **M-6:** a stored rejection is final and replays as recorded, whatever its code; the reference's text for `Idempotency-Key` says "a rejected request is retried with a new key", and nothing is stored differently. Machine principals create no operations, so `operations.get` needs no machine rule (a bearer there is 401). | M-2 is a missing check; M-6 is FR-1.83's own rule ("a confirmed no-effect rejection returns its recorded rejection") and only lacked the sentence. | 5.9 |

## Carried items

The open issues and deferred minors of the Session 4 report, and what the registry says is owed here, each with its place.

| Item | Where |
| --- | --- |
| Machine resolve calls `readEnvironment`, with its own audit row and recheck | Run 5.4 (P-94) |
| Machine resolve of a large environment runs inside the large gate | Run 5.4 Task B |
| Effects without a marker: issuance, revocation, archive — a marker or an exclusion rule, and fault rows (the PO-16 note) | Run 5.1 (marker), Run 5.2 Task B (fault table), Run 5.3 (P-91: exclusion by idempotence) |
| Archive and reactivate need their own grants | Run 5.3 (migration `0014`, one function) |
| The `lifecycle` state class decides nothing yet for archive, reactivate and revocation | Runs 5.2, 5.3 |
| "Machine principals need their own visibility rule for `operations.get`" (D-35) | P-103: none needed |
| M-2, M-6 | Run 5.9 Task D (P-103) |
| PO-2 is `SPIKE_PASS` from Run 2.2; "needs the product's issuer" | Run 5.4 Task C (the attack with a token the product issued) |
| AGENT-B1 (thin CLI against OpenBao Agent, D-24) | Run 5.7 (the nine requirements, each with its test name) |
| M-1, M-3, M-4; M-5 and every rate limit, the machine credential's 60 a minute included; M-7; M-8 | Runs 6.x, 6.3, 6.9, Session 8 — unchanged |
| Checkpoint `pairs-lock-session-gate` (due from 15 Nov 2026 10:42:20 UTC) | Session start, Step 3 |
| The R2 fixture guard fails on purpose from 15 Nov 2026 09:42 UTC until Run 6.6 | Run 5.10 Step 1 (expected failure, listed by name) |
| `.trivyignore.images` (14 Dec 2026); all KMS certificates (12 Dec 2026) | not due in this session; named in the report |
| Production stays behind a gate that is not open | owner decision; Run 5.10 Step 6 only updates image and migrations, with the owner's word |

## Session start (before Run 5.1)

- [ ] **Step 1 — Branch.** Branch `session-5` already exists on the remote; its first commit is this plan (`docs: session 5 plan`). `git fetch origin && git switch session-5 && git pull`, then `git merge origin/main` if `main` moved since.
- [ ] **Step 2 — One message to the owner**, then start Run 5.1 without waiting. Save the text as `docs/evidence/session-5/owner-requests.md`. It contains:
  1. **One thing to decide, about GitHub Actions minutes.** The four-platform proof of the CLI needs real macOS runners, whose minutes count ten times; this session needs about 160 billed minutes at its gate and November has fewer than 200 left. Either set a spending limit for Actions of a few dollars (GitHub → Settings → Billing and plans → Budgets and alerts), or tell the agent the number under "Actions minutes used" on that page. Default when there is no answer: the matrix and the pull request's CI each run once, and anything that does not fit is reported as not proven.
  2. **Expect Telegram alerts from staging** during three deploy windows (Runs 5.2, 5.4, 5.10 — staging starts closed after every deploy) and during two deliberate drills (Run 5.2 and the gate): an issuance is made uncertain on purpose, which raises `operations_unresolved`, and staging is then closed for about ten minutes of maintenance while the operator command settles it. Each window is announced in its run note; an alert outside those windows is real.
  3. **One yes/no, needed only at the gate:** may the gate run bring production to the current migrations and API image, with its gate still not open? Default when there is no answer: no.
  4. **For information:** `pnpm run test:cloud` fails on purpose from 15 Nov 2026 09:42 UTC (the R2 fixture guard) until Run 6.6; all KMS certificates expire on 12 Dec 2026 and `.trivyignore.images` on 14 Dec 2026.
- [ ] **Step 3 — Checkpoint `pairs-lock-session-gate`** (due from 15 Nov 2026 10:42:20 UTC): record it the way the retention fixture defines (`tests/restore/retention/fixture.cloud.test.ts` and the evidence file it reads say where and in which shape); commit `docs(evidence): checkpoint pairs-lock-session-gate`. If the session starts before that time, do it at the start of the first run that begins after it, and say so in that run note.
- [ ] **Step 4 — When the owner answers** (in any run): record the answer in `owner-requests.md`, commit.

## Run order

```text
5.1 ─→ 5.2 ─→ 5.3 ─→ 5.4 ─→ 5.5 ─→ 5.6 ─→ 5.7 ─→ 5.8 ─→ 5.9 ─→ 5.10
```

- Inline execution takes this order. What may move when a run is blocked:
  - Run 5.3 is consumed by nothing before the gate: it may follow Run 5.6. Run 5.4 Task D then deploys without archive and the gate's deploy carries it.
  - Run 5.9 needs only the handlers of Runs 5.1–5.4; it is the one run that could go to a parallel worktree. Run 5.8 needs Run 5.7 (the installer) and Run 5.2 (a token to supply).
- Fixed dependencies: Run 5.2 needs Run 5.1; Run 5.4 needs Run 5.1 (a credential to present); Run 5.5 needs Run 5.4 (the contract of the machine routes); Run 5.6 needs Run 5.5; Run 5.7 needs Run 5.6 (the whole suite).
- Migrations: `0013_credential_lifecycle` (5.1), `0014_resource_lifecycle` (5.3). A later run that needs one takes the next number.
- **Scope valves (Doc 10 §8.2).** Two valves belong to this session: valve 2 (CLI platforms reduced to Linux x64 and macOS arm64 — it removes two matrix jobs, one of them a macOS one) and valve 4 (archive and reactivate removed: routes, tests, documentation and claims). If Run 5.4 ends more than one day behind (after 18 Nov 2026 12:00 UTC) and Run 5.3 has not started, propose valve 4 to the owner in one line and continue with Run 5.5 while waiting; valve 1 comes first in the order but belongs to Session 7, and valve 3 was not taken in Session 4 — say both in the message. Valve 2 is proposed only when the owner's answer about minutes makes the four-runner matrix impossible.

## File map

```text
packages/contracts/src/        routes.ts (the pending bodies of this session; action reference.read; error lists)
                               authz.ts (reference.read; machine)   errors.ts (details of credential_not_replayable)
packages/contracts/openapi/    openapi.json   baseline-v1.json
packages/db/migrations/        0013_credential_lifecycle.sql   0014_resource_lifecycle.sql
packages/db/src/repos/         credentials.ts   lifecycle.ts
packages/openbao/src/          client.ts (TokenInfo: creation ttl, uses, expiry, meta; create with meta)
packages/audit/src/events.ts   the actions of P-95
packages/operations/src/       runtime.ts (IssuerBao, RuntimeBao.withToken, organizationId)   replay.ts (issuance)
  credentials/                 issue.ts  revoke.ts  verify.ts  sweep.ts
  lifecycle/                   archive.ts  reactivate.ts
  secrets/                     read-environment.ts (reader; readEnvironmentNames)
  reconcile/credentials.ts     entry point "@mykey/operations/operator"
  imports/apply.ts             unchanged entries rechecked (M-2)
apps/api/src/                  runtime-bao.ts (issuer)  server.ts (issuer, archive tick)  operation-sweep.ts
  pipeline/                    machine.ts  route.ts (machine step, service scope)  authn.ts (Principal)  states.ts (lifecycle)
                               respond.ts (details)  context.ts
  routes/                      credentials.ts  lifecycle.ts  machine.ts  reference.ts
  reference/                   page.ts (the document, its hashes)  document.ts (the reduced OpenAPI)
apps/ops/src/commands/         reconcile-credentials.ts
apps/cli/                      build.ts  package.json (bin, version)  dist/ (ignored)
  src/                         main.ts  args.ts  errors.ts  config.ts  guard.ts  token.ts  client.ts  validate.ts
                               keys.ts  run.ts  export.ts  index.ts
infra/release/cli/             install.sh.template  build-release.ts  README.md
infra/hosts/checks/status.sh   issuerLogin
scripts/                       test-cli.ts   contracts-compat.ts
tests/harness/                 api.ts, api-process.ts (issuer, credential faults)  credentials-fixture.ts  cli.ts  cli-linux.ts
tests/unit/                    operations/replay.test.ts  contracts/token-fields.test.ts  cli/{args,validate,errors}.test.ts
tests/integration/             credentials/  lifecycle/  machine/  reference/  openbao/issuance.test.ts  imports/
tests/fault/credentials/       fixture.ts  issuance.test.ts  revocation.test.ts  archive.test.ts
tests/cli/                     server.ts  setup.ts  connection.test.ts  keys.test.ts  run.test.ts  export.test.ts  platform.test.ts
tests/consumers/               runbook.test.ts
tests/browser/                 reference.test.ts
tests/fixtures/consumers/      next-app/  fastapi-app/  secrets-launch.sh
tests/staging/                 credentials.staging.test.ts  machine.staging.test.ts  archive.staging.test.ts
.github/workflows/ci.yml       cli-matrix from released artifacts
docs/decisions/                D-40 … D-45
docs/runbooks/                 machine-credentials.md  consumer-local.md  consumer-deploy.md  reconciliation.md (credentials)
docs/evidence/session-5/       run-5.1.md … run-5.10.md  owner-requests.md  fault-table.md  token-sweep.txt
                               reference-capture.json  cli-matrix.md  report.md
```

---

## Run 5.1 — Token issuance and inventory (D08-S26)

**Files:** `packages/contracts/src/{routes,errors}.ts` (+ `openapi.json`, pending snapshot), `packages/openbao/src/client.ts`, `packages/audit/src/events.ts`, `packages/db/migrations/0013_credential_lifecycle.sql`, `packages/db/src/schema/app.ts`, `packages/db/src/repos/credentials.ts`, `packages/db/src/index.ts`, `packages/operations/src/{runtime,replay,index}.ts`, `packages/operations/src/credentials/{issue,verify}.ts`, `apps/api/src/{runtime-bao,server,app}.ts`, `apps/api/src/pipeline/{context,route,respond}.ts`, `apps/api/src/routes/credentials.ts`, `infra/hosts/checks/status.sh`, `tests/harness/{api,api-process,api-worker,credentials-fixture,privilege-matrix}.ts`, `tests/unit/operations/replay.test.ts`, `tests/unit/contracts/token-fields.test.ts`, `tests/unit/audit/events.test.ts`, `tests/integration/openbao/issuance.test.ts`, `tests/integration/credentials/{issue,protocol,inventory,surfaces}.test.ts`, `docs/decisions/D-40-machine-credential-lifecycle.md`, `docs/runbooks/db-globals-inventory.md`.

**Consumes:** Session 4: `withEnvironmentLock`, `Locked`, `Busy`, `inTransaction`, `finishOperation`, `touchOperation`, `intentOf`, `replayAnswer`, `ApiError` with `operationId` and details, `backendRefusal`, `markEnvironmentReview`, `lockParents`, `resolveAccess`, `decide`, `checkStates`, `createSecretsFixture`, `startApiProcess`, `FaultAction`. Session 2: `appRoleLogin`, `tokenCreateFromRole`, `tokenLookupAccessor`, `tokenRevokeAccessor`, `tokenRevokeSelf`, `machineName`, `OpenBaoAdmin.listAccessors`.

**Produces:**

```ts
// @mykey/openbao — client.ts
export interface TokenInfo { /* as today, plus: */ creationTtlSeconds: number; numUses: number; expireTime: string | null; issueTime: string | null; meta: Record<string, string> | null }
tokenCreateFromRole(role: string, ttlSeconds: number, c: Correlation, meta?: Record<string, string>)   // result as today; body gains `meta` only when given
// @mykey/operations — runtime.ts
export interface RuntimeBao { clientFor(organizationId: OrganizationId): OpenBaoClient | null;
  /** The organization this process serves; null before its files exist. */ organizationId(): OrganizationId | null;
  /** A client that authenticates with a presented token (Run 5.4). */ withToken(organizationId: OrganizationId, token: string): OpenBaoClient | null }
export interface IssuerSession { client: OpenBaoClient; /** tokenRevokeSelf; never throws. */ close(): Promise<void> }
export interface IssuerBao { /** null: this process holds no issuer credential for it. */ open(organizationId: OrganizationId): Promise<BaoResult<IssuerSession> | null> }
// apps/api — runtime-bao.ts
export function issuerBaoFromDirectory(target: OpenBaoTarget, directory: string): IssuerBao;   // issuer-role-id, issuer-secret-id; read as runtimeBaoFromDirectory reads its files
// @mykey/db — repos/credentials.ts
export type CredentialState = "issuing" | "active" | "revoking" | "revoked" | "expired" | "needs_review";
export interface CredentialRow { id: CredentialId; organizationId: OrganizationId; projectId: ProjectId; environmentId: EnvironmentId; name: string;
  issuanceOperationId: OperationId; accessor: string | null; requestedExpiresAt: Date; effectiveExpiresAt: Date | null; state: CredentialState;
  issuedBy: UserId; issuedAt: Date | null; lastUsedAt: Date | null;
  /** effective_expires_at <= now(), computed in the statement. */ expired: boolean; /** expires within LIMITS.machineToken.expiryWarningSeconds, in the statement. */ expiringSoon: boolean }
export function insertIssuing(tx: pg.PoolClient, scope: EnvironmentScope, c: { id: CredentialId; name: string; operationId: OperationId; ttlSeconds: number; issuedBy: UserId }): Promise<"inserted" | "blocked">;   // blocked: the unique index of P-86
export function blockingIssuance(db: Queryable, scope: EnvironmentScope): Promise<{ credentialId: CredentialId; operationId: OperationId } | null>;
export function activateCredential(tx: pg.PoolClient, id: CredentialId, v: { accessor: string; effectiveExpiresAt: Date }): Promise<boolean>;   // issuing → active
export function moveCredential(tx: Queryable, id: CredentialId, from: readonly CredentialState[], to: CredentialState, accessor?: string): Promise<boolean>;   // one conditional update
export function lockCredential(tx: pg.PoolClient, scope: EnvironmentScope, id: CredentialId, mode: "update" | "share"): Promise<CredentialRow | null>;
export function findCredentialByAccessor(db: Queryable, organizationId: OrganizationId, accessor: string): Promise<CredentialRow | null>;
export function findCredentialByOperation(db: Queryable, operationId: OperationId): Promise<CredentialRow | null>;
export function listCredentials(db: Queryable, scope: EnvironmentScope, page: { anchor: string | null; after: string | null; limit: number }): Promise<(CredentialRow & { sortKey: string })[]>;
export function touchLastUsed(db: Queryable, id: CredentialId): Promise<void>;                // at most once a minute (Run 5.4)
// @mykey/operations — credentials/verify.ts
export type TokenFault = "orphan" | "renewable" | "type" | "policies" | "uses" | "ttl" | "meta" | "namespace";
export function checkIssuedToken(info: TokenInfo, want: { role: string; ttlSeconds: number; meta: Record<string, string>; namespace: string }): TokenFault | null;
export type RevokeProof = "absent" | "refused_sealed" | "refused_denied" | "not_sent" | "unproven";
export function revokeAndVerify(session: IssuerSession, accessor: string, c: Correlation): Promise<RevokeProof>;   // one revoke; then up to three lookups 200 ms apart, absence = invalid with status 400; "not_sent": the connection was never made
// @mykey/operations — credentials/issue.ts
export const CREDENTIAL_FAULT_POINTS = ["after_issuer_login", "after_marker", "after_create_sent", "after_verify", "before_finalize_commit", "after_finalize",
  "after_revoke_marker", "after_revoke_sent", "before_revoke_finalize_commit"] as const;
export interface CredentialDeps { pool: pg.Pool; lockPool: pg.Pool; issuer: IssuerBao; bootId: string; gateOpen: () => boolean;
  faults?: (point: (typeof CREDENTIAL_FAULT_POINTS)[number], operationId: OperationId | null) => void | Promise<void> }
export interface IssueRequest { routeId: string; scope: EnvironmentScope; userId: UserId; name: string; ttlSeconds: number; idempotencyKey: string; intent: Intent; requestId: string;
  /** Runs in the marker transaction: null when the caller may still issue (authority and states). */ recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null> }
export type IssueOutcome =
  | { kind: "issued"; operation: OperationRow; credential: CredentialRow; token: string }
  | { kind: "replay"; operation: OperationRow }
  | { kind: "refused"; code: ErrorCode; operationId?: OperationId }
  | { kind: "unknown"; operationId: OperationId };
export function issueCredential(deps: CredentialDeps, request: IssueRequest): Promise<IssueOutcome>;
// tests/harness/credentials-fixture.ts
export function createCredentialsFixture(opts?: { processes?: 1 | 2; runtime?: "ok" | "broken" }): Promise<CredentialsFixture>;   // createSecretsFixture plus the issuer identity
export function issueFor(fixture: CredentialsFixture, env: EnvName, body?: { name?: string; ttlSeconds?: number }): Promise<{ credentialId: string; token: string; operationId: string }>;
export function machineAccessors(fixture: CredentialsFixture, environmentId: string): Promise<{ accessor: string; meta: Record<string, string> | null }[]>;   // root token: list, lookup, keep policy machine-env-<id>
export function expectCatalogMatchesBackend(fixture: CredentialsFixture, environmentId: string): Promise<void>;
```

Design fixed here (P-85 … P-88, P-95; Doc 06 §7.3; FR-1.39, FR-1.41, FR-1.43):

- **Contract commit** `contract: machine credentials`. One schema `credentialView`: `{ credentialId, name, projectId, environmentId, state, issuedBy, issuedAt: string | null, expiresAt: string | null, expiringSoon: boolean, lastUsedAt: string | null }` — `state` is the stored state, except that a stored `active` past its expiry is shown as `expired`; `issuedAt` is the completion time of the issuance operation. `credentials.issue`: `201 { operationId, credential: credentialView, token: z.string().min(1) }`. `credentials.list`: page query; `200 { credentials: credentialView[], nextCursor: string | null }`. `errors.ts` / `respond.ts`: `credential_not_replayable` takes details `{ credentialId: uuid, state: <the six states> }`. `tests/unit/contracts/token-fields.test.ts` walks every response schema of `ROUTES` and finds a string field named `token` (or `secretId`, `accessor`, `client_token`) in exactly one place: the 201 of `credentials.issue`.
- **Migration `0013`** as P-86. Nothing else: `issued_at` is not a column, it is read from the operation.
- **`issueCredential`** follows P-87 to the letter. Details the table does not carry:
  - The lock is taken first (`Busy` → refused `busy`); the issuer session second (`null` → `dependency_unavailable`; a failed login → `backend_sealed` for `sealed`, otherwise `dependency_unavailable`); `close()` runs in `finally`, inside the lock.
  - The marker transaction runs on `locked.client`. It inserts the operation directly as `executing` with this boot id, `dispatched_at` and `heartbeat_at` at `now()`, `environment_id`, `project_id`, and `expected: { credentialId }`; a key that exists → `replay` or refused `idempotency_conflict`, as `beginOperation`. `insertIssuing` answering `blocked` rolls the transaction back and answers `state_conflict` with `blockingIssuance`'s operation id. `request.recheck` is the caller's part (authority, `checkStates`); the function itself re-reads capture mode, the gate and `kv_ready`.
  - After the marker the function never throws to its caller: a `try` around steps (c)–(e) turns any exception, and `locked.lost()`, into `{ kind: "unknown" }` after trying one transaction on the **main** pool that sets the operation `uncertain` and the credential `needs_review` (`moveCredential` from `issuing`); when that transaction fails too, the sweep does it (Run 5.2).
  - The token is a local of this function and of the handler that answers. It is not put on `ctx`, not on the operation's `result`, not into an `Error`.
- **The handler** maps `issued` → 201 with `cache-control: no-store`; `replay` → `replayAnswer`; `refused` → `ApiError`; `unknown` → `503 outcome_unknown` with `operationId`. `replayAnswer` gains the one special row of P-88: a `succeeded` row of route `credentials.issue` → `{ error: "credential_not_replayable", operationId }`, and the pipeline's replay step adds the details from `findCredentialByOperation`.
- **State class `credential_issue`** (`states.ts`): project and environment `active`, environment `kv_ready`; `pending` → the code it answers today; `revoking`, `archived` → `409 state_conflict`; `needs_review` → `503 backend_inconsistent`.
- **Inventory** (`credentials.list`): rows of the path's environment, without the rows that are `revoked` with a null accessor; newest issuance first; paged like `operations.list` (anchor in the cursor, never `listing_changed`). No accessor in the body.
- **`AppDeps`** gains `issuer?: IssuerBao`. `startServer` builds it beside `bao`. A credential route on a process without it answers `503 dependency_unavailable`. `status.sh` gains `issuerLogin` from the start-up self-check's log line, as `runtimeLogin`.

### Task A — the issuer identity and what a token says about itself

- [ ] **Step 1 — Failing tests** (`tests/integration/openbao/issuance.test.ts`, added cases; `createOrgFixture`):
  - `meta given at creation comes back from lookup-accessor and lookup-self` — `{ credential_id, operation_id }` with two fresh UUIDs; the token's policies, orphan flag and type are unchanged by it.
  - `TokenInfo carries creation ttl, uses, expiry and issue time` — ttl 120: `creationTtlSeconds` 120, `numUses` 0, `expireTime` between 118 and 122 s after `issueTime`.
  - `a role whose maximum is shorter gives a shorter token` — the role's `token_max_ttl` set to 60 by the root token (restored in `finally`); requested 120 → `creationTtlSeconds` 60.
  - `issuerBaoFromDirectory`: `open` answers a session whose client can look up an accessor; after `close()` the same client answers `denied`; a directory without the files answers `null`; a wrong secret id answers a failed `BaoResult`, not a throw.
  - `checkIssuedToken` (unit, `tests/unit/operations/credentials-verify.test.ts`): one case per `TokenFault`, a passing case, and `ttl`: 60 for a request of 120 passes, 0 and 121 fail.
  - `revokeAndVerify` against the stack: an unknown accessor → `absent`; a live token → `absent` and the token is dead; OpenBao stopped → `not_sent`; with the relay dropping the lookups → `unproven`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(openbao): token metadata and lifetime fields; issuer sessions`.

### Task B — the record and the protocol

- [ ] **Step 1 — Failing tests** (`protocol.test.ts`; `createCredentialsFixture`; `issueCredential` called through the route with the harness's fault hook; every test ends with `expectCatalogMatchesBackend` unless it says what it expects instead):
  - `a throw at after_marker, after_create_sent, after_verify and before_finalize_commit each answers 503 outcome_unknown with the operation id` — four cases; afterwards the credential is `needs_review`, the operation `uncertain`, and **the body holds no key `token`**.
  - `an unresolved issuance blocks the next one for that environment and no other` — `409 state_conflict` naming the first operation; an issuance for environment 1b at the same moment answers 201.
  - `two issuances for one environment at once never leave two rows issuing` — different keys, 20 rounds; each round ends with both `active`, or one `active` and one `busy`.
  - `a refused create leaves no token and frees the environment` — the issuer's policy loses `create` for the test (root token; restored in `finally`): `503 backend_inconsistent`, the operation `rejected`, the credential `revoked` with a null accessor, the environment `needs_review` with `system.drift_detected`; after the operator cleared the review a new issuance answers 201.
  - `a token that is not what was asked for is revoked, not delivered` — the token role is changed to `renewable: true` (root token; restored): no 201, the operation `rejected`, `machineAccessors` is empty, the environment in review.
  - `an archive that took precedence wins` — the hook at `after_verify` sets the environment to `revoking` (superuser): `409 state_conflict`, no `token` in the body, `machineAccessors` empty, the credential `revoked`.
  - `the environment's lock is held by a writer` — a secret write hangs at `after_dispatch_marker` in the second process: the issuance answers `503 busy` and no credential row exists.
  - `the issuer login fails` — OpenBao stopped (`stopService`, started again in `finally`): `503 dependency_unavailable`, no operation, no credential row.
  - `as api_runtime: a second issuing row for one environment is refused by the database` (SQLSTATE `23505`); `state` cannot be set to a value outside the six; `DELETE` is refused (`42501`).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Migration `0013`, repository, `issueCredential`.** **Step 4 — Run:** PASS; `pnpm run db:check`. **Commit** `feat(operations): machine credential issuance with a marker`.

### Task C — routes, replay, inventory, surfaces

- [ ] **Step 1 — Contract commit** (above). **Step 2 — Failing tests.**
  - `issue.test.ts`: `the owner with a fresh code issues: 201, no-store, a token once` — the token then lists its environment's names directly in OpenBao (control that it is real). `ttlSeconds` 0, −1, 1.5, `"60"` and 2,592,001 → 422; absent → 2,592,000. A session without a fresh code → the freshness answer of the pipeline (control: with one, 201). `adminA` issues; `editorA`, `readerA`, `envEditorA` are denied and `ownerB` gets the hidden 404 (the matrix's expectations). Environment `pending` → its state code; `archived` (superuser) → `409 state_conflict`. The shown expiry is the backend's: with the role's maximum at 60 and a request of 120, `expiresAt` is within 2 s of the token's `expire_time`.
  - `issue.test.ts`, replay: `the same key and body after success → 409 credential_not_replayable with credentialId and state active`, and after the credential was set to `revoked` the same replay says `revoked`; no replay body has a key `token`; the same key with another `ttlSeconds` → `409 idempotency_conflict`; `while the first is executing (hang at after_marker in process 1), the same request to process 2 → 202 with the envelope and no second credential row`.
  - `tests/unit/operations/replay.test.ts`: the new row of `replayAnswer`; the other routes' rows unchanged.
  - `inventory.test.ts`: the fields of `credentialView`; `the body's keys are exactly those of the schema` (no `accessor`, no `token`); `expiringSoon` true for a lifetime of one hour, false for 30 days; `a token past its expiry reads expired although the stored state is still active` (lifetime 2 s; wait on database time); rows of 1b are not in 1a's list; the never-issued row of Task B is not listed; 120 credentials page 50/50/20, newest first.
  - `surfaces.test.ts` (rule 1, rule 2): after three issuances, the bytes of each token are searched in a `pg_dump` of the database, in every line the API process wrote, in `audit.event`, in schema `jobs` and in OpenBao's audit device (`readAuditLog`, `raw`) — zero each; control: the credential id is found in the dump and in the log. `the 201 fails its output schema (a test-only handler wrapper drops credentialId)`: the log has `output_invalid` and not the token.
  - `tests/integration/authz/matrix.test.ts`: the rows of `credentials.list` and `credentials.issue` follow the contract.
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Implement.** **Step 5 — Run:** PASS; `pnpm run contracts:openapi`; `pnpm run check`. **Commit** `feat(api): issue a machine token once; credential inventory`. Start D-40 (issuance part).

**Registry:** `FR-1.39`, `FR-1.41` → `SPIKE_PASS` (run note). `FR-1.40` is asserted here for what was created and gets its status in Run 5.4 Task C. **Covers:** FR-1.39, FR-1.40, FR-1.41. **Done when:** no token bytes exist in PostgreSQL, logs, jobs or audit; a replayed successful issuance returns `409 credential_not_replayable`; a failure at any point after the marker delivers nothing.

---

## Run 5.2 — Revocation and uncertain issuance (D08-S27)

**Files:** `packages/contracts/src/routes.ts` (+ `openapi.json`), `packages/db/src/repos/{credentials,operations}.ts`, `packages/operations/src/credentials/{revoke,verify,sweep}.ts`, `packages/operations/src/reconcile/credentials.ts`, `packages/operations/src/{index,operator}.ts`, `apps/api/src/{operation-sweep,app}.ts`, `apps/api/src/pipeline/states.ts`, `apps/api/src/routes/credentials.ts`, `apps/ops/src/commands/reconcile-credentials.ts`, `apps/ops/src/cli.ts`, `tests/harness/{api-process,credentials-fixture}.ts`, `tests/integration/credentials/{revoke,sweep,reconcile}.test.ts`, `tests/fault/credentials/{fixture,issuance,revocation}.test.ts`, `tests/staging/credentials.staging.test.ts`, `docs/runbooks/{machine-credentials,reconciliation}.md`, `docs/evidence/session-5/fault-table.md`.

**Consumes:** Run 5.1 (everything it produces, `revokeAndVerify` among it); Session 4: `sweepStaleOperations` and its tick, the `ops` frame and `reconcile-operation`'s exit codes, `host.ts <host> quiesce | resume`, `tests/fault/secrets/fixture.ts` (the pattern: two API processes, the TLS relay in front of OpenBao, `FaultAction`), `countOnHost`, `stagingOwnerSession`, `publicRequest`.

**Produces:**

```ts
// @mykey/operations — credentials/revoke.ts
export interface RevokeRequest { routeId: string; scope: EnvironmentScope; userId: UserId; credentialId: CredentialId; idempotencyKey: string; intent: Intent; requestId: string;
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null> }
export type RevokeOutcome = { kind: "revoked" | "replay"; operation: OperationRow } | { kind: "refused"; code: ErrorCode; operationId?: OperationId } | { kind: "unknown"; operationId: OperationId };
export function revokeCredential(deps: CredentialDeps, request: RevokeRequest): Promise<RevokeOutcome>;
// @mykey/db — repos/operations.ts
export function settleRevocations(tx: pg.PoolClient, credentialId: CredentialId, retentionDays: number): Promise<OperationId[]>;   // uncertain revoke operations whose step targets it → succeeded
// @mykey/operations — credentials/sweep.ts
export function sweepCredentials(pool: pg.Pool, opts?: { staleSeconds?: number }): Promise<{ uncertain: OperationId[]; expired: number }>;
// @mykey/operations/operator — reconcile/credentials.ts
export interface CredentialReconciliation { unrecordedRevoked: number; revocationsCompleted: number; issuancesSettled: number; left: { credentialId: CredentialId; reason: "needs_exclusion" | "unproven" }[] }
export function reconcileCredentials(deps: { pool: pg.Pool; admin: OpenBaoAdmin }, request: { organizationId: OrganizationId; environmentId: EnvironmentId; executorsExcluded: boolean; operator: string }): Promise<CredentialReconciliation>;
```

Design fixed here (P-89, P-90; Doc 06 §7.3; FR-1.42, FR-1.43):

- **Contract commit** `contract: credential revocation`: `credentials.revoke` answers 200 with the operation envelope, `result: { credentialId, state: "revoked" }`.
- **`revokeCredential`** follows P-89. `not_sent` from `revokeAndVerify` → the operation `rejected` with `dependency_unavailable`; the credential stays `revoking` in every outcome but `absent`. The finalizing transaction runs on `locked.client`; a failure there is `unknown`.
- **State class `lifecycle` for `credentials.revoke`** (`states.ts`): the organization's check as today; project and environment may be in **any** state — a revocation must work in an environment that is in review, `revoking` or `archived`.
- **`sweepCredentials`** is called by the tick after `sweepStaleOperations`; its three statements are those of P-90, each a conditional update returning the rows it changed, each row with one `system.operation_stuck` audit row. Two sweepers at once produce one audit row per operation.
- **`ops reconcile-credentials`** runs as `maintenance` with the OpenBao authority `verify-organization` uses. Order: (1) accessors of the namespace → lookup each → keep those with the policy `machine-env-<environmentId>`; (2) each kept accessor that is not the accessor of an `active`, unexpired row → `revoke-accessor`, lookup must answer 400 → counted in `unrecordedRevoked`; the `meta.operation_id` of each is remembered; (3) each `revoking` row with an accessor → revoke, verify → `revoked`, `settleRevocations`; (4) each `needs_review` row → `revoked` and its operation `rejected` (`dependency_unavailable`) when its operation id was among those remembered in (2) **or** `executorsExcluded`; otherwise it is listed in `left` with `needs_exclusion` and the command exits 3 after doing everything else; (5) one audit row `operator.reconcile_credentials` with the four counts. It prints ids and counts, never an accessor.
- **Runbook `machine-credentials.md`**: issue, inventory, revoke, what `revoking` and `needs_review` mean, the lost-delivery procedure of FR-1.43 (replay → `credential_not_replayable` → revoke that id → issue with a new key), and the residual of FR-1.45 in its own section. `reconciliation.md` gains "Credentials": when to run the command, when it asks for `quiesce`.

### Task A — revocation

- [ ] **Step 1 — Contract commit.** **Step 2 — Failing tests** (`revoke.test.ts`):
  - `revoke: 200, the credential reads revoked, the accessor answers 400 in OpenBao, and the token is denied there` (control before: the token lists its names).
  - `the denied state is committed before the backend is asked` — a hang at `after_revoke_marker`: from a second connection the row is `revoking` while OpenBao still accepts the token.
  - `revoking is never shown as revoked` — OpenBao paused (`pauseService`) during the revoke: `503 outcome_unknown`; the inventory says `revoking`; after `startService`, a **new** revoke request (new key) answers 200, the credential is `revoked`, and the first operation now reads `succeeded`.
  - `a refusal is not a revocation` — the issuer's policy loses `revoke-accessor` (root token; restored): the operation `rejected` with `backend_inconsistent`, the credential `revoking`, the token still alive in OpenBao (the control that nothing pretended).
  - `OpenBao stopped before the call: rejected dependency_unavailable, the credential revoking`.
  - `revoke of an expired credential succeeds; of a revoked one → 409 state_conflict; of one in needs_review → 409 state_conflict with the issuance's operation id`.
  - `a second revoke while the first is executing (hang) → 409 state_conflict with the first operation's id`; replay of a finished revoke → 200 with the same envelope and no second call to OpenBao (the audit device shows one `revoke-accessor` for that accessor).
  - `revocation works in an environment that is in review, and in one that is archived` (states set by the superuser).
  - `adminA` revokes; `editorA` is denied; `ownerB` and a credential id of environment 1b on 1a's path get the hidden 404.
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Implement.** **Step 5 — Run:** PASS. **Commit** `feat(api): revoke a machine credential, denied first and verified`.

### Task B — the fault table (AC-1.40)

- [ ] **Step 1 — Failing tests** (`tests/fault/credentials/`; two API processes, OpenBao behind the TLS relay; after every case `machineAccessors` is compared with the catalog). `issuance.test.ts`, one case per row:

  | Boundary | Fault | True afterwards |
  | --- | --- | --- |
  | before the marker commits (`after_issuer_login`) | process killed | no operation, no credential, no token; the same key issues normally |
  | `after_marker` | process killed | rows `executing` / `issuing`, no token; after the sweep `uncertain` / `needs_review`; a new issuance for the environment → `409 state_conflict`; `reconcile-credentials` without the flag exits 3 and changes nothing; with it → `revoked` / `rejected`; then a new issuance → 201 |
  | create sent | the relay drops the answer | `503 outcome_unknown`; exactly one machine accessor exists and no row names it; `reconcile-credentials` **without** the flag revokes it (its `meta` names the operation), settles, exits 0; no accessor left |
  | create sent | the relay holds the request 10 s past the deadline, then lets it through | `503 outcome_unknown`; the token appears late; the same end as the row above |
  | `after_create_sent`, `after_verify`, `before_finalize_commit` | process killed (three cases) | as "create sent / dropped" after the sweep |
  | `after_finalize` | process killed (the answer is never sent) | the credential is `active` and the catalog matches the backend with no operator; the replay answers `409 credential_not_replayable` with the id; revoking that id → `revoked`; a new key issues |

  `revocation.test.ts`: killed at `after_revoke_marker` (the token still works in OpenBao; the row is `revoking`; after the sweep the operation is `uncertain`; a new revoke request finishes it); the relay drops the answer of the revoke (the token is in fact dead; `503 outcome_unknown`; the row `revoking`; a new request → `revoked`); killed at `before_revoke_finalize_commit` (the same). In every case: at no moment after the marker does a row read `active`.
  - `no replay in any row creates a second token`: each case ends by sending the original request again and counting `machineAccessors`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** (the fault points in `api-process.ts`, the fixture). **Step 4 — Run:** PASS, three times in a row (`--maxWorkers=2`). Write `docs/evidence/session-5/fault-table.md`: the table with the test name of each row and its result. **Commit** `test(fault): credential issuance and revocation at every boundary`.

### Task C — the sweep and the operator's inventory

- [ ] **Step 1 — Failing tests.**
  - `sweep.test.ts`: `an issuance executing for more than the stale time → uncertain, its credential needs_review, one system.operation_stuck`; a fresh one is untouched; a revocation likewise with the credential left `revoking`; `two sweepers at once: one audit row`; `an active row past its expiry → expired`; `the executor that comes back late cannot finalize` (`finishOperation` answers null and `activateCredential` false: no row becomes `active` after the sweep).
  - `reconcile.test.ts`: `a token with the environment's machine policy that no row names is revoked and counted` (made by the test with the issuer credential); `the login tokens of the namespace's AppRoles are in the accessor list and are left alone` (control: a secret write and a provisioning check still work afterwards); `an active credential is untouched and its token still reads`; the exit-3 rule; `a second run changes nothing and says so`; one audit row with counts; the output holds no accessor and no token.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; the runbooks. **Commit** `feat(ops): credential sweep and reconcile-credentials`.

### Task D — staging

- [ ] **Step 1 — Deploy** to staging (announce the window): `docker build … --build-arg MYKEY_BUILD=$(git rev-parse --short=12 HEAD)`, `docker save` one tag, `host.ts staging image`, migrations, `up`, gate open. `status`: `issuerLogin: ok`, `runtimeLogin: ok`, `operationsUnresolved: 0`.
- [ ] **Step 2 — Failing test** `tests/staging/credentials.staging.test.ts` (own project and environment; everything revoked in `finally`): issue with a lifetime of 300 s → the inventory shows it → the replay answers `409 credential_not_replayable` → revoke → the inventory says `revoked`. On the host (`countOnHost`, the token on fd 3): the token's bytes in the API's log, a `pg_dump` and Traefik's access log → 0 each, with the controls found.
- [ ] **Step 3 — The drill** (announce it; record the times of the Telegram message and of its clearing): one issuance is left unresolved the way the drill of `tests/staging/reconcile.staging.test.ts` leaves a write unresolved — read it first. If its method does not carry over, stop the `api` container about 150 ms after sending an issuance for a fresh environment, at most ten times, until one operation is left `executing`; record how many attempts it took. Then: the alert `operations_unresolved`; `host.ts staging quiesce`; `ops reconcile-credentials --environment <id> --executors-excluded yes`; `resume`; a new issuance for that environment answers 201 and is revoked; the alert clears.
- [ ] **Step 4 — Run:** PASS. **Commit** `test(staging): credential issuance, revocation and the inventory drill`. Finish D-40.

**Registry:** `FR-1.42`, `FR-1.43`, `AC-1.40` → `SPIKE_PASS` (run note; AC-1.40 names `fault-table.md`). **Covers:** FR-1.42, FR-1.43; AC-1.40. **Done when:** losing the response at each boundary never yields a token nobody knows about that still works; `revoking` is never displayed as revoked.

---

## Run 5.3 — Archive and reactivate (D08-S28)

**Files:** `packages/contracts/src/routes.ts` (+ `openapi.json`), `packages/db/migrations/0014_resource_lifecycle.sql`, `packages/db/src/repos/lifecycle.ts`, `packages/db/src/index.ts`, `packages/operations/src/lifecycle/{archive,reactivate}.ts`, `packages/operations/src/index.ts`, `apps/api/src/{operation-sweep,app}.ts`, `apps/api/src/pipeline/states.ts`, `apps/api/src/routes/lifecycle.ts`, `tests/harness/{api-process,privilege-matrix}.ts`, `tests/integration/lifecycle/{transitions,archive,reactivate}.test.ts`, `tests/fault/credentials/archive.test.ts`, `tests/staging/archive.staging.test.ts`, `docs/decisions/D-41-archive-and-reactivate.md`, `docs/runbooks/{machine-credentials,db-globals-inventory}.md`.

**Consumes:** Runs 5.1, 5.2 (`revokeAndVerify`, `moveCredential`, `IssuerBao`, `CredentialDeps`, `machineAccessors`, `expectCatalogMatchesBackend`); Session 4 (`withEnvironmentLock`, `slotOf`, the tick); Session 3 (`mutate`'s frame in `routes/resources.ts`, `beginOperation`, `completeOperation`, `lockParents`).

**Produces:**

```ts
// @mykey/db — repos/lifecycle.ts
export type LifecycleStep = "begin_archive" | "finish_archive" | "reactivate";
export function lifecycleTransition(tx: Queryable, t: { kind: "project" | "environment"; organizationId: OrganizationId; id: string; operationId: OperationId; step: LifecycleStep; origin?: "self" | "project" }): Promise<boolean>;   // SELECT app.lifecycle_transition(…); false: the guard did not hold
export function archiveScope(db: Queryable, operationId: OperationId): Promise<{ kind: "project" | "environment"; id: string; environments: EnvironmentScope[] } | null>;   // what an archive operation covers, from the rows
export function closeCredentials(tx: Queryable, scope: EnvironmentScope): Promise<number>;      // active, expired → revoking
export function openCredentialWork(db: Queryable, scope: EnvironmentScope): Promise<{ revoking: CredentialRow[]; blocking: number }>;   // blocking: issuing or needs_review
// @mykey/operations — lifecycle/archive.ts
export const ARCHIVE_FAULT_POINTS = ["archive_after_marker", "archive_after_revoke_sent", "archive_before_finish_commit"] as const;
export interface LifecycleDeps extends Omit<CredentialDeps, "faults"> { bao: RuntimeBao;
  faults?: (point: (typeof ARCHIVE_FAULT_POINTS)[number], operationId: OperationId) => void | Promise<void> }
export interface ArchiveRequest { routeId: string; kind: "project" | "environment"; organizationId: OrganizationId; projectId: ProjectId; environmentId?: EnvironmentId;
  userId: UserId; idempotencyKey: string; intent: Intent; requestId: string; recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null> }
export type ArchiveStart = { kind: "started" | "replay"; operation: OperationRow } | { kind: "refused"; code: ErrorCode; operationId?: OperationId };
export function beginArchive(deps: LifecycleDeps, request: ArchiveRequest): Promise<ArchiveStart>;
export function driveArchive(deps: LifecycleDeps, operationId: OperationId): Promise<"archived" | "waiting">;   // compare-then-act; safe to call again, and from two processes at once
export function continueArchives(deps: LifecycleDeps, opts?: { staleSeconds?: number }): Promise<{ archived: OperationId[]; waiting: OperationId[] }>;
// @mykey/operations — lifecycle/reactivate.ts
export type ReactivateOutcome = { kind: "reactivated" | "replay"; operation: OperationRow } | { kind: "refused"; code: ErrorCode; operationId?: OperationId };
export function reactivate(deps: LifecycleDeps, request: ArchiveRequest): Promise<ReactivateOutcome>;
```

Design fixed here (P-91, P-92; Doc 06 §7.1; FR-1.17, FR-1.18):

- **Contract commit** `contract: archive and reactivate`. The four routes answer 200 with the operation envelope; archive may answer 202. Results: archive `{ state: "archived" | "revoking", environments: int, credentialsRevoked: int }`; reactivate `{ state: "active", environments: int }`.
- **Migration `0014`**: the function of P-91 and nothing else. Its guards, all in one statement per step so that a concurrent caller sees `false`: `begin_archive` — the row is `active`; for an environment with origin `project`, its project is `revoking` with the same operation. `finish_archive` — the row is `revoking` with this operation, and no credential of the row's scope (an environment; or every environment of a project) is in a state other than `revoked`; for a project it also moves the environments that are `revoking` with this operation. `reactivate` — the row is `archived`; an environment needs its project `active` and origin `self`, or origin `project` with the operation given being the project's reactivation that has just moved the project. A step outside the three raises. The privilege matrix records: `EXECUTE` for `api_runtime`, nobody else; `api_runtime` still has no `UPDATE` on `project.state`, `environment.state`, `archive_origin`, `archive_operation_id`.
- **The scope of a project archive** is every environment of the project, whatever its state: the credentials of an environment that is `needs_review` or already `archived` are closed and revoked too; only the **state** of such an environment is left alone.
- **`driveArchive`** reads everything from rows (`archiveScope`, `openCredentialWork`); it holds no memory between calls. It stops at the first environment it cannot finish and answers `waiting`. The finishing transaction calls `finish_archive` and, only when that answers true, `finishOperation` (`succeeded`) and the audit row; when it answers false because another driver was faster, it answers `archived` without writing anything.
- **`continueArchives`** selects operations with `action IN ('projects.archive', 'environments.archive')`, `state = 'executing'` and a heartbeat older than the stale time; it claims nothing and changes no boot id — two processes driving one archive is allowed. `finishOperation`'s boot-id condition is therefore not usable here: the archive's finish is a dedicated conditional update (`state = 'executing'` → `succeeded`) in the repository, named `finishArchiveOperation`, used by nothing else.
- **State class `lifecycle`** for the four routes: archive needs the target `active` (anything else `409 state_conflict`; a target already `revoking` answers with its operation id); reactivate needs it `archived`. The organization's check as today.
- **Reactivation** follows P-92 in one request, without a marker: it sends nothing that changes the backend. The verification runs before the transaction; the transaction re-reads the states and calls `reactivate`.
- **Runbook**: `machine-credentials.md` gains "Archive and reactivate": what `revoking` means for a resource, that an archive which cannot finish keeps the alert up and why, that tokens never come back.

### Task A — the transition function

- [ ] **Step 1 — Failing tests** (`transitions.test.ts`; pools `api_runtime`, `maintenance`, superuser):
  - each step moves exactly its row and answers true; called again it answers false and changes nothing;
  - `as api_runtime, a direct UPDATE of project.state or environment.state is refused` (SQLSTATE `42501`) — control: the function works;
  - `the function never moves a row out of needs_review` (all three steps, both kinds);
  - `finish_archive answers false while one credential of the scope is active, expired, revoking, issuing or needs_review` (five cases) and true when all are `revoked`;
  - `begin_archive of an environment with origin project needs its project revoking under the same operation`;
  - `reactivate of an environment under an archived project answers false`; `a project reactivation moves only the children of its own archive operation`;
  - an unknown step raises; `provisioner_runtime`, `backup_reader` and `PUBLIC` cannot execute it.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Migration, repository.** **Step 4 — Run:** PASS; `pnpm run db:check`; privilege matrix and inventory. **Commit** `feat(db): lifecycle transitions through one guarded function`.

### Task B — archive

- [ ] **Step 1 — Contract commit.** **Step 2 — Failing tests** (`archive.test.ts`; `createCredentialsFixture`; three credentials in 1a, one in 1b):
  - `environment archive: 200 archived; every credential revoked; every accessor answers 400; the policy, the token role and the stored secrets are still there`; the result counts.
  - `from revoking on, nothing is admitted` — the drive hangs after the marker (fault `archive_after_marker`): a secret write, a reveal, an issuance and an import preview on that environment each answer their state code; a secret read of environment 1b still works.
  - `project archive` over a project with an `active` environment, one archived on its own before, and one in `needs_review` (superuser): the project and the first are `archived` (origin `project`), the second keeps origin `self` and its own operation id, the third stays `needs_review`; the credentials of all three are `revoked`.
  - `a project with a pending environment → 409 state_conflict`; `an environment whose slot is held → 409 state_conflict with the holder's operation id`.
  - `a wrong confirmation → 422`; `editorA` is denied, `ownerB` gets the hidden 404 (the matrix's expectations).
  - `replay after success → 200 with the same result and no further revoke-accessor in OpenBao's audit device`.
  - `the lock is busy` — a secret write hangs with the lock: the archive answers 202, the environment is `revoking`; the writer is released; `continueArchives({ staleSeconds: 0 })` → `archived`, and the operation's status route says `succeeded`.
  - `a revocation cannot be proven` — OpenBao paused during the drive: 202; started again; the tick finishes it; one `success` audit row.
  - `a credential in needs_review blocks the end, not the closing` — the environment is `revoking` and stays so; the unresolved-operations count of `status.sh`'s query is at least one after the stale time; after `ops reconcile-credentials … --executors-excluded yes` the next tick answers `archived`.
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Implement** (`beginArchive`, `driveArchive`, `continueArchives`, the handlers, the tick). **Step 5 — Run:** PASS; `pnpm run contracts:openapi`. **Commit** `feat(api): archive closes first, revokes and verifies, then says archived`.

### Task C — reactivate

- [ ] **Step 1 — Failing tests** (`reactivate.test.ts`):
  - `environment: 200 active; no credential is active; the old token is still denied by OpenBao and by the catalog; a new issuance works; the values read by the owner have the digests they had before the archive`.
  - `project: its project-origin children are active again; the one archived on its own stays archived`.
  - `an environment with origin project cannot be reactivated on its own → 409 state_conflict`; `an environment under an archived project → 409 state_conflict`.
  - Verification, each `503 backend_inconsistent` with the resource still `archived` and the operation `rejected`: the machine policy rewritten by the root token; a name written straight into OpenBao; a `revoked` row whose accessor still answers 200 (the superuser puts a live token's accessor into the row).
  - `reactivation sends nothing that changes OpenBao` — the audit device between the request's start and end holds reads only.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(api): reactivation verifies the backend and revives no token`.

### Task D — interruption and races (AC-1.11)

- [ ] **Step 1 — Failing tests** (`tests/fault/credentials/archive.test.ts`; two processes; fault points `archive_after_marker`, `archive_after_revoke_sent`, `archive_before_finish_commit`):
  - killed at each of the three points (three credentials; the second point after the first revocation): the second process's tick ends the archive; every accessor answers 400; exactly one `success` audit row.
  - **`an issuance racing an archive leaves no usable token`** — 50 rounds, issue and archive sent together with a random offset of 0–30 ms; when both have answered and the tick has run: `machineAccessors` is empty; every 201 that was answered names a credential that is now `revoked`, and its token's `lookup-self` in OpenBao answers 403.
  - `an environment created while its project is archived` — 20 rounds: afterwards there is never an `active` or `pending` environment under an `archived` project.
  - `the request and the tick drive one archive at once`: one `success` audit row, no error, every credential `revoked`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** what fails. **Step 4 — Run:** PASS, three times in a row; add the rows to `fault-table.md`. Write D-41. **Commit** `test(fault): archive under interruption and in races`.

**Registry:** `FR-1.17`, `FR-1.18`, `AC-1.11`, `PO-18` → `SPIKE_PASS` (run note). **Covers:** FR-1.17, FR-1.18; AC-1.11; PO-18. **Done when:** an issuance racing an archive cannot leave a usable token; an interrupted archive ends without an operator when nothing is unresolved, and keeps the alert up when something is.

---

## Run 5.4 — Machine API (D08-S29)

**Files:** `packages/contracts/src/{routes,authz}.ts` (+ `openapi.json`), `packages/operations/src/secrets/read-environment.ts`, `packages/operations/src/index.ts`, `apps/api/src/runtime-bao.ts`, `apps/api/src/pipeline/{machine,route,authn,authz,context}.ts`, `apps/api/src/routes/machine.ts`, `apps/api/src/app.ts`, `tests/harness/{api,api-process,credentials-fixture}.ts`, `tests/integration/machine/{authentication,keys,resolve,native-scope}.test.ts`, `tests/integration/read/{complete,limits,race}.test.ts` (the request's shape only), `tests/integration/authz/matrix.test.ts`, `tests/staging/{machine,archive}.staging.test.ts`, `docs/decisions/D-42-machine-requests.md`, `docs/evidence/session-5/native-scope.md`, `docs/runbooks/machine-credentials.md`.

**Consumes:** Runs 5.1–5.3; Session 4: `readEnvironment`, `ReadDeps`, `Refused`, `backendRefusal`, `LargeGate` (`large.run`), `readDeps`, `refusedOf`, `appendAudit`, the race helper of `tests/integration/read`.

**Produces:**

```ts
// apps/api — pipeline/authn.ts, pipeline/machine.ts
export interface MachinePrincipal { kind: "machine"; credentialId: CredentialId; scope: EnvironmentScope; /** Built from the presented token; this request only. */ reader: OpenBaoClient }
export type Principal = UserPrincipal | MachinePrincipal;                     // UserPrincipal: today's Principal
export function authenticateMachine(deps: AppDeps, request: Request, params: Record<string, string>, requestId: string): Promise<MachinePrincipal>;   // throws ApiError (P-93)
// @mykey/operations — secrets/read-environment.ts
export interface EnvironmentReadRequest { scope: EnvironmentScope; routeId: string; requestId: string;
  recheck: (tx: pg.PoolClient) => Promise<ErrorCode | null>;
  audit: (tx: pg.PoolClient, read: { names: number; generation: bigint }) => Promise<void>;
  /** A machine request: every backend read uses this client and deps.bao is never asked. */ reader?: { client: OpenBaoClient; alive: () => Promise<boolean> } }
export type EnvironmentNamesOutcome = { kind: "ok"; generation: bigint; names: string[] } | Refused;
export function readEnvironmentNames(deps: ReadDeps, request: EnvironmentReadRequest): Promise<EnvironmentNamesOutcome>;
```

Design fixed here (P-93, P-94; Doc 06 §7.3, §8; FR-1.44, FR-1.45):

- **Contract commit** `contract: machine keys and resolve`. `machine.keys`: `200 { apiMajor, environmentId, generation, count, names: string[], complete: z.literal(true) }`. Both machine routes list exactly the errors P-93 and P-94 can answer: `mixed_authentication`, `unauthenticated`, `action_denied`, `forbidden_selector`, `not_found`, `quarantined`, `environment_changed`, `key_under_review`, `busy`, `capacity_exceeded` (resolve), `audit_unavailable`, `backend_sealed`, `backend_inconsistent`, `dependency_unavailable`. Neither takes a query or a body schema: selectors are refused before validation.
- **The pipeline** (`route.ts`): for auth class `machine`, after the mixed-credential check and the gate: `authenticateMachine`; then the selector rule; no Origin check, no `authorize` (the binding is the authorization), no replay, no freshness. `intentOf` and every place that reads `principal.userId` take the union; a machine principal reaching a human-only helper is a type error, not a run-time branch.
- **`authenticateMachine`** in the order of P-93. The catalog lookup and the path resolution are one statement: the credential by `(organization_id, accessor)` joined to its environment and project, returning their states and the environment's name; the path's `:project` and `:envName` are compared with the row in code. `reader` is `deps.bao.withToken(organizationId, token)`. The function's local `token` is not stored anywhere else.
- **`readEnvironment`**: `const bao = request.reader?.client ?? deps.bao.clientFor(…)`; the `userId` field goes (nothing reads it; the callers' closures carry the actor). The `denied` rule of P-94 sits in one helper used by the list and by each read. Nothing else in the function's order changes — Run 4.8's tests must pass untouched.
- **`readEnvironmentNames`** shares steps 1, 2 and 5 of `readEnvironment` (lock, recheck, slot, review, names compared, generation rechecked, the caller's audit row) and skips the value reads; it returns the names of the rows in state `live`, in bytewise order.
- **The handlers** (`routes/machine.ts`): `recheck` re-reads the credential `FOR SHARE` (`active`, unexpired → otherwise `unauthenticated`), the parents (`action_denied` / `backend_inconsistent` as P-93) and the gate. `alive` is `reader.tokenLookupSelf()` answering `ok`. `resolve` runs inside `large.run`. `generation` is a decimal string, as in the human routes. The body is serialized once into a `Buffer`; `content-length` is its length.
- **FR-1.45** is written, not coded: `machine-credentials.md` "What a machine token can read" and the reference's description of the machine routes say that OpenBao's own policy also covers older undeleted versions of a key, that the product API serves current values only, and that OpenBao is reachable only from the service's private network.

### Task A — authentication

- [ ] **Step 1 — Contract commit.** **Step 2 — Failing tests** (`authentication.test.ts`; `createCredentialsFixture`; a token for 1a, one for 1b):
  - `a valid token: 200` on both routes.
  - Malformed, each `401 unauthenticated` **with no request to OpenBao** (the audit device gains no `lookup-self`): no header; scheme `Basic`; two `Authorization` headers; an empty token; 4,097 bytes; a token with a space or a control character.
  - `a cookie beside the bearer → 400 mixed_authentication` (controls: each alone).
  - Tokens that are real but not credentials, each 401: the login token of the `runtime` AppRole, of the `issuer`, and a token with 1a's machine policy made outside the product (no row).
  - `the token of 1a on the path of 1b, of project 2, of an absent project id and of an absent environment name: four answers that are equal` (the helper of `concealment.test.ts`: status 404, header names, body but for `requestId`, length).
  - Credential states, each 401: revoked through the product; expired (lifetime 2 s); `effective_expires_at` put into the past by the superuser while OpenBao still accepts the token (the product's own check).
  - Parents: environment `revoking` (superuser) → `403 action_denied`; `needs_review` → `503 backend_inconsistent`; the organization in review → 503; the gate closed → `quarantined`.
  - Selectors, each `400 forbidden_selector`: `?version=1`, `?history=true`, `?name=A`; body `{"version":1}`, `{"names":["A"]}`; an empty body and `{}` are accepted by `resolve`.
  - `a bearer on a human route → 401`; `a complete human session on a machine route → 401`.
  - `OpenBao stopped → 503 dependency_unavailable`, never 401.
  - `last_used_at is written by the first request and not again within the minute`.
  - Audit: the recognized denials above wrote one `access.denied` each with actor kind `machine` and the credential id; the unattributable ones wrote none.
  - `matrix.test.ts`: both machine routes with each of the seven fixture users' sessions → 401.
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Implement.** **Step 5 — Run:** PASS. **Commit** `feat(api): machine authentication by the presented token`.

### Task B — keys and resolve

- [ ] **Step 1 — Failing tests** (`keys.test.ts`, `resolve.test.ts`; values seeded by the owner; value comparisons by digest):
  - `resolve returns exactly the live set`: names, value digests equal to those of the owner's export; a deleted name is absent; `count`, `complete: true`, `generation` equal to the environment's; the body's byte length equals `content-length`; `cache-control: no-store`; no `content-encoding` although the request sent `accept-encoding: gzip`.
  - `keys returns the live names in bytewise order and nothing else` (the body's keys are those of the schema).
  - **`the reads are made with the presented token`** (Review focus 2): the API runs with a runtime secret id OpenBao refuses (`runtime: "broken"`): machine `keys` and `resolve` answer 200 while the owner's reveal answers its backend refusal (control); in OpenBao's audit device every KV request of the two machine calls carries the policy `machine-env-<id>`.
  - **`a token that dies mid-request is 401 and closes nothing`** (Review focus 3): the `beforeHandler` hook of Run 4.1 (it runs after authentication) revokes the token directly in OpenBao (root token): `401 unauthenticated`, no entry in the body, the environment still `active`, no `system.drift_detected`, and the owner's export right after answers 200.
  - `a live token whose policy cannot read is drift` — the machine policy is replaced by one without `read` (root token; restored): `503 backend_inconsistent`, the environment `needs_review` — the other branch of the same rule.
  - `the credential is revoked through the product between authentication and the recheck` (hook): 401, no entry.
  - `an unresolved write holds the slot → 409 key_under_review with the holder's operation id`; `a key in review → 409 key_under_review`.
  - `a writer races the read` — 50 rounds with a concurrent update: every 200 body is the complete set of one generation (the digest set equals the one before or the one after).
  - `the audit row is committed before the body leaves`: a throw at `before_audit_commit` → `503 audit_unavailable` and no entry; the lock's session terminated after the reads → `503 dependency_unavailable`; on success one `machine.resolve` row with actor kind `machine`, the credential id, `names` and `generation`, and no name of a secret.
  - `current values only`: after an update, `resolve` returns the new digest; version 1 is reachable by no request (the selector cases of Task A are the proof).
  - `1,000 names of 8 KiB resolve inside the deadline`; `three resolves at once: the third answers 503 busy`.
  - `tests/integration/read/{complete,limits,race}.test.ts` (Run 4.8) pass without a change to their assertions (only the removed `userId` field of the request).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; `pnpm run contracts:openapi`. **Commit** `feat(api): machine keys and resolve read with the machine's own token`.

### Task C — the token against OpenBao itself (PO-2, FR-1.40)

- [ ] **Step 1 — Failing test** `native-scope.test.ts`: a token **issued by the product** for 1a, used directly against OpenBao (`baoFetch` with the namespace and the token). Every denied call has a control that the same call succeeds with the root token, so a 403 is a denial and not a wrong path.
  - Allowed: read `kv/data/p/<project>/e/<1a>/<name>`; list `kv/metadata/p/<project>/e/<1a>/`; `auth/token/lookup-self`.
  - Denied (403): create, update and patch of a value; `DELETE` of data; `kv/delete`, `kv/undelete`, `kv/destroy`; write and delete of metadata; read and list of environment 1b and of a path in project 2; list of `kv/metadata/p/<project>/` and of `kv/metadata/`; `auth/token/create`, `create-orphan`, `create/<the machine role>`; `auth/token/lookup` and `lookup-accessor` for another token; `revoke-accessor`; `auth/token/revoke-self`; `sys/policies/acl` read, list and write; `sys/mounts`; `sys/auth`; `auth/approle/role/runtime`; `sys/namespaces`; `sys/capabilities-self`; `identity/entity/id`.
  - `auth/token/renew-self` does not extend the token: whatever status it answers, the lifetime read by `lookup-self` afterwards is not longer than before.
  - Another namespace: the same token with `X-Vault-Namespace: org-<B>` and with the root namespace → 403 for a read and for `lookup-self`.
  - **The residual, asserted as it is** (FR-1.45): after an update, `kv/data/…?version=1` with the machine token answers 200 directly in OpenBao; through the product API no request returns that version.
  - The test writes `docs/evidence/session-5/native-scope.md`: one line per call with its status.
- [ ] **Step 2 — Run:** FAIL (the file does not exist), then PASS; a call that is allowed where this list says denied is a finding — stop and write it into the run note before changing any policy. **Commit** `test(openbao): native scope of a product-issued machine token`.

### Task D — staging

- [ ] **Step 1 — Deploy** (announce the window), as Run 5.2 Task D Step 1.
- [ ] **Step 2 — Failing tests**, one file at a time, each with its own project and cleanup in `finally`:
  - `machine.staging.test.ts`: the owner seeds ten values → issues (300 s) → `resolve` through the public name: digests equal the owner's export → `keys` → revoke → `resolve` and `keys` answer 401 → the token sweep of Run 5.2 Task D Step 2 with this file's tokens.
  - `archive.staging.test.ts`: a project with two environments and a token each → project archive → both tokens answer 401 or 403 on the public name, and on the host both accessors answer 400 (`sshExec`, ids only) → project reactivation → the old tokens are still refused → a new token resolves → cleanup archives the project.
- [ ] **Step 3 — Run:** PASS; record the time of one `resolve` of ten values and of one issuance on staging. Write D-42. **Commit** `test(staging): machine access, archive and reactivation`.

**Registry:** `FR-1.44`, `FR-1.45`, `FR-1.40`, `AC-1.19` → `SPIKE_PASS`; `PO-2` stays `SPIKE_PASS` and gains this run's evidence line ("with the product's issuer") (run note). **Covers:** FR-1.44, FR-1.45; AC-1.19; PO-2. **Done when:** the token reads only its environment's current values through MyKey, and direct OpenBao write, delete, renew, token-create and cross-environment reads are all denied.

---

## Run 5.5 — CLI core and `keys` (D08-S30)

**Files:** `apps/cli/{package.json,build.ts}`, `apps/cli/src/{main,args,errors,config,guard,token,client,validate,keys,index}.ts`, `scripts/test-cli.ts`, `package.json` (scripts `cli:build`, `test:cli`), `infra/dependencies.lock.json`, `pnpm-lock.yaml`, `.gitignore` (`apps/cli/dist`, `apps/cli/release`), `vitest.config.ts` (project `cli`: its setup file), `tests/harness/cli.ts`, `tests/cli/{server,setup}.ts`, `tests/cli/{connection,keys}.test.ts`, `tests/cli/cli.test.ts`, `tests/unit/cli/{args,errors,config,guard,validate}.test.ts`, `tests/integration/machine/cli-client.test.ts`, `docs/decisions/D-43-cli-design.md`.

**Consumes:** Run 5.4 (the contract of `machine.keys` and `machine.resolve`, `issueFor`, `createCredentialsFixture`); `@mykey/contracts` (`API_MAJOR` or the constant `version.get` answers with, `resolveBody`, the keys body, the error envelope, `checkSecretName`, `LIMITS.body.bearerMaxBytes`); `apps/cli/src/index.ts` (the constants of D-08).

**Produces:**

```ts
// apps/cli/src/errors.ts
export type Category = "usage" | "malformed" | "unavailable" | "export_target" | "capacity" | "incompatible" | "denied" | "unsupported";
export const EXIT: Readonly<Record<Category, number>> = { usage: 64, malformed: 65, unavailable: 69, export_target: 73, capacity: 75, incompatible: 76, denied: 77, unsupported: 78 };
export class CliError extends Error { readonly category: Category; readonly code: string | null; readonly requestId: string | null;
  constructor(category: Category, text: string, from?: { code?: string; requestId?: string }) }
export function categoryOf(status: number, code: string | null): Category;                 // the HTTP half of P-96's table
export function formatError(error: CliError): string;                                       // the one stderr line; its text never quotes input
// args.ts
export type Command = { name: "keys"; tokenStdin: boolean } | { name: "run"; override: boolean; command: string; args: string[] }
  | { name: "export"; out: string; tokenStdin: boolean } | { name: "version" };
export interface Parsed { command: Command; project: string | null; env: string | null }
export function parseArgs(argv: readonly string[]): Parsed;                                  // throws CliError("usage")
// config.ts
export function resolveApiUrl(env: NodeJS.ProcessEnv, read: (path: string) => { text: string; mode: number; uid: number } | null, uid: number): URL;
export function selectorOf(parsed: Parsed, env: NodeJS.ProcessEnv): Selector;
// guard.ts
export function refuseUnsafeRuntime(p: { env: NodeJS.ProcessEnv; execArgv: readonly string[]; platform: string; arch: string; glibc: string | undefined }): void;
// token.ts
export function readToken(env: NodeJS.ProcessEnv, tokenStdin: boolean, stdin: NodeJS.ReadableStream): Promise<string>;
// validate.ts
export type ResolveBody = z.infer<typeof resolveBody>; export type KeysBody = /* the 200 of machine.keys */;
export function validateResolve(raw: Buffer, head: { status: number; contentLength: string | undefined; contentType: string | undefined; contentEncoding: string | undefined }): ResolveBody;
export function validateKeys(raw: Buffer, head: /* the same */): KeysBody;
// client.ts
export interface Selector { project: string; env: string }
export interface ApiClient { version(): Promise<{ apiMajor: number }>; keys(s: Selector, token: string): Promise<KeysBody>; resolve(s: Selector, token: string): Promise<ResolveBody> }
export function createClient(apiUrl: URL, opts?: { timeoutMs?: number; /** Adds trust, never replaces it; no flag or variable of the CLI reaches it. */ extraCa?: string }): ApiClient;
// main.ts
export interface Io { env: NodeJS.ProcessEnv; execArgv: readonly string[]; stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }
export function main(argv: readonly string[], io: Io): Promise<number>;
// tests/harness/cli.ts
export interface CliResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
export function runCli(args: string[], opts?: { env?: Record<string, string>; stdin?: string; cwd?: string }): Promise<CliResult>;
  // MYKEY_CLI_BIN when set, else node apps/cli/dist/secrets.mjs. `env` is the child's whole environment plus PATH. Throws when a token given in env or stdin appears in stdout or stderr.
// tests/cli/server.ts
export interface SeenRequest { method: string; path: string; hadAuthorization: boolean }       // never the header's value
export interface CliServer { url: string; caPath: string; requests: SeenRequest[]; close(): Promise<void> }
export function startCliServer(script?: ServerScript): Promise<CliServer>;                     // answers from the contract's schemas; `script` replaces or damages single answers
```

Design fixed here (P-96, P-97; Doc 06 §10; FR-1.46, FR-1.47, FR-1.79):

- **`API_MAJOR`.** `@mykey/contracts` exports `API_MAJOR = 1` and its schemas use it where they say `z.literal(1)` today (a commit titled `contract: api major as a constant`; the generated document must not change by a byte).
- **Build.** `apps/cli/build.ts` calls `esbuild` (`bundle`, `platform: "node"`, `format: "esm"`, `target` the pinned Node, no minification, no source map, a banner `#!/usr/bin/env node`) and writes `apps/cli/dist/secrets.mjs`. `apps/cli/package.json` gains a real `version` (`0.1.0`), `bin: { "secrets": "dist/secrets.mjs" }` and stays `private`. The version is compiled in (`define`).
- **Order in `main`**, the same for every command: `refuseUnsafeRuntime` → `parseArgs` → `resolveApiUrl` and `selectorOf` → `readToken` → `client.version()` → the command. Nothing touches the network before the first four passed. `--version` stops after the guard.
- **`createClient`.** One `https.request` per call with `agent: false`, `rejectUnauthorized: true` written out, a total deadline (`timeoutMs`, default 30 s for `version` and `keys`, 150 s for `resolve`), the body read to its end into one `Buffer` with a hard cap of `LIMITS.completeResponse.maxBodyBytes` + 64 KiB. A status 3xx is `CliError("unavailable")` and its `location` is never read. `version()` sends no `authorization`; a body that is not the version schema → `malformed`; another `apiMajor` → `incompatible`. `keys` and `resolve` call `version()` first when it has not succeeded in this process. Headers sent: `authorization: Bearer …`, `accept: application/json`, `accept-encoding: identity`, `user-agent: secrets/<version>`. An error status with a body that parses as the contract's error envelope → `CliError(categoryOf(status, code), …, { code, requestId })`; one that does not → the category of the status alone, `code: null`.
- **`validateResolve`**, every check a `malformed` error: status 200; `content-type` `application/json`; no `content-encoding`; `content-length` present and equal to the bytes read; the JSON parses; the contract's schema, strict; `complete === true`; `count === entries.length`; `apiMajor` equal to the CLI's; names unique and each passing `checkSecretName`. `validateKeys` the same with `names`.
- **`resolveApiUrl`.** `SECRETS_API_URL`, else the file of P-96; the file must be owned by the user and not writable by group or others, and hold exactly the key `apiUrl`. Refusals of P-96 (`unsupported`). No URL at all → `unsupported`.
- **`readToken`.** Exactly one source; one trailing `\n` or `\r\n` is dropped; an empty token, more than 4,096 bytes, or characters outside `A-Za-z0-9._-` → `usage`. With `--token-stdin` the whole of stdin is read and the stream is destroyed. No source → `usage`.
- **Categories the HTTP table does not cover** (planner's reading; Doc 04 §7 wins): a missing or doubled credential source, a missing selector, an unknown flag, `run` without `--` → 64; a name collision without `--override` → 64; a command that cannot be found or executed → 64; `E2BIG` → 75; any other spawn failure → 69.
- **`scripts/test-cli.ts`** (`pnpm run test:cli`): builds the bundle; on Windows first runs it natively and expects exit 78 with a line that names Windows; then, on Linux and macOS, `vitest run --project cli`; on Windows the same inside the pinned Node image: the working tree (`git ls-files -co --exclude-standard`) is copied into a Docker volume, `pnpm install --frozen-lockfile` runs there with a cached store volume, then the project. The project's setup (`tests/cli/setup.ts`) fails on Windows with the line of P-97, makes the certificate authority and the certificates once (`openssl`), and builds the bundle when `MYKEY_CLI_BIN` is not set.

### Task A — pure parts

- [ ] **Step 1 — Failing tests** (`tests/unit/cli/`):
  - `args.test.ts`: each command's happy form; `run` keeps everything after `--` untouched (`-- sh -c 'echo $X'` is one command and two arguments); an unknown command or flag, `--token x`, `--token=x`, `run` without `--`, `run --token-stdin`, `export` without `--out` → `usage`; **the error text of `--token <value>` does not contain the value**.
  - `errors.test.ts`: `EXIT` is exactly the eight numbers; `categoryOf` for 401, 403, 404, 409 with `environment_changed` and with `key_under_review`, 429, 503 with `busy`, `dependency_unavailable`, `backend_sealed`, `backend_inconsistent` and `quarantined`, 507, and an unknown status; `formatError` prints `requestId: none` and `code: none` for a local error and both values for a server error, on one line.
  - `config.test.ts`: the variable wins over the file; `http:`, userinfo, a fragment, a query → `unsupported`; a file with a second key (`token`), a file writable by group, a file owned by another uid → `unsupported`; nothing configured → `unsupported`; a selector flag wins over `SECRETS_PROJECT`.
  - `guard.test.ts`: each refusal of P-96 by its own case (`NODE_TLS_REJECT_UNAUTHORIZED=0`, `NODE_OPTIONS` set to anything, `NODE_USE_ENV_PROXY`, each of the six `execArgv` forms, `win32`, `linux` without a glibc version, `linux-riscv64`, `darwin-ppc64`); `NODE_EXTRA_CA_CERTS` alone passes; the four targets pass.
  - `validate.test.ts`: a good body passes; each check of `validateResolve` fails by its own case — among them a body cut at a JSON boundary that still parses with a `content-length` that says more, `count` one too high, `complete: false`, `complete` absent, a duplicate name, an entry without `value`, an extra top-level key, `content-encoding: gzip`, a missing `content-length`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement**; pin `esbuild` (advisory check; the version of the lockfile). **Step 4 — Run:** PASS. **Commit** `feat(cli): arguments, configuration, guards, error model, response validation`.

### Task B — the connection and `keys`

- [ ] **Step 1 — Failing tests** (project `cli`; `pnpm run test:cli`). `connection.test.ts` — each case asserts the exit code **and** that no request of `server.requests` had an authorization header, unless it says otherwise:
  - an `http://` URL → 78, and a plain listener on that port saw no connection;
  - a certificate of an authority the CLI does not trust → 69; a certificate for another host name → 69; an expired certificate → 69 (three servers, no `NODE_EXTRA_CA_CERTS` for the first);
  - `NODE_TLS_REJECT_UNAUTHORIZED=0` → 78; `NODE_OPTIONS=--max-old-space-size=64` → 78 (any value is refused);
  - `/v1/version` answers 307 to a second server → 69, and the second server saw nothing;
  - the version is fine and `keys` answers 302 to a second server → 69; the second server saw nothing (the first saw one credentialed request: say so in the test);
  - `apiMajor` one higher → 76; a version body that is HTML → 65;
  - a server that accepts and never answers → 69 within the deadline plus two seconds (`timeoutMs` shortened through nothing but the test server's own behaviour: the test waits the real 30 s once — mark it slow);
  - each error status of `errors.test.ts`'s list, sent by the server with the contract's envelope → its exit code, with the server's `requestId` and code in the stderr line;
  - no token → 64; token in the variable and `--token-stdin` together → 64; a token of 4,097 bytes → 64.
- [ ] `keys.test.ts`: names printed one per line in the server's order with a final newline, exit 0; with `--token-stdin` the same; `count` wrong → 65 and **stdout is empty**; a name that breaks the name rule → 65, stdout empty; 401 → 77.
- [ ] `tests/cli/cli.test.ts` (Session 1's three tests) stays green; `--version` prints the CLI version and the API major and makes no request.
- [ ] `tests/integration/machine/cli-client.test.ts` (real stores; `createClient` with the fixture's authority as `extraCa`): `version`; `keys` and `resolve` of a seeded environment pass the CLI's validators and their digests equal the owner's export; a revoked token → `CliError` `denied` with a request id; the token of 1a on 1b's path → `denied`; a held slot → `unavailable` with code `key_under_review`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS (`pnpm run test:cli`; the integration file). Write D-43 (first half). **Commit** `feat(cli): verified connection, version check and keys`.

**Registry:** `FR-1.46`, `FR-1.47`, `FR-1.79` → `SPIKE_PASS` (run note; Linux evidence — the four platforms are Run 5.7). **Covers:** FR-1.46, FR-1.47, FR-1.79. **Done when:** HTTP URLs, bad certificates, redirects and an incompatible API version each fail with the right exit code and no credential sent.

---

## Run 5.6 — CLI `run` and `export` (D08-S30)

**Files:** `apps/cli/src/{run,export,main}.ts`, `tests/cli/{run,export}.test.ts`, `tests/cli/child.mjs`, `tests/unit/cli/{child-env,export-target}.test.ts`, `tests/harness/cli-linux.ts`, `tests/staging/cli.staging.test.ts`, `docs/decisions/D-43-cli-design.md`.

**Consumes:** Run 5.5 (everything it produces); the dotenv codec `export.create` uses (its serializer and its parser); `stagingOwnerSession`, `publicRequest`.

**Produces:**

```ts
// apps/cli/src/run.ts
export function buildChildEnv(parent: NodeJS.ProcessEnv, entries: readonly { name: string; value: string }[], override: boolean): NodeJS.ProcessEnv;
export function checkSize(env: NodeJS.ProcessEnv, command: string, args: readonly string[], platform: string): void;     // CliError("capacity")
export function runCommand(p: { client: ApiClient; selector: Selector; token: string; command: string; args: string[]; override: boolean; env: NodeJS.ProcessEnv; tty: boolean }): Promise<number>;
// apps/cli/src/export.ts
export interface ExportFs { /* lstat, open, fstat, write, fsync, close, unlink, and the directory's fsync — node:fs by default */ }
export function checkTarget(out: string, uid: number, fs: ExportFs): { directory: string; name: string };                 // CliError("export_target")
export function exportCommand(p: { client: ApiClient; selector: Selector; token: string; out: string; stderr: NodeJS.WritableStream; uid: number; fs?: ExportFs }): Promise<number>;
// tests/harness/cli-linux.ts
export function runCliInLinux(args: string[], opts?: { env?: Record<string, string>; stdin?: string }): Promise<CliResult>;
  // Linux and macOS: runCli. Windows: docker run --rm -i -e <names only> --mount <dist, read-only> <the pinned Node image> node /cli/secrets.mjs …
```

Design fixed here (P-96; Doc 06 §10; FR-1.48, FR-1.49, FR-1.50; D-24):

- **`run`, in order:** the common order of Run 5.5 (the token from the variable only) → `client.resolve` → `validateResolve` → `buildChildEnv` → `checkSize` → signal handlers → `spawn(command, args, { shell: false, stdio: "inherit", env })` → the local references to the entries and the token are dropped → wait. Nothing is written to disk at any point; there is no cache and no second request.
- **`buildChildEnv`:** the parent's environment without every name that starts with `SECRETS_`; a secret whose name is already present → `usage` unless `override` (then the secret wins); a secret name the contract's rules reserve is refused with or without `--override`.
- **`checkSize`:** refuses before spawning what cannot fit: on Linux a single `NAME=value` string longer than 128 KiB, and a total of environment and arguments above three quarters of the limit `getconf ARG_MAX` reports (read once through `child_process.execFileSync`); on macOS the total alone. `E2BIG` from `spawn` is the same category.
- **Signals.** `SIGTERM` is always forwarded to the child, once. `SIGINT`, `SIGQUIT` and `SIGHUP` are forwarded once when the CLI has no controlling terminal on stdin (`tty` false); with one, the terminal has already delivered the signal to the whole foreground group, the child among them, and the CLI only waits. The child stays in the CLI's process group. The CLI's exit status is the child's status, or 128 + the signal's number when the child died by a signal. A signal that arrives before the spawn starts nothing and exits 128 + its number. The CLI never starts the child a second time.
- **`export`, in order:** the common order → `resolve` → `validateResolve` → the dotenv text built in memory by the codec → `checkTarget` → create → write → `fsync` → close → `fsync` of the directory → one line on stderr that the file holds plaintext secrets. Only then exit 0.
- **`checkTarget`** (`export_target` on each): the path's directory must exist, must be reached without a symbolic link in any component, must be owned by the user and not writable by group or others; the target itself must not exist (`lstat`), whatever it is.
- **Creation:** `open` with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` and mode `0o600`; then `fstat`: a regular file, owned by the user, no permission bit for group or others — its device and inode are remembered. No `chmod`, ever. On any failure after the creation: `lstat` the path; when device and inode are the remembered ones, unlink it; when they are not, leave it and print `cleanup required: <path>` (the path only) — exit 73 either way.
- **Windows and the harness.** Nothing of this run works on native Windows by design; `runCliInLinux` exists for the one staging file the workstation must run.

### Task A — `run`

- [ ] **Step 1 — Failing tests.** `tests/unit/cli/child-env.test.ts`: `SECRETS_MACHINE_TOKEN`, `SECRETS_API_URL`, `SECRETS_PROJECT`, `SECRETS_ENVIRONMENT`, `SECRETS_TOKEN_FILE` and `SECRETS_ANYTHING` are gone; other variables stay; a collision throws `usage` and with `override` the secret's value wins (digests); a reserved name throws in both modes; `checkSize` for one string of 200 KiB on Linux and for a total above the limit on both platforms.
  `tests/cli/run.test.ts` (the child is `node tests/cli/child.mjs <marker>`: it writes the names of its environment, the SHA-256 of each value, its arguments, and how many of each signal it received, into the marker file; `HOME`, `TMPDIR` and `XDG_*` point at fresh empty directories):
  - `the child gets the complete set and nothing of the CLI`: every name with the right digest; no `SECRETS_*` name; exit 0.
  - **Nothing starts on anything less than the complete set** (Review focus 4) — one case each, and each asserts the contract's exit code, **no marker file**, and that `HOME`, `TMPDIR` and the working directory are still empty: a body cut at a JSON boundary; a connection closed before `content-length` bytes arrived; `count` wrong; `complete: false`; `complete` absent; a duplicate name; an entry without a value; a 200 with HTML; a 200 with `{}`; another `apiMajor` in the body; a redirect; 401 (an expired or revoked token); 403; 404; `409 environment_changed`; `409 key_under_review`; 429; `503 busy`; `503 backend_sealed`; `503 quarantined`; 507.
  - `the token is nowhere a child could find it by default` (Review focus 5): the child reports no variable holding it; no argument list of any process of the test's process group contains it (`ps -o args=` over the group on both platforms; on Linux also every `/proc/<pid>/cmdline` of the group); stdout and stderr do not contain it (the harness's own check).
  - `a collision fails with 64 and starts nothing; with --override the secret wins`.
  - `stdin belongs to the child`: text piped into `secrets run -- cat` comes out unchanged.
  - `arguments are not interpreted`: `-- node child.mjs <marker> '$(id)' ';' '*'` — the child's argument list has the three strings as they are.
  - `the child's status is the CLI's`: exit 7 → 7; the child kills itself with `SIGKILL` → 137.
  - `SIGTERM to the CLI reaches the child exactly once`; the same for `SIGINT`, `SIGHUP` and `SIGQUIT` without a terminal; a child that handles `SIGTERM` and exits 5 → 5; one that dies by it → 143.
  - `with a terminal, Ctrl-C reaches the child once` — the CLI under `script` (the Linux and the macOS form of the command differ; one helper), byte `0x03` written to the terminal: the child counts one `SIGINT`.
  - `a signal before the spawn starts nothing`: the server holds the resolve answer, `SIGINT` to the CLI → exit 130, no marker.
  - `too large for the platform` — one value of 200 KiB on Linux, a total of 2 MiB on macOS → 75, no marker.
  - `a command that does not exist → 64, no marker`; `the child is started once` (a child that exits 1 leaves a marker with one start).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS (`pnpm run test:cli`). **Commit** `feat(cli): run starts a process with the complete set or not at all`.

### Task B — `export`

- [ ] **Step 1 — Failing tests.** `tests/unit/cli/export-target.test.ts` (an `ExportFs` double): the write fails with `ENOSPC` after the creation → the file is unlinked (same device and inode), exit 73; the path holds another inode at cleanup → no unlink, `cleanup required`, exit 73, and stderr holds no content of the file; a directory owned by another uid → 73; a created file that reports a group bit → 73 and unlinked.
  `tests/cli/export.test.ts`: `a new file of mode 0600 whose parsed names and digests are the set` (parsed with the codec's parser); the plaintext warning on stderr; `an existing file → 73 and its bytes are unchanged`; `a symbolic link at the target → 73 and its target is untouched`; `a symbolic link in the directory's path → 73`; `a directory writable by group → 73`; `umask 000: the file is still 0600`; `umask 277: the export succeeds and the file is 0400`; **an incomplete response creates no file** (three of Task A's damaged answers; the directory is empty afterwards); `--token-stdin` works for `export`; the value bytes are in no other file under `HOME` and `TMPDIR`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(cli): export writes one new private file or nothing`.

### Task C — the CLI against staging

- [ ] **Step 1 — Failing test** `tests/staging/cli.staging.test.ts` (`runCliInLinux`; the build Run 5.4 deployed; own project, cleanup in `finally`): the owner seeds ten values and issues a token (300 s) → `secrets keys` prints the ten names → `secrets run -- node -e <prints each name and the SHA-256 of its value>`: the digests equal the owner's export → `secrets export --out` inside the container, then `stat` and a digest comparison there → the owner revokes → `secrets run` exits 77, prints no name and starts nothing → `secrets keys` exits 77.
- [ ] **Step 2 — Run:** FAIL, then PASS. Finish D-43. **Commit** `test(staging): the CLI against the deployed API`.

**Registry:** `FR-1.48`, `FR-1.49`, `FR-1.50`, `AC-1.20`, `AC-1.21` → `SPIKE_PASS` (run note; Linux evidence). **Covers:** FR-1.48, FR-1.49, FR-1.50; AC-1.20, AC-1.21. **Done when:** a truncated, partial or expired response launches nothing; the token is absent from the child's environment and from process arguments.

---

## Run 5.7 — Four-platform packaging (D08-S31)

**Files:** `infra/release/cli/{build-release.ts,install.sh.template,README.md}`, `package.json` (script `cli:release`), `infra/dependencies.lock.json` (the four Node archives), `scripts/pins-verify.ts` (or wherever `pins:verify` lives: the new entries), `.github/workflows/ci.yml`, `tests/cli/{install,platform}.test.ts`, `tests/unit/release/build.test.ts`, `docs/decisions/D-44-cli-distribution.md`, `docs/evidence/session-5/cli-matrix.md`.

**Consumes:** Runs 5.5, 5.6 (the bundle, project `cli`, `runCli` with `MYKEY_CLI_BIN`, `pnpm run test:cli`); the `cli-matrix` job of Session 1 and its four runner labels; D-24's nine requirements.

**Produces:** the release `cli-v0.1.0` (`mykey-cli-0.1.0.tgz`, `install.sh`, `SHA256SUMS`); `pnpm run cli:release -- --version <v>`; the workflow input `jobs` and `cli_release`; `docs/evidence/session-5/cli-matrix.md`.

Design fixed here (P-98, P-99; Doc 10 §8.1; FR-1.51):

- **`build-release.ts`:** builds the bundle; packs `secrets.mjs`, a minimal `package.json` (name, version, `type`, `bin`, `engines.node` exactly the pinned version) and `LICENSE` into a tar archive that is the same bytes on every builder (sorted entries, mode 0644 / 0755, uid and gid 0, mtime 0, gzip without a timestamp); renders `install.sh` from the template with the version, the archive's SHA-256 and the four Node sums; writes `SHA256SUMS` over the two files; output in `apps/cli/release/<version>/`.
- **Pins:** `binaries.node-linux-x64`, `node-linux-arm64`, `node-darwin-x64`, `node-darwin-arm64`: version 24.22.2, asset `node-v24.22.2-<target>.tar.gz`, SHA-256 from `https://nodejs.org/dist/v24.22.2/SHASUMS256.txt`, `advisoriesChecked`. `pins:verify` fails when the template's rendering and the lock file disagree.
- **`install.sh`** as P-98. Further rules: `set -eu`; every path quoted; it runs under `dash` and under macOS's `/bin/sh`; checksums with `sha256sum` or, where that is missing, `shasum -a 256`; unpacking into a temporary directory inside the target directory and one `mv` at the end, so an interrupted install leaves no half version; a second run with the same version changes nothing; exit 78 with one line for an unsupported system, naming what it saw; a Linux whose `ldd --version` does not name glibc is refused.
- **The matrix job.** `workflow_dispatch` gains two inputs: `jobs` (`all` or `cli-matrix`, default `all`) and `cli_release` (a tag). Every other job gets the condition that keeps it out of a `cli-matrix` dispatch. `cli-matrix` (four runners as today, `timeout-minutes: 15`, `permissions: contents: read`): checkout, the pinned Node and pnpm, `pnpm install --frozen-lockfile`, `gh release download "$TAG" --dir rel` with the workflow's token, `SHA256SUMS` verified, `sh rel/install.sh`, then project `cli` with `MYKEY_CLI_BIN="$HOME/.local/bin/secrets"` and `MYKEY_EXPECT_TARGET`, the JSON report uploaded. The job's own Node only runs Vitest; every CLI process of the suite is the installed launcher with the installer's Node.
- **A release is never changed.** A fix after `cli-v0.1.0` is `cli-v0.1.1` with a new build; the matrix result belongs to the `SHA256SUMS` it tested, and the evidence file names them.

### Task A — the first choice, decided

- [ ] **Step 1 — Read** `https://nodejs.org/docs/v24.22.2/api/single-executable-applications.html`. Copy into the run note, word for word: the stability line, the list of supported platforms, and whether a tool outside Node is needed. Below "Stability: 2", or with one of the four targets missing: the first choice has failed its proof; write D-44 (what was read, the date, the fallback taken, which later runs change: none) and go on. If the page says Stable for all four, write that into D-44 instead, tell the owner in one line, and build the executable in the matrix job as that page describes, with the same installer checks and the same suite — the planner did not design that branch further because the documentation of 14 Nov 2026 rules it out.

### Task B — the release and the installer

- [ ] **Step 1 — Failing tests.**
  - `tests/unit/release/build.test.ts`: two builds of one commit give the same `SHA256SUMS`; the archive holds exactly three entries; the bundle imports nothing but `node:` modules (parse its import statements); `install.sh` carries the four sums of the lock file and the archive's own sum; the script has no `sudo`, no `curl` without `--proto '=https'`, and passes `sh -n`.
  - `tests/cli/install.test.ts` (POSIX; a fresh `HOME`; the Node archive of the test's own target downloaded once into the suite's cache and verified against the lock file): install from a directory that holds the three release files and the Node archive → `$HOME/.local/bin/secrets --version` prints the version; the tree written is exactly `$HOME/.local/share/mykey/cli/<version>/` and the launcher; one changed byte in the CLI archive → refused, nothing written; one changed byte in the Node archive → refused, nothing written; a `uname` earlier in `PATH` that says `FreeBSD`, `riscv64` or `MINGW64_NT-10.0` → exit 78 with the name it saw, nothing written; a second install → no change (the tree's digests); `--uninstall` → `HOME` as before; the whole test passes with `sh` being `dash` (Linux) and `/bin/sh` (macOS).
  - `tests/cli/platform.test.ts`: the launcher's `process.platform`-`process.arch` equals `MYKEY_EXPECT_TARGET` when that is set (the CLI's `--version` prints its target); the launcher runs the installer's Node (`--version` prints `24.22.2`), not the runner's.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement**; pin the four archives. **Step 4 — Run:** PASS in the Linux container (`MYKEY_CLI_BIN` pointing at an installed launcher there). **Commit** `feat(release): CLI release archive and installer`.

### Task C — the four runners (AC-1.37)

- [ ] **Step 1 — The workflow change**, committed and pushed to `session-5` (a push runs nothing: CI runs on pull requests and by hand).
- [ ] **Step 2 — The release:** `pnpm run cli:release -- --version 0.1.0`; `gh release create cli-v0.1.0 --target session-5 --title "MyKey CLI 0.1.0" --notes "Session 5, Run 5.7" apps/cli/release/0.1.0/*`. Then the whole of Task B once more against the downloaded release (`gh release download` into a fresh directory, in the Linux container).
- [ ] **Step 3 — The matrix, once:** `gh workflow run ci --ref session-5 -f jobs=cli-matrix -f cli_release=cli-v0.1.0`; `gh run watch`. A red job: read its log, fix, prove the fix in the Linux container, cut `cli-v0.1.1`, and run **only what the owner's answer about minutes allows** (P-99) — with no answer, do not run a second time: record the failure and leave the item `OPEN`.
- [ ] **Step 4 — Evidence** `docs/evidence/session-5/cli-matrix.md`: the run's URL; the `SHA256SUMS` tested; per target the runner label, `uname -a`, the launcher's Node version, tests passed and failed, billed minutes; the table of D-24's nine requirements, each with the test name that proves it (`AGENT-B1`); the native Windows refusal (the workstation's output line of `pnpm run test:cli`).
- [ ] **Step 5 —** `pnpm run check`. **Commit** `ci: cli-matrix tests the released CLI on four runners`.

**Registry:** `FR-1.51`, `AC-1.37`, `PO-8`, `AGENT-B1` → `SPIKE_PASS` when all four runners passed the suite from the release; a runner that did not run or did not pass leaves `AC-1.37` and `PO-8` `OPEN` with the reason (run note). **Covers:** FR-1.51; AC-1.37; PO-8; AGENT-B1. **Done when:** the same CLI test suite passes on all four platforms from released artifacts, not from cross-compiled guesses.

---

## Run 5.8 — Consumer setup and fixture apps (D08-S31) · ∥

**Files:** `tests/fixtures/consumers/next-app/**`, `tests/fixtures/consumers/fastapi-app/**`, `tests/fixtures/consumers/secrets-launch.sh`, `docs/runbooks/{consumer-local,consumer-deploy}.md`, `tests/harness/runbook.ts`, `tests/consumers/{fixtures,runbook}.test.ts`, `vitest.config.ts` (project `consumers`), `package.json` (script `test:consumers`), `infra/dependencies.lock.json`.

**Consumes:** Run 5.7 (the release files and `install.sh`); Runs 5.1, 5.2 (issue and revoke on staging through `stagingOwnerSession`); `tests/harness/staging.ts`.

**Produces:**

```ts
// tests/harness/runbook.ts
export interface RunbookBlock { file: string; heading: string; mode: "run" | "stdin" | "provided"; script: string }
export function rehearsedBlocks(markdownPath: string): RunbookBlock[];     // fenced sh blocks preceded by <!-- rehearsed -->, <!-- rehearsed: stdin --> or <!-- rehearsed: provided -->
export function runBlock(container: string, block: RunbookBlock, opts?: { stdin?: string; env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }>;
```

Design fixed here (P-100; FR-1.85; AC-1.42 by D-03):

- **The fixtures.** Each serves `GET /check` → `{ names: string[], digests: Record<string, string> }` for the environment variables whose names are in the comma-separated variable `FIXTURE_NAMES`; never a value; the Next.js one from a route handler of a production build, the FastAPI one under `uvicorn`. Each Dockerfile installs the CLI from release files copied in at build time (`install.sh`, offline, with the Node archive beside it) and ends in `ENTRYPOINT ["secrets-launch.sh", "--"]` with the server as the command. No build argument and no layer holds a token.
- **`secrets-launch.sh`:** reads the file named by `SECRETS_TOKEN_FILE` (default `$HOME/.config/mykey/machine-token`); refuses a file that is a symbolic link, is not owned by the user, or has a permission bit for group or others; exports `SECRETS_MACHINE_TOKEN`; `exec secrets run "$@"`. It prints nothing but its refusals.
- **`consumer-local.md`** (a developer's machine), in this order, each step with its rehearsed block: get the release (`gh release download` — mode `provided` in the rehearsal: the harness puts the files in place); verify `SHA256SUMS`; `sh install.sh`; put `~/.local/bin` on `PATH` for the session; set `SECRETS_API_URL` and check the endpoint (`secrets --version`, then `curl -fsS "$SECRETS_API_URL/v1/version"`); issue a token in the workspace (prose; in the rehearsal the test issues it); store it with `( umask 077; mkdir -p "$HOME/.config/mykey"; cat > "$HOME/.config/mykey/machine-token" )` — mode `stdin`: pasted, ended with Ctrl-D, so it is in no history and no argument; `secrets-launch.sh -- <the application's start command>`; check; **rotate** (issue a second token, replace the file the same way, restart, revoke the first, see the first refused); **after a restore** (every token issued before the restore is treated as unknown: the operator runs `ops reconcile-credentials` per environment, the owner issues new tokens and replaces the files — the consumer's part is the replace-and-restart of "rotate"). Then "Where the credential is and who can read it" and "Limits": the user who starts the application can read the token file, and a process of that user can read the CLI's own environment while it runs; `secrets run` keeps the token out of the application's environment and arguments by default and no further; the service replaces the application's dotenv files, not the need to protect this one credential.
- **`consumer-deploy.md`** (a first consumer on a host with Docker): build the image; create the token file on the host as above; run with the file mounted read-only at the path `SECRETS_TOKEN_FILE` names and with `SECRETS_API_URL`, `SECRETS_PROJECT`, `SECRETS_ENVIRONMENT` as plain variables; check; rotate (replace the file, restart the container, revoke the old token); after a restore. The same two closing sections.
- **`runbook.test.ts`** runs against **staging over its public name** (the certificate is real, so nothing about trust is special): a fresh container of the pinned Node image is the clean machine; the blocks of `consumer-local.md` run in order (the test supplies what the owner would: the release files, the token on stdin, the variables); then the image of each fixture is built and the blocks of `consumer-deploy.md` run on the workstation's Docker. `pnpm run test:consumers` is `node scripts/require-staging-env.ts && vitest run --project consumers`. It is a staging test in everything but its project: own project and environment, every token revoked and the project archived in `finally`.

### Task A — the fixtures

- [ ] **Step 1 — Failing test** `fixtures.test.ts` (no product involved): each image builds from a clean context; started with three synthetic variables given by `docker run -e`, `GET /check` answers their names and digests; a name not in `FIXTURE_NAMES` is not answered; the response and the container's log hold no value.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement**; pin `next`, `fastapi`, `uvicorn` and the Python base image (advisory check each; no pre-release). **Step 4 — Run:** PASS. **Commit** `test(fixtures): Next.js and FastAPI consumer fixtures`.

### Task B — the runbooks, rehearsed (PO-20)

- [ ] **Step 1 — Failing test** `runbook.test.ts`:
  - `consumer-local, every rehearsed block in order, exits 0`; after the launch block `GET /check` of the Next.js fixture (started by `secrets-launch.sh -- …` in the clean machine) answers the ten seeded names with the digests of the owner's export; the same for the FastAPI fixture.
  - `rotation`: after the blocks, the application answers with the second token in place; the first token's `secrets keys` exits 77.
  - `after a restore` (synthetic): every token of the environment revoked by the test, the replace-and-restart blocks run with a new one, `/check` answers again.
  - `consumer-deploy`: both containers answer `/check`; `docker inspect` of each shows no variable holding the token; rotation by replacing the mounted file and restarting.
  - **The token is nowhere it must not be** (Review focus 5), for every token of the test, bytes searched with the token on stdin or fd 3: the history files of the clean machine's shell (`.ash_history`, `.bash_history`, `.zsh_history`, `.sh_history`); the argument lists of every process in the clean machine and in both containers while the applications run; both images (`docker save`, every layer); `docker history --no-trunc`; the repository's working tree; the test's own captured output. Each search has a control that finds a marker planted the same way.
  - `the launch wrapper refuses a token file readable by group, a symbolic link, and a missing file`, each with exit ≠ 0 and no application started.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Write the runbooks and the harness.** **Step 4 — Run:** PASS (`pnpm run test:consumers`; announce nothing — no deploy, no alert). **Commit** `docs(runbooks): consumer setup for a workstation and for a first deployment, rehearsed`.

**Registry:** `FR-1.85`, `PO-20` → `SPIKE_PASS`; `AC-1.42` → `SPIKE_PASS` as the synthetic rehearsal D-03 defines (run note names D-03). **Covers:** FR-1.85; PO-20; AC-1.42 (synthetic). **Done when:** following the runbook from a clean machine launches both fixtures with no token in shell history, arguments, image or repository.

---

## Run 5.9 — OpenAPI and Scalar reference (D08-S32) · ∥

**Files:** `packages/contracts/src/{routes,authz}.ts`, `packages/contracts/openapi/{openapi.json,baseline-v1.json}`, `scripts/{contracts-compat,reference-asset}.ts`, `package.json` (`contracts:check` gains the compatibility step; `reference:asset`), `apps/api/package.json` (`@scalar/api-reference` as a development dependency), `apps/api/Dockerfile` (the asset stage), `apps/api/src/reference/{page,document}.ts`, `apps/api/src/routes/reference.ts`, `apps/api/src/pipeline/{route,authz}.ts`, `apps/api/src/app.ts`, `packages/operations/src/imports/apply.ts`, `vitest.config.ts` (project `browser`), `infra/dependencies.lock.json`, `tests/unit/contracts/compat.test.ts`, `tests/integration/reference/{document,aliases,page}.test.ts`, `tests/integration/imports/apply.test.ts`, `tests/browser/reference.test.ts`, `docs/decisions/D-45-api-reference.md`, `docs/evidence/session-5/reference-capture.json`.

**Consumes:** every handler of Runs 5.1–5.4; `ROUTES`, `DENIED_ALIASES`, the OpenAPI generator, the pending snapshot; `handlers()` of `apps/api/src/app.ts`; `HandlerResult.raw` (Run 4.9); `resolveAccess`, `decide`; `startTestApi`, `signInComplete`, `createTenants`.

**Produces:**

```ts
// apps/api — reference/document.ts
export function servedDocument(full: OpenApiDocument, handlerIds: ReadonlySet<string>): OpenApiDocument;   // only operations whose operationId has a handler; unused schemas dropped
// apps/api — reference/page.ts
export interface ReferencePage { html: string; csp: string }
export function buildReferencePage(scalarScript: string, document: OpenApiDocument): ReferencePage;        // pure; both inline scripts hashed after escaping
export function loadScalarScript(path: string): string | null;
// scripts/contracts-compat.ts
export type Break = { kind: "path_removed" | "method_removed" | "response_field_removed" | "enum_value_removed" | "request_field_required" | "type_narrowed"; where: string };
export function breakingChanges(baseline: OpenApiDocument, current: OpenApiDocument): Break[];
```

Design fixed here (P-101, P-103; Doc 06 §18.4; FR-1.52, FR-1.53, FR-1.54):

- **Contract commit** `contract: reference and openapi document`: both routes take action `reference.read` (owner and admin allow; everyone else hidden); `reference.get` answers `200` as the raw kind `html-document`; `openapi.get` answers `200` with an object. `authority:check` and the route-action test follow.
- **Service scope** (`route.ts`, `authz.ts`): a human route with an action and without `:org` in its path is authorized against the process's organization (`deps.bao.organizationId()`; null → `503 dependency_unavailable`). The handler still decides nothing.
- **The served document** is computed once at start from the generated document and the keys of `handlers()`. The generated `openapi.json` stays complete (it is the contract); what a build serves is what the build does. The inventory of the auth component's routes that FR-1.52 asks for is Session 3's `auth:contract:check`; this run changes nothing there and the report says so.
- **The Scalar script** is the standalone browser build of the pinned `@scalar/api-reference` (read the package's `exports` and `dist` for its path). `scripts/reference-asset.ts` copies it to `apps/api/assets/scalar.js` (ignored by Git); the Dockerfile gets a stage that installs the development dependency and copies that one file into the image; nothing else of the package reaches the image. A process without the file serves `503 dependency_unavailable` on `reference.get` and logs `reference_asset_missing` once at start.
- **The page:** `<div id="app">`, the document as a JSON data block (`<script type="application/json">`, `<` escaped), the Scalar script inline, and a second inline script that starts Scalar on the data block with request execution, the API client, telemetry, default fonts, developer tools and any proxy switched off — the option names from the pinned package's types. Policy and headers as P-101, with **`connect-src 'none'`**: the document travels inside the page, so the page has no reason to make a request at all. A literal `</script` inside either inline script is escaped before hashing.
- **If the capture cannot be made clean** by configuration — the page still attempts a request the policy has to block — record what it attempts in D-45, tell the owner in one line, and serve instead a plain HTML listing generated from the served document by `page.ts` itself (paths, methods, schemas as text). A page that attempts third-party requests is not shipped, blocked or not (FR-1.54: "a recorded decision before removing Scalar").
- **The compatibility check:** `baseline-v1.json` is the generated document as it stands at the end of this run. `contracts:check` runs `breakingChanges(baseline, current)` and fails on any entry while `API_MAJOR` is 1. A new route, a new optional request field and a new response field are not breaks.
- **M-2** (P-103): in `imports/apply.ts`, an `unchanged` entry is checked under the lock against the index row's version and state tag before it is recorded; a difference ends the import the way a changed entry does. **M-6**: the description of the `Idempotency-Key` header in the contract gains the sentence of P-103.

### Task A — the document, the aliases, no passthrough

- [ ] **Step 1 — Contract commit.** **Step 2 — Failing tests.**
  - `tests/unit/contracts/compat.test.ts`: one case per `Break` kind; the three non-breaks; the committed baseline against the current document → no entry.
  - `document.test.ts` (`createTenants`, real handlers): `ownerA` and `adminA` get 200; `editorA`, `readerA`, `envEditorA` and `ownerB` get the hidden 404, equal to the 404 of an unknown path; no session → 401; a session that has only passed the password step → the pipeline's answer for an incomplete session. The served document: OpenAPI `3.1.x`; valid for `@scalar/openapi-parser`; its operation ids are exactly the keys of `handlers()` that are contract routes; **every listed operation is answered by a handler** (a request by the owner does not end in the terminal no-route answer — use what the pending tests use to tell the two 404s apart); every contract route without a handler is absent and ends in the terminal answer; no `servers` entry with a host; no example that matches a token or a canary pattern.
  - `aliases.test.ts` (FR-1.52, FR-1.53), each the terminal 404 for the owner **and** for a machine bearer: every entry of `DENIED_ALIASES`; `/v1/version/`; `/V1/version`; `/v2/version`; `//v1/version`; `/v1/openapi.yaml`; `/v1/reference/`; `/v1/sys/health`; `/v1/kv/data/x`; `/v1/auth/token/lookup-self`; `/v1/auth/approle/login`; `/v1/machine/projects/<id>/environments/<name>/history`. `X-HTTP-Method-Override: DELETE` on a `GET` stays a `GET`. A product request that carries `X-Vault-Token` and `X-Vault-Namespace: root`: OpenBao's audit device shows the API's own namespace and identity for it, and the header's value nowhere. During the whole file OpenBao's audit device gains no request from the alias cases.
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Implement.** **Step 5 — Run:** PASS; `pnpm run contracts:openapi`; commit `baseline-v1.json` at the end of Task D, not here. **Commit** `feat(api): the OpenAPI document of this build, for owner and admin`.

### Task B — the page

- [ ] **Step 1 — Failing tests** (`page.test.ts`): the headers of P-101, exactly; the two hashes in the policy equal the SHA-256 of the two inline scripts as served; no `src`, `href`, `action` or `url(` in the document's own markup points at another origin; the data block parses to the served document; `ownerA` and `adminA` only (the cases of Task A); without the asset file → `503` and one `reference_asset_missing` log entry; the pinned package's version is in a `meta` tag.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement**; `pnpm run reference:asset`; the Dockerfile stage; `node scripts/ci-scan.ts images` still green (the image's dependencies did not grow). **Step 4 — Run:** PASS. **Commit** `feat(api): a self-contained API reference`.

### Task C — the capture (AC-1.22, PO-10)

- [ ] **Step 1 — Pin** `playwright` and its Chromium (advisory check); project `browser` (`tests/browser/**/*.test.ts`, one worker); `pnpm exec playwright install chromium` is a documented step of the run, not of `pnpm install`.
- [ ] **Step 2 — Failing test** `tests/browser/reference.test.ts` (`startTestApi` with real handlers; the owner's session cookie put into the browser context; the test API's private certificate accepted by the context — this is a test of egress, not of TLS):
  - `the reference renders`: the path `/v1/version` and the operation of `secrets.list` are visible text.
  - **`the page makes no request but its own`**: every request the context saw (`request`, `requestfailed`, and a route handler that aborts and records anything not same-origin) is the document itself and at most the browser's own `/favicon.ico`; **zero** requests to another origin were attempted; **zero** `securitypolicyviolation` events (an init script collects them); no `WebSocket`, `EventSource`, `sendBeacon` or `fetch` was called (the init script counts the calls).
  - `nothing can be executed`: no control whose accessible name matches `send`, `test request` or `try` exists; no `<form>` posts anywhere.
  - `without a session the browser gets no page` (401); `editorA` gets the hidden 404.
  - The test writes `docs/evidence/session-5/reference-capture.json`: the Scalar version, the browser version, the list of requested paths, the three counts.
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Configure until it is clean, or take the fallback of the design above.** **Step 5 — Run:** PASS. Write D-45. **Commit** `test(browser): the reference attempts no third-party request`.

### Task D — carried minors

- [ ] **Step 1 — Failing test** (`tests/integration/imports/apply.test.ts`): `an unchanged entry whose key changed after the preview stops the import` — preview with one `unchanged` and two `create` entries; the owner updates the unchanged key; apply: the import ends as it does for a changed entry today, nothing of the file is written after that entry, and the invariant check holds. The same at resume.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** M-2; the M-6 sentence; `pnpm run contracts:openapi`; write `baseline-v1.json`. **Step 4 — Run:** PASS; `pnpm run check`. **Commit** `fix(import): unchanged entries are rechecked; contract baseline v1`.

**Registry:** `FR-1.52`, `FR-1.53`, `FR-1.54`, `AC-1.22`, `PO-10` → `SPIKE_PASS` (run note names `reference-capture.json`). **Covers:** FR-1.52, FR-1.53, FR-1.54; AC-1.22; PO-10. **Done when:** a captured browser session of the reference shows no third-party requests.

---

## Run 5.10 — Session 5 gate

- [ ] **Step 1 — Full suite from a clean clone** outside OneDrive (`git clone` of branch `session-5` into `C:/Users/gmpar/mykey-gate/session-5`), one job at a time: `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm test`, `pnpm run test:integration -- --maxWorkers=2`, `pnpm run test:cli`, `pnpm run reference:asset && pnpm exec vitest run --project browser`, `pnpm run test:cloud`. Expected: everything green except the R2 fixture guard in `test:cloud` (on purpose since 15 Nov 2026 09:42 UTC) — list the failing test names; any other failure is a finding. The watched load flakes (`tests/fault/effects/exclusion.test.ts`, `tests/integration/api/health.test.ts`, the ops kill-point cases, `tests/fault/secrets`, and now `tests/fault/credentials`): a failure under the whole suite is re-run alone once and listed in the report either way.
- [ ] **Step 2 — Dated items.** The checkpoint `pairs-lock-session-gate` is recorded (Session start Step 3) — if it is not, do it now. Nothing else is due: the report repeats the KMS certificates (12 Dec 2026) and `.trivyignore.images` (14 Dec 2026). `node scripts/ci-scan.ts images` and `dependencies` locally, because this session added dependencies.
- [ ] **Step 3 — The CLI release of the final commit.** When `apps/cli/dist/secrets.mjs` of the final commit has another SHA-256 than the release the matrix tested: cut the next version, test it in the Linux container from the downloaded release, and run the matrix for it only within P-99; otherwise write "matrix result of Run 5.7 stands for these bytes" with the two digests into the report.
- [ ] **Step 4 — Staging deploy** of the final commit (announce the window); `status`: gate open, `runtimeLogin: ok`, `issuerLogin: ok`, `reviewOpen: 0`, `operationsUnresolved: 0`.
- [ ] **Step 5 — Staging suite**, one file at a time, the files of this session last: `credentials`, `machine`, `archive`, `cli`; restore the evidence files of earlier runs that a staging run rewrites. Then, recorded in the run note:
  - **the machine journey** (Doc 10, Run 5.10): `pnpm run test:consumers` — issue → supply → `secrets run` a fixture → revoke → denied, on staging, from a clean machine;
  - **the token sweep** → `docs/evidence/session-5/token-sweep.txt`: for every token issued on staging in this step, and for one canary value resolved by a machine, each surface (API log, `pg_dump`, PostgreSQL log, OpenBao audit device, Traefik access log, the clean machine's history files and process list) with the command, the number searched and the number found — surface names and counts only, through `countOnHost` and `secretOutput` where the path demands it;
  - the time of the Telegram message for the drill of Run 5.2 Task D and of its clearing.
- [ ] **Step 6 — Production**, only when `owner-requests.md` holds the owner's yes: image and migrations `0013`–`0014`, `up`; its gate stays not open; `status`. Otherwise write "not updated, by default" into the report.
- [ ] **Step 7 — One fresh-context review** of `git diff main...session-5` (`superpowers:requesting-code-review`), given this plan, Doc 10 §4.1 and these questions:
  1. Can a machine token reach PostgreSQL, a log line, an error body, an audit detail, a job, a process argument, or any file but the one the consumer runbook names?
  2. Is there a path on which a token is delivered before its accessor, expiry and `active` state are committed — or delivered twice?
  3. Can the create call be sent twice for one request: a retry, a replay that executes, a continued operation?
  4. Does any state read `revoked` or `archived` without a lookup that proved the absence? Can a credential or a resource that is `revoking` serve a machine?
  5. Can any path of a machine route read OpenBao as `runtime`, or return anything but the current values of the bound environment?
  6. Can a dead, foreign or malformed token change anything — a review, an audit row without limit, a lock that stays held?
  7. Can an archive finish while a token of its scope works? Can the tick's continuation send anything but a revocation and its lookups?
  8. Can the CLI start a child or create the export file before the complete response was validated? Can it follow a redirect, run without verification, or send the bearer before the version check passed?
  9. What do the tests of this session not prove that the report claims — in particular for the two macOS targets, for the consumer runbooks, and for the reference page?
- [ ] **Step 8 — Findings:** Critical and Important are fixed with a failing test first; minors are listed in the report with the run that owns them. Re-run what the fixes touch, then Step 1's `check`, unit and integration suites. A fix that changes the CLI's bytes repeats Step 3.
- [ ] **Step 9 — Registry:** set the statuses named in Runs 5.1–5.9 in `registry-overrides.json` (each with its run note; `SPIKE_PASS` or `FAIL` only; what the minutes did not allow stays `OPEN` with its reason), `pnpm run evidence:build`, `pnpm run check`.
- [ ] **Step 10 — Report** `docs/evidence/session-5/report.md`: verdict (PASS / PASS WITH ISSUES / FAIL); what exists; the gate's commands and results; the fault table; `native-scope.md` in one paragraph with the residual of FR-1.45; the CLI matrix (runners, digests, minutes) and the fallback taken (D-44); the capture; measurements (one issuance, one resolve of ten and of 1,000 values, the archive of an environment with three credentials); decisions D-40 … D-45; deviations from this plan; the Actions minutes this session used; findings of the review and what became of them; open issues with owner runs; **"What Sessions 6 and 7 must know"** — at least: the audit actions and machine actors Session 6's views and export must show; the rate limit of 60 a minute per credential and the limits for issuance are Run 6.3's; **after a restore, every environment needs `ops reconcile-credentials`** before its tokens are trusted (the catalog and the namespace come from two stores of one pair) — Run 6.x's recovery runbook must call it; `ops reconcile-credentials`, the credential sweep and the archive tick have no host timer outside the API (Run 6.9); the workspace of Session 7 gets `credentialView`, the one-time token in the 201 and nowhere else, `credential_not_replayable` to explain to the owner, the archive confirmation that must name affected scopes and unfinished issuance (FR-1.17) from `credentials.list` and `operations.list`, and the reference at `/v1/reference` to link to; project `browser` and Playwright exist; the state of valves 2 and 4; the dated items that remain.
- [ ] **Step 11 — `CLAUDE.md`:** "Where we stand" (Session 5 done, what exists, what Sessions 6 ∥ 7 need) and "Things already learned" (only what every later session needs — at least how the CLI is tested from Windows and what a matrix run costs). Commit `docs: session 5 report`.
- [ ] **Step 12 — Pull request** `session-5` → `main` with the report's summary; this is the one full CI run of the session — watch it (`gh run list --branch session-5 --limit 3`), and push fixes to it in one batch. Do not merge. Tell the owner in one message: the verdict, the open decisions, the pull request.

**Covers:** the session gate of Doc 10 §7. **Done when:** the report exists, the review's Critical and Important findings are closed, and the pull request is open.

---

## Session 5 end state

- **API:** handlers for `credentials.list`, `credentials.issue`, `credentials.revoke`, `projects.archive`, `projects.reactivate`, `environments.archive`, `environments.reactivate`, `machine.keys`, `machine.resolve`, `reference.get`, `openapi.get`. The pending snapshot loses the routes this session filled. The API holds two OpenBao identities (`runtime` inline, `issuer` by short sessions) and authenticates machines by their own token.
- **Operations:** `@mykey/operations` root exports credential issuance and revocation, the credential sweep, archive with its continuation, reactivation, and the complete read with a reader; `/operator` exports `reconcileCredentials`. Migrations up to `0014`.
- **Operator:** `ops reconcile-credentials`; runbooks `machine-credentials.md`, `reconciliation.md` (credentials), `consumer-local.md`, `consumer-deploy.md`.
- **CLI:** `secrets keys | run | export`, one bundle, released as `cli-v0.1.x` with an installer for Linux x64 and arm64 and macOS x64 and arm64 (D-44); `pnpm run test:cli`, `cli:build`, `cli:release`.
- **Reference:** `/v1/reference` and `/v1/openapi.json` for owner and admin; the contract baseline `baseline-v1.json` and its check.
- **Proof:** `tests/integration/{credentials,lifecycle,machine,reference}`, `tests/fault/credentials`, `tests/cli`, `tests/consumers`, `tests/browser`, `tests/staging/{credentials,machine,archive,cli}.staging.test.ts`; `fault-table.md`, `native-scope.md`, `cli-matrix.md`, `reference-capture.json`, `token-sweep.txt`.
- **Staging** runs the session's final commit with the gate open, no operation unresolved, nothing in review, and no credential of a test left active. **Production** is updated only on the owner's word and its gate stays not open.
- **Registry:** FR-1.17, 1.18, 1.39–1.54, 1.79, 1.85; AC-1.11, 1.19–1.22, 1.37, 1.40, 1.42 (synthetic); PO-2, PO-8, PO-10, PO-18, PO-20; AGENT-B1 at `SPIKE_PASS` — or `OPEN` with its reason where a runner did not run. Nothing `PASS`.
- **Left for later, on purpose:** every rate limit (Run 6.3); audit views and export of the new actions, backup pairs that include the catalog, the reconcile step of recovery (Session 6); host timers (Run 6.9); the browser side of credentials, archive and the link to the reference (Session 7); a standalone CLI executable (after Stage 1, when Node calls the feature stable); M-1, M-3, M-4, M-5, M-7, M-8 with the runs the Session 4 report gives them.
