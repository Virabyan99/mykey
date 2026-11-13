# MyKey Stage 1 — Session 4 (Operations engine and secret lifecycle) Execution Plan

> **For the executing agent:** carry this plan out run by run, in the order given in "Run order". If you have the superpowers skills, use `superpowers:executing-plans` (inline execution is the owner's standing preference; one fresh-context review at the gate). Steps use checkbox (`- [ ]`) syntax for tracking. You do not re-decide anything in Doc 10 §3 / §8 or in the "Planner decisions" table below; if one proves wrong, write a one-paragraph decision record and continue (Doc 10 §1). One fallback of Doc 10 §8.1 is open in this session: **Complete read** (Run 4.8). The late-write fallback was closed in Session 2 (D-20, GO).

**Goal:** By the end of Day 7 (16 November 2026), on staging and through the API alone, the owner creates, updates, lists, reveals, deletes, undeletes and restores secrets, imports a dotenv file and exports the environment; every one of these writes is a durable operation that can be replayed but never repeated; and a write that is interrupted or delayed ends as `uncertain`, blocks its environment, raises an alert, and is settled by an operator command from backend evidence.

**Architecture:** The API gains its first OpenBao identity: the organization's `runtime` AppRole, used with inline authentication (D-17), so no login token is ever stored. Every secret mutation runs the six-step protocol of Doc 06 §6.2 on **one dedicated PostgreSQL connection** that holds the environment's session advisory lock from admission to finalization: backend pre-read → admission transaction (operation, step, effect slot, audit intent) → dispatch marker → exactly one backend change → read-back → finalizing transaction (index, state tag, generation, attribution, audit, slot released). Any failure after the dispatch marker is `uncertain`: the slot stays, the key goes to review, the answer is `503 outcome_unknown` with the operation id. Reads that return values (reveal, the complete read behind export and, in Session 5, machine resolve) take the same lock and commit their audit row on the lock-holding connection before a byte leaves. Import is a parent operation whose entries are child operations of the same protocol, executed inside the request that carries the file. Reconciliation is operator-only (`apps/ops`), decides from backend state, and may call an operation `rejected` only after the executors were excluded by a closed-maintenance step.

**Tech stack:** everything pinned in Sessions 1–3. No new dependency is planned; one that proves necessary is pinned in the run that adds it, after the advisory check of Run 1.3 Step 2.

**Spec:** `docs/doc_10_mykey_stage_1_compressed_implementation_plan_v1.0.md` §1–§5, §7 "Session 4", §8, §9, §10. Behaviour: Doc 04 §1.1–§1.2, §4 and §4.1, §5, §8.1; acceptance AC-1.12, 1.14, 1.15, 1.16, 1.17, 1.38, 1.39, 1.41. Design: Doc 06 §3, §5 (envelope, runtime row), §6 (all), §7.2, §8 (all), §9 (routes, response rules), §11, §12. Previous sessions: `docs/evidence/session-3/report.md` ("What Session 4 must know"), D-17, D-20, D-26, D-31, D-32, D-33; `docs/evidence/session-2/run-2.4.md`. Old runbooks for ideas only: D08-S18–S21, S23–S25.

**Provider facts used here** come from the tests of Runs 2.1 and 2.4 on OpenBao 2.7.2 (`tests/integration/openbao/client*.test.ts`, `tests/fault/effects/*`, D-17, D-20) and from the KV v2 API as documented for that release. Nothing was executed for this plan. Four facts are **source reading** only, and the test named beside each is the first real evidence — when the observation differs, the observation wins and goes into the run note:

- a write with `cas` equal to the current version succeeds when that current version is soft-deleted, and `cas: 0` fails for a path that has any metadata (Run 4.2 "create over deleted history", Run 4.4 "restore over a deleted current version");
- `kv/metadata/<path>` returns `created_time` per version and `oldest_version`, and drops the oldest version at the twenty-first write (Run 4.2 Task A);
- `kv/metadata/<prefix>?list=true` still lists a name whose every version is soft-deleted (Run 4.8 Task A);
- a soft delete or undelete of a version that is already in the target state answers 2xx (D-20 saw ten concurrent ones all answer 2xx; Run 4.4 asserts it for the sequential case).

---

## Global constraints

Every run's requirements include this section and the "Global constraints" of the plans of Sessions 1–3 (synthetic data only, real stores for proof, a skipped test is not a pass, the forbidden components, pins, limits live once in `@mykey/contracts`, remote work through `scripts/host.ts`, secrets only on stdin, one pipeline, contract commits, a denial must be a denial, database time).

- **Doc 10 §4.1 is at stake in every run of this session.** Read the eleven rules before starting. The ones this session can break: rule 1 (a value, or anything derived from one without a key, in PostgreSQL — index, operation, step, preview, import entry, job, audit), rule 2 (a value in a log line, an error body, a test failure message or the transcript), rule 3 (a timeout called a failure; a retry after a possible send), rule 4 (a partial environment set returned as complete), rule 7 (a write without expected version and state tag), rule 8 (a value released before its audit row is committed), rule 11 (`succeeded` without a read-back).
- **Values in code.** A secret value lives only in the memory of the request that carries it. It is never passed to a logger, an `Error` message, an audit detail, a job, an operation column or a test assertion that prints on failure. Functions that hold a value take it as a parameter named `value` or inside `entries`, both of which the log's second pass already redacts (P-42).
- **Values in tests.** Test values are synthetic and generated at run time (`synthetic-<uuid>`); canaries are assembled at run time (never a literal `MYKEY_CANARY_` followed by 32 characters). An assertion never compares a value with `toBe`/`toEqual`: compare `sha256(value)` digests, lengths or booleans (`expect(text.includes(canary)).toBe(false)`).
- **No retry of an effect.** A backend call that changes something is sent once. No helper, wrapper, job or test utility of product code repeats it. A function whose backend answer is `unknown` returns `unknown`; it does not look again and decide.
- **After the dispatch marker, every failure is `unknown`.** An exception, a lost connection, a rejected promise or a deadline in the dispatch, effect, read-back or finalize step answers `503 outcome_unknown` with the operation id — never another 4xx or 5xx (Review focus 1).
- **The lock connection.** A connection that holds an environment's advisory lock is used by one request, is unlocked before it goes back to its pool, and is destroyed (`release(true)`) when it had any error. Product code never reconnects to continue work that needed the lock.
- **The invariant check.** Every integration test file of this session that writes a secret ends each test with `expectIndexMatchesBackend(fixture, environmentId)` (Run 4.2 Task B): same names, versions and deleted flags in `app.secret_index` and in OpenBao, `environment.live_value_bytes` equal to the sum of the live rows, no effect slot and no advisory lock left — except where the test is about an uncertain operation and says which of these it expects instead.
- **Statuses.** Session 4 proves product code against real stores and on staging, not on the frozen release candidate: the registry moves an item to `SPIKE_PASS` or `FAIL`, never to `PASS` (P-61). A `SPIKE_PASS` needs a run note that states the id and the status on one line.
- **Migrations.** One migration per run that needs one, numbered in merge order from `0011`; never edit a merged migration. Every new table, column, function or grant extends `tests/harness/privilege-matrix.ts` and `docs/runbooks/db-globals-inventory.md` in the same commit.
- **Staging.** A staging test begins by asserting its target, creates its own project and environments with fresh names, and undoes every state change in `finally` (two Session 3 drills did not, and left an alert open). Inside a run, execute one file: `node scripts/require-staging-env.ts && pnpm exec vitest run --project staging tests/staging/<file>`.
- **Production is not touched** before the gate run, and there only with the owner's word.
- **CI.** After every push: `gh run list --branch session-4 --limit 3`; a red job is fixed in the run that pushed it.
- **Every run ends with:** `pnpm run check` green, the run's tests green, a commit on branch `session-4`, and a run note `docs/evidence/session-4/run-4.N.md` (template of Run 1.1: `What was done`, `Commits`, `Commands and results`, `Deviations and decisions`, `Open issues`).
- **Git.** Never commit on `main`. Worktrees, when used, live under `C:/Users/gmpar/mykey-wt/` (outside OneDrive). The pull request to `main` is opened at the gate and merged only when the owner says so.

## Review focus

Five conditions the specifications imply but do not spell out, most likely to bite first. Each has a test pinned in the run named.

1. **An uncertain write is reported as something else through a path nobody tested.** The finalizing transaction throws, the pool times out after the backend answered, the read-back fails with a 503 — and the handler's generic error path answers `dependency_unavailable`, so the client retries with a new key. → the rule "after the dispatch marker, every failure is `unknown`"; Run 4.2 Task B throws from a fault hook at each of five points after the marker and asserts `503 outcome_unknown` with `operationId` every time; Run 4.6 does the same with real process death.
2. **A lock outlives its request, or is lost without anyone noticing.** A pooled connection goes back with the advisory lock held and the environment is `busy` for ever; or the lock session dies mid-read and the read answers from a state another writer has already changed. → Run 4.2 Task B: after every test `pg_locks` holds no advisory lock of an idle connection; Run 4.3 and Run 4.8: `pg_terminate_backend` of the lock session between the backend reads and the audit commit discards the value and answers `503 dependency_unavailable`; Run 4.2: the same during a write is `outcome_unknown`.
3. **A value reaches a surface through an error.** A validation message that quotes the input, a Zod issue path with the string, an `unhandled` log entry with the request body, a Vitest diff of two values. → the two value rules above; Run 4.2 Task B sends an oversized and a NUL-carrying value built around a run-time canary and searches the response, every log entry and `audit.event`; Run 4.9 and the gate sweep every surface.
4. **The counters drift and lock the owner out.** `live_value_bytes` is not reduced by a delete, added twice by an undelete, or wrong after a reconciled write; the environment then answers `507 capacity_exceeded` with room to spare, or accepts a ninth mebibyte. → the invariant check after every test; Run 4.4 walks create → update → delete → undelete → restore → delete and asserts the byte total after each step; Run 4.5 rebuilds counters from the backend.
5. **A full-size environment does not fit the deadlines.** 1,000 names read one request at a time with a fresh TLS connection and inline authentication each; a 1,000-entry import with five backend calls per entry. The suite passes with ten keys and the owner's real environment times out, leaving an import `awaiting_input` or an export that never succeeds. → Run 4.2 Task D measures single requests on staging; Run 4.8 reads 1,000 names of 8 KiB on the local stack; Run 4.9 Task D builds 1,000 names of about 7 MiB on staging by import and exports them against a 60-second ceiling (P-62 names what happens above it); Run 4.10 imports 1,000 entries on staging.

## Planner decisions

Settled here so the executor does not have to choose. Each one marked **DR** gets a decision record in the run shown.

| # | Decision | Why | Run |
| --- | --- | --- | --- |
| P-61 | The registry ceiling in Session 4 is `SPIKE_PASS` (as P-38). "G-EFFECT closed for KV actions on the integrated product" and "G-RESOLVE proven" are sentences of the session report with test names, not `PASS`. | Gate R counts scenarios on one frozen build; `registry-verify.ts` lifts the rule in Run 8.7. | all |
| P-62 | The API's OpenBao identity is `runtime` with **inline AppRole authentication** on every request: `OpenBaoClient` accepts `auth: { token } \| { inline: { roleId, secretId } }` and sends the `X-Vault-Inline-Auth-*` headers of D-17. The API serves the one organization named in `/run/mykey/secrets/organization-id` (as the provisioner does). The start-up self-check stays a log line and a `status` field: it does **not** gate `/health` (Doc 06 §12 lists what does). A runtime call answered `denied` is drift: `503 backend_inconsistent` and the environment goes to review (P-72). If the export of 1,000 names takes more than 60 s on staging (Run 4.9 Task D), the fallback D-17 names is taken: one AppRole login token held in memory for 15 minutes. **DR D-34.** | D-17 chose inline and named its cost as the thing to measure here. Open issue "4.2: whether the self-check gates `/health`". | 4.2, 4.9 |
| P-63 | `app.operation` gains `project_id`, `environment_id`, `secret_name` and `parent_operation_id` (migration `0011`). An operation's status is visible to an owner or admin of its organization, and to the member who made it while `decide` still allows that member the operation's own action on its scope; to everyone else it is `404 not_found`, never 403. `operations.get` and `operations.list` take `action: null`, which puts them in state class `metadata_read`: status stays readable while a project or environment is in review. **DR D-35.** | Doc 04 §4.1: "the same scope authorization as the operation"; §1.2: in `needs_review` "authorized users may inspect non-secret status". The contract had both routes as `secrets.read`, which would hide an uncertain operation exactly when it matters. | 4.1 |
| P-64 | The operation's `target` stays the deepest scope id of the path (environment, project or organization). The intent fingerprint gains `params`: the path parameters that are not `org`, `project` or `env` (`name`, `preview`, `operation`, `credential`), added to the canonical text only when there is at least one — so the fingerprints stored in Session 3 still match. **DR D-35.** | Today `PATCH …/secrets/A` and `PATCH …/secrets/B` with one key and one body have the same target and the same fingerprint: the second would replay the first. | 4.1 |
| P-65 | Replay answers by stored state: `accepted`, `executing`, `awaiting_input` → 202 with the envelope; `succeeded` → the route's 200 or 201; `partial` → 200; `rejected` → the error envelope of the stored `error_code` with `operationId`; `uncertain` → `503 outcome_unknown` with `operationId`; a terminal row whose `replay_expires_at` has passed (database time), or a tombstone → `409 replay_expired`. A refusal **before** the admission commit leaves no operation (as D-33). A definite backend refusal **after** admission is `rejected` with a contract error code. `ops operations-expire` writes the tombstone and clears `fingerprint`, `fingerprint_key_id`, `expected` and `result` of expired terminal rows; the row itself stays (attribution, audit link). Unfinished rows never expire. Its timer is Run 6.9. **DR D-35.** | Doc 06 §3, §6.3; FR-1.83. `api_runtime` holds no `DELETE` on `app.operation`, and history needs the row. | 4.1 |
| P-66 | One connection per action. A second pool `lockPool` (8 connections per process; the main pool goes from 20 to 12, so `LIMITS.db.apiPool` holds) gives each mutation and each value read a dedicated connection. On it: `pg_advisory_lock(environment.lock_key)` with `lock_timeout` 2 s (`503 busy` on expiry), then every transaction of the action. The handle latches any connection error; a latched handle answers `outcome_unknown` after the marker and `dependency_unavailable` before it. **DR D-36.** | Doc 06 §6.1 (dedicated connection, never pooled with a lock), §6.2 step 5 ("on its original healthy execution connection"), §8 (final checks on the lock-holding connection). | 4.2 |
| P-67 | An effect slot `env:<environmentId>` held by another operation blocks every mutation, every import and every complete read of that environment with `409 key_under_review`, the holder's `operationId` in the envelope. A single-key reveal passes when the slot's operation names another secret and neither the key nor a parent is in review. **DR D-36.** | Doc 06 §6.1 (per-environment serialization), §8 ("whole-environment reads and new environment mutations remain blocked"); Doc 04 §8.1 names the 409 "unresolved key blocking mutation". | 4.2 |
| P-68 | Order inside an action, all under the lock: (a) backend pre-read of the key's metadata; (b) admission transaction: replay recheck, capture mode `idle`, parent states and the caller's authority re-read, slot, index row `FOR UPDATE` compared with the request and with the pre-read, capacity → operation `accepted`, step with `before_state`, slot, audit `intent`; (c) dispatch transaction: `accepted → executing` for this boot id, dispatch attempt id, gate still open; (d) one change; (e) read-back; (f) finalize. Backend answers: `ok` + read-back proves it → `succeeded`; `cas_mismatch` → `rejected` `backend_inconsistent`, key to review; `denied` → `rejected` `backend_inconsistent`, environment to review; `sealed` → `rejected` `backend_sealed`; `invalid` with status 0 (never connected) → `rejected` `dependency_unavailable`; any other `invalid` and every `unknown` → `uncertain`. A pre-read that fails or disagrees with the index answers before admission and leaves no operation. **DR D-36.** | Doc 06 §6.2, §6.3 ("index absence is checked against backend metadata under exclusion; inconsistency enters review"), D-20. | 4.2 |
| P-69 | A stale-work sweep runs in the API every 30 s: a secret operation that is `executing` with `heartbeat_at` older than 120 s becomes `uncertain` (its key `needs_review`, slot kept), by a conditional update that also clears `executor_boot_id` — so the old executor can no longer finalize. One that is still `accepted` has no dispatch marker, so nothing was sent: it becomes `rejected` and its slot is released. An import parent with no child in flight becomes `awaiting_input` instead (Run 4.7). The sweep never sends anything. `status.sh` counts `operationsUnresolved` (uncertain, or stale as above) and the probe gains the condition `operations_unresolved`. **DR D-38.** | Doc 06 §6.2 step 6 ("sets or subsequently recovers to `uncertain`"), §11 (two minutes; no takeover); FR-1.88; P-57 (the heartbeat is the only way a host speaks). | 4.5 |
| P-70 | A state tag is 16 random bytes in base64url. `secret_index.live_value_bytes` is the byte length of the current version's value, kept while that version is deleted; `environment.live_value_bytes` sums the rows in state `live`. The name limit counts every index row. A create's index row is written at finalize; an uncertain create writes it as `needs_review` with a null version. | Doc 06 §6.3. Undelete must check capacity before its effect and cannot read a deleted value to learn its length. | 4.2, 4.4 |
| P-71 | Audit actions of this session: `secret.create`, `secret.update`, `secret.delete`, `secret.undelete`, `secret.restore`, `secret.reveal`, `secret.export`, `import.preview`, `import.apply`, `import.resume`, `system.operation_stuck`, `operator.reconcile_operation`, `operator.reconcile_environment`, `operator.operations_expire`. Target is the environment; `details.name` carries the secret name (the one string allowed up to 128 characters, checked with `SECRET_NAME_PATTERN`); never a value, a length of a value, or a digest. `AuditEvent.outcome` gains `intent` and `unknown`. `system.drift_detected` gains the object `kv_data`. **DR D-36.** | FR-1.56, FR-1.58 (filter by resource), FR-1.81 (intent before the effect). A reveal has no operation: without the name its audit row says nothing. | 4.2 |
| P-72 | The API puts a key into review through `secret_index.state` (a right it has). It puts an environment into review through `app.mark_environment_review(organization_id, environment_id)`: `SECURITY DEFINER`, fixed `search_path`, owned by `migration_owner`, `EXECUTE` for `api_runtime` only; it moves `pending` or `active` to `needs_review` with reason `backend_inconsistent` and does nothing else. Only the operator clears a review. Migration `0012`. **DR D-36.** | Migration `0010` took `review_reason` from the API on purpose; Doc 06 §3 allows a reviewed security-definer function. | 4.2 |
| P-73 | `secrets.list` reads the index only: order `name COLLATE "C"`, `prefix` must match `^[A-Z][A-Z0-9_]{0,127}$` and is matched with `starts_with`, the cursor binds route, `org/project/env`, the prefix, the last name and `environment.metadata_generation` (`409 listing_changed` when it moved). `secrets.history` reads OpenBao metadata and joins `secret_version_event`; a version without an event has actor `unknown`; any query parameter is `400 unsupported_history_parameter`. `secrets.reveal` runs under the lock (P-66) and commits `secret.reveal` on the lock connection before answering. **DR D-37.** | Doc 06 §7.2, §8, §9; FR-1.21, FR-1.26. | 4.3 |
| P-74 | Restore: `sourceVersion` must be lower than `expectedVersion` (`422 validation_failed` otherwise) and readable in the backend — a trimmed, deleted or destroyed source is `409 state_conflict`. The source value is read in memory under the lock and written as a new version with `cas` = expected current version, whether that version is live or deleted. | FR-1.29. | 4.4 |
| P-75 | Reconciliation is three operator commands: `ops operations --organization <id>` (lists unresolved operations), `ops reconcile-operation --operation <id> [--executors-excluded yes]`, `ops reconcile-environment --environment <id>`. Rules per action in Run 4.5. "Executors excluded" is established by a new `host.ts <host> quiesce` (gate closed, `api` and `provisioner` stopped, OpenBao restarted and unsealed) and ended by `resume`; the command takes the operator's word as the flag and records it. Every settlement rebuilds the key's index row and the environment's counters from the backend, writes a fresh state tag, raises the generation, and is audited. **DR D-38.** | Doc 06 §6.4; D-20 ("exclusion means process death, and a restart when a request may be on its way"); P-45 (`maintenance` records it). | 4.5 |
| P-76 | Import. Preview runs under the lock, reads current values in memory to classify `unchanged`, and stores names, classifications, observed versions and tags, and `HMAC-SHA-256(replay-fingerprint key, "import-file" ‖ 0x00 ‖ file bytes)`. A file that does not parse, or has an invalid or duplicate entry, answers 200 with `applicable: false` and stores nothing. Apply runs **inside its request**: entries in file order, each a child operation with key `<parentId>:<ordinal>`, the lock released between entries; after 100 s of work the parent becomes `awaiting_input` and the answer is 202. Refusals: unknown or foreign preview `404`; expired or already claimed `409 state_conflict`; other bytes `422 validation_failed`. **DR D-39.** | Doc 06 §8 "Import"; §6.2 (a value-carrying effect cannot be queued); §11 (120 s for a bounded import). No new key ring: custody stays untouched. | 4.7 |
| P-77 | At most two large requests per process (`LIMITS.concurrency.largePerProcess`): import preview, apply, resume, export, and later machine resolve. A third answers `503 busy` before its body is buffered further. | Doc 06 §11. | 4.7 |
| P-78 | The complete read: lock → transaction: states, authority, slot, no index row in review → `kvList` compared with the index's names → every live name read (eight at a time), each checked for version, envelope and byte length against the index → total size checked → on the same connection: generation unchanged, slot still free, audit row committed → unlock → return. A mismatch puts the key or the environment into review and answers `503 backend_inconsistent`; any failed read discards everything. **DR D-37.** | Doc 06 §8; FR-1.84. | 4.8 |
| P-79 | Export answers `200`, `content-type: text/plain; charset=utf-8`, `content-disposition: attachment; filename="mykey-<environment name>.env"`, `content-length`, `content-digest: sha-256=:<base64>:`, `x-content-type-options: nosniff`, and `mykey-export-warnings`: base64url JSON of `[{name, loader, kind}]`, or `{"truncated":true,"count":n}` above 8 KiB. `HandlerResult` gains `raw` for the one response kind `dotenv-attachment`. **DR D-37.** | Doc 06 §8, FR-1.34, FR-1.37. The route list is frozen, so warnings travel with the answer. | 4.9 |
| P-80 | The pipeline matrix (`tests/integration/authz/matrix.test.ts`) runs with `stubs: "all"`: every contract route answers through the harness stub after the pipeline, handler or not. Real handlers are covered by `tests/integration/authz/matrix-live.test.ts` (Run 4.9): the named cases against a provisioned organization. Amends item 6 of "What Session 4 must know". | The matrix tests the pipeline. With real handlers an allowed cell needs a real secret, a real preview and a real backend to answer 2xx, and an absent secret answers the same 404 as a hidden one. | 4.1, 4.9 |
| P-81 | Deploys to staging happen in Runs 4.2 (runtime identity and the first write), 4.5 (lifecycle, the uncertainty drill and `quiesce`), 4.9 (import, export and the full-size measurement) and 4.10 (the final commit). The other runs are proven on the local stack and on staging with the next deploy. | A deploy closes staging for about ten minutes; inline authentication through the bound address is the host-only risk, and it is met in the first deploy. | 4.2, 4.5, 4.9, 4.10 |
| P-82 | The Run 2.4 spike (`@mykey/operations/spike`) is not extended and not imported by product code. It stays for the two backup tests that use it until Run 6.5 rebuilds capture; its fault suites stay as the proof of D-20. Run 4.6 writes a new suite on product code. | Replacing the spike under the backup rehearsal is Run 6.5's work, not this session's. | 4.6 |
| P-83 | The queue `environment.provision` gets a job expiry of 120 s, so a job held by a killed provisioner is retried within about two minutes instead of fifteen. | Open issue of the Session 3 report; a retried provisioning step is compare-then-act (P-55) and therefore safe. | 4.1 |

## Carried items

The open issues and deferred minors of the Session 3 report, each with its place.

| Item | Where |
| --- | --- |
| Operation status routes, tombstones, `replay_expired`, scope `operation` | Run 4.1 |
| A job held by a killed provisioner waits 15 minutes | Run 4.1 Task D (P-83) |
| Environment activation without `state = 'pending'` and a claim re-check | Run 4.1 Task D |
| A queue-privilege test that accepts any error | Run 4.1 Task D |
| Operation-scope rows in the matrix | Run 4.1 Task C |
| The in-transaction admission recheck has no test that changes state after the pipeline | Run 4.2 Task C (the secret protocol's recheck); Run 4.1 Task D for the resource routes |
| Whether the API self-check gates `/health` | P-62: no |
| The reconciliation command; an environment's review cleared through the superuser | Run 4.5 |
| `kv-scope` compares two of the three config fields | Run 4.5 Task C |
| The "denied ends the job at once" branch is not isolated | Run 4.5 Task C |
| Drift detection on a request | Run 4.2 (code: P-68, P-72); Run 4.5 Task B (its test, with the operator's way back) |
| Effects without an operation marker: soft delete, undelete | Runs 4.5, 4.6. Issuance, revocation, archive stay with Runs 5.2, 5.3 |
| Re-run the matrix on real handlers | P-80; Run 4.9 Task C |
| Archive and reactivate need their own grants | Run 5.3 |
| A reset test that proves nothing about rights; Better Auth writes `expires_at` on the API clock; the general rate limits (reveal 30/min, import and export 5/min included) | Run 6.x (6.3 for the limits) |
| A timer for `ops auth-cleanup` and for `ops operations-expire` | Run 6.9 |
| The auth module writes SQL directly; the API image holds unreachable operator and provisioner sources | Session 8 |
| The reset page's duties | Run 7.x |
| Load flakes: `exclusion.test.ts`, `health.test.ts` `afterAll`, the ops kill-point cases | Run 4.10 Step 1 (run alone when they fail under the whole suite; list them) |
| The workstation copy of the `provisioner_runtime` password is obsolete | Run 4.10 Step 2 (remove the file, update `credential-custody.md`) |
| R2 fixture guard 15 Nov 2026 09:42 UTC; checkpoint `pairs-lock-session-gate` from 15 Nov 10:42 UTC; `.trivyignore.images` 20 Nov | Run 4.10 Steps 1–3 |
| Production stays behind a gate that is not open | owner decision; Run 4.10 Step 6 only updates image and migrations, with the owner's word |

## Session start (before Run 4.1)

- [ ] **Step 1 — Branch.** Branch `session-4` already exists on the remote; its first commit is this plan (`docs: session 4 plan`). `git fetch origin && git switch session-4 && git pull`, then `git merge origin/main` if `main` moved since.
- [ ] **Step 2 — One message to the owner**, then start Run 4.1 without waiting. Save the text as `docs/evidence/session-4/owner-requests.md`. It contains:
  1. **Nothing to buy and nothing to click in this session.**
  2. **Expect Telegram alerts from staging** during four deploy windows (Runs 4.2, 4.5, 4.9, 4.10 — staging starts closed after every deploy) and during two deliberate drills (Run 4.5 and the gate): a write is made uncertain on purpose, which raises the new alert `operations_unresolved`, and staging is then closed for about ten minutes of maintenance. Each window is announced in its run note; an alert outside those windows is real.
  3. **One yes/no, needed only at the gate:** may the gate run bring production to the current migrations and API image, with its gate still not open? Default when there is no answer: no.
  4. **For information:** from 15 Nov 2026 09:42 UTC `pnpm run test:cloud` fails on purpose (the R2 fixture guard) until Run 6.6; `.trivyignore.images` expires on 20 Nov 2026 and is reviewed again at this session's gate; all KMS certificates expire on 12 Dec 2026.
- [ ] **Step 3 — When the owner answers** (in any run): record the answer in `owner-requests.md`, commit.

## Run order

```text
4.1 ─→ 4.2 ─→ 4.3 ─→ 4.4 ─→ 4.5 ─→ 4.6 ─→ 4.7 ─→ 4.8 ─→ 4.9 ─→ 4.10
```

- Inline execution takes this order. What may move when a run is blocked:
  - Run 4.3 needs only Run 4.2 and touches read routes and their tests; it is the one run that could go to a parallel worktree.
  - Run 4.6 may follow Run 4.7 instead of preceding it (its import cases are in Run 4.7 Task C either way).
- Fixed dependencies: Run 4.5 needs Run 4.4 (it settles all five actions); Run 4.7 needs Run 4.5 (sweep, settlement); Run 4.8 needs Run 4.7 (the large gate, an import as a writer in the race); Run 4.9 needs Runs 4.7 and 4.8 (round trip, complete read).
- Migrations: `0011_operation_scope` (4.1), `0012_environment_review` (4.2). A later run that needs one takes the next number.
- **Scope valves (Doc 10 §8.2).** Two features of this session are valves: import resume (valve 3, Run 4.7 Task C) and restore of an old version (valve 5, Run 4.4). If Run 4.6 ends more than one day behind (after 16 Nov 2026 12:00 UTC), propose valve 3 to the owner in one line and continue with Run 4.7 Tasks A–B while waiting; valves 1 and 2 come first in the order but belong to later sessions, so say that in the message.

## File map

```text
packages/contracts/src/        routes.ts (five pending bodies filled; operations.* action null; error lists)  operation.ts
packages/db/src/schema/app.ts  operation: project_id, environment_id, secret_name, parent_operation_id
packages/db/migrations/        0011_operation_scope.sql   0012_environment_review.sql
packages/db/src/repos/         operations.ts (admit, claim, finish, list, expire)   secrets.ts (index, events, counters)
                               slots.ts   imports.ts
packages/openbao/src/          client.ts (auth: token | inline; kvMetadata createdAt, oldestVersion)
packages/audit/src/events.ts   the actions of P-71; outcomes intent, unknown
packages/operations/src/       replay.ts (params, replayAnswer)   runtime.ts (RuntimeBao)
  secrets/                     lock.ts  protocol.ts  actions.ts  reveal.ts  read-environment.ts  history.ts  sweep.ts
  imports/                     classify.ts  preview.ts  apply.ts
  reconcile/                   operation.ts  environment.ts  rebuild.ts      entry point "@mykey/operations/operator"
packages/operations/src/provisioning/environment.ts   activation guard; kv-scope compares three fields
apps/api/src/                  runtime-bao.ts  large.ts (semaphore)  operation-sweep.ts  server.ts (lockPool, bao, sweep)
  pipeline/                    route.ts (params, replay table, raw answer)  respond.ts (operationId, details)
                               authz.ts (scope operation)  context.ts
  routes/                      operations.ts  secrets.ts  imports.ts  export.ts
apps/ops/src/commands/         operations.ts  operations-expire.ts  reconcile-operation.ts  reconcile-environment.ts
scripts/host.ts                quiesce, resume
infra/hosts/checks/status.sh   operationsUnresolved
workers/probe/src/evaluate.ts  condition operations_unresolved
tests/harness/                 api.ts (runtime, stubs "all", faults)  api-process.ts  secrets-fixture.ts
tests/integration/             operations/  secrets/  reconcile/  imports/  read/  export/  authz/matrix-live.test.ts
tests/fault/secrets/           fixture.ts  boundaries.test.ts  delays.test.ts  imports.test.ts
tests/staging/                 secrets.staging.test.ts  reconcile.staging.test.ts  export.staging.test.ts
docs/decisions/                D-34 … D-39 (D-40 only if the complete-read fallback is taken)
docs/runbooks/                 reconciliation.md   provisioning.md (review cleared by the operator)
docs/evidence/session-4/       run-4.1.md … run-4.10.md  owner-requests.md  canary-sweep.txt  report.md
```

---

## Run 4.1 — Operation records and replay (D08-S18)

**Files:** `packages/contracts/src/{routes,operation}.ts` (+ `openapi.json`, pending snapshot), `packages/db/src/schema/app.ts`, `packages/db/migrations/0011_operation_scope.sql`, `packages/db/src/repos/operations.ts`, `packages/db/src/index.ts`, `packages/operations/src/{replay,index,jobs}.ts`, `packages/operations/src/provisioning/environment.ts`, `apps/api/src/pipeline/{route,respond,authz,context}.ts`, `apps/api/src/routes/operations.ts`, `apps/api/src/app.ts`, `apps/ops/src/commands/operations-expire.ts`, `apps/ops/src/cli.ts`, `tests/harness/{api,privilege-matrix}.ts`, `tests/unit/operations/replay.test.ts`, `tests/unit/api/respond.test.ts`, `tests/integration/operations/{records,replay,status}.test.ts`, `tests/integration/authz/matrix.test.ts`, `tests/integration/provisioning/environment.test.ts`, `tests/integration/jobs/privileges.test.ts`, `docs/decisions/D-35-operation-records-and-replay.md`, `docs/runbooks/db-globals-inventory.md`.

**Consumes:** Session 3: `mountRoute`, `beginOperation`, `findOperationByKey`, `operationResponse`, `sameIntent`, `resolveAccess`, `decide`, `signCursor`/`readCursor`, `createTenants`, `startTestApi({ routes, stubs })`, `appendAudit`, the `ops` frame.

**Produces:**

```ts
// @mykey/db — repos/operations.ts
export interface OperationRow { /* as today, plus: */ projectId: ProjectId | null; environmentId: EnvironmentId | null; secretName: string | null;
  parentOperationId: OperationId | null; expected: Record<string, unknown> | null; executorBootId: string | null; dispatchedAt: Date | null; heartbeatAt: Date | null;
  /** replay_expires_at < now(), computed in the statement. */ expired: boolean }
export type NewOperation = /* as today, plus */ { projectId?: ProjectId; environmentId?: EnvironmentId; secretName?: string; parentOperationId?: OperationId; expected?: Record<string, unknown>; executorBootId?: string };
export function claimDispatch(tx: pg.PoolClient, id: OperationId, bootId: string): Promise<boolean>;   // accepted → executing; dispatched_at, heartbeat_at = now()
export type Finish = { state: "succeeded" | "partial"; result: Record<string, unknown> } | { state: "rejected"; errorCode: ErrorCode } | { state: "uncertain" } | { state: "awaiting_input" };
export function finishOperation(tx: pg.PoolClient, id: OperationId, bootId: string, finish: Finish, retentionDays: number): Promise<OperationRow | null>; // null: this boot id no longer owns it, or it is terminal — nothing changed
export function touchOperation(tx: Queryable, id: OperationId, bootId: string): Promise<boolean>;      // heartbeat_at = now() while the owner
export function hasTombstone(db: Queryable, key: OperationKey): Promise<boolean>;
export function listOperations(db: Queryable, scope: EnvironmentScope, filter: { principalId: string | null; unfinishedOnly: boolean },
  page: { anchor: string | null; after: string | null; limit: number }): Promise<(OperationRow & { sortKey: string })[]>;   // sortKey "<created_at as text with microseconds>|<id>", newest first
export function expireOperations(tx: pg.PoolClient): Promise<number>;                                    // maintenance only
// @mykey/operations — replay.ts
export interface Intent { principalKind: string; principalId: string; action: string; target: string; params?: Record<string, string>; body: unknown }
export type ReplayAnswer = { status: 200 | 201 | 202; body: OperationResponse } | { error: ErrorCode; operationId?: OperationId };
export function replayAnswer(route: RouteDef, row: OperationRow): ReplayAnswer;                          // the table of P-65
// apps/api — pipeline
export class ApiError { constructor(code: ErrorCode, reason?: string, headers?: Record<string, string>, extra?: { operationId?: string; details?: Record<string, unknown> }) }
export function errorResponse(code: ErrorCode, requestId: string, headers?: Record<string, string>, extra?: { operationId?: string; details?: Record<string, unknown> }): Response;
export function intentOf(route: RouteDef, params: Record<string, string>, principal: Principal, body: unknown): Intent;   // target and params as P-64; the one place they are derived
```

Design fixed here (P-63, P-64, P-65; Doc 06 §3, §6.3, §9; Doc 04 §4.1):

- **Contract commit** `contract: operation status and list`. `operations.get`: `action: null`. `operations.list`: `action: null`; query `z.strictObject({ limit, cursor, state: z.enum(["unfinished"]).optional() })`; `200 { operations: [{ operationId, action, state, name: string | null, createdAt, completedAt: string | null, replayExpiresAt: string | null, errorCode: string | null, mine: boolean }], nextCursor: string | null }`. `operationResponse` puts `result: { errorCode }` on a `rejected` row and nothing on an `uncertain` one. `tests/unit/authz/route-actions.test.ts` and the pending snapshot follow.
- **Error details** are an allowlist in `respond.ts`: `version_conflict` → `{ currentVersion: int, currentStateTag: string, state: "live" | "deleted" }`; `capacity_exceeded` → `{ limit: "names" | "bytes" | "response" }`; every other code takes none. Details that do not match their schema are dropped and logged as `output_invalid`. `operationId` is accepted for every code.
- **Migration `0011`:** the four columns (`secret_name` with the name pattern as a check; `parent_operation_id` references `app.operation`); backfill `environment_id` and `project_id` of existing rows from `target` (an environment id gives both, a project id gives the project); indexes `operation_environment_created_idx (environment_id, created_at DESC, id DESC)` and `operation_unresolved_idx (state) WHERE state IN ('accepted','executing','awaiting_input','uncertain')`. No grant changes: `api_runtime` already inserts into every `app` table and updates the listed columns; the new columns are written at insert only. Read the generated SQL (CLAUDE.md "New migration").
- **`finishOperation`** is one conditional update: `WHERE id = $1 AND executor_boot_id = $2 AND state IN ('accepted','executing')`. `succeeded`, `partial` and `rejected` set `completed_at` and `replay_expires_at = now() + 30 days`; `uncertain` and `awaiting_input` set neither and clear nothing but the state. Session 3's `completeOperation` stays for the database-only routes.
- **The pipeline's replay step** uses `intentOf` and `replayAnswer`. The lookup reads `expired` in SQL; when no row is found it asks `hasTombstone`. A stored `error_code` that the route does not list is answered as `dependency_unavailable` and logged `unlisted_error`, as today.
- **Scope `operation`** (`authorize`): a non-UUID id, an unknown id, or a row without `organization_id` is hidden. Otherwise `resolveAccess(user, { organizationId, projectId?, environmentId? })` from the row; allowed when the role is owner or admin, or when `principal_kind = 'user' AND principal_id = userId` and `decide(authority, target, actionOfOperation)` is `allow`, where `actionOfOperation` is the `action` of the contract route whose id equals `operation.action` (`resources.manage` when there is none). Everything else is hidden. `ApiContext` gains `operation: OperationRow | null`.
- **The list** returns operations of the path's environment with `parent_operation_id IS NULL`; a member sees rows whose principal is that member, an owner or admin all rows. Newest first. The first page's first `sortKey` is the anchor and travels in the cursor's `generation` field; later pages return only rows at or below the anchor, so new operations never disturb paging and the list never answers `listing_changed`.
- **`ops operations-expire`** runs `expireOperations` as `maintenance` in one transaction, writes one audit row `operator.operations_expire` with `details: { expired: <count> }`, prints the count.
- **`startTestApi({ stubs: "all" })`** (P-80): the stub replaces every contract route's handler, `health.get` and `version.get` excepted.

### Task A — records

- [ ] **Step 1 — Failing tests** (`records.test.ts`; `prepareDatabase`, pools `api_runtime` and `maintenance`, two connections where a race is named):
  - `two inserts of one key at once: one inserted, the other waits and then finds it`.
  - `claimDispatch moves accepted to executing once` — a second call and a call with another boot id answer `false`; the row is unchanged.
  - `finishOperation by another boot id changes nothing and answers null`; `a terminal row is never overwritten` (succeeded → a later `rejected`, `uncertain` and `succeeded` each answer null; `result` and `completed_at` unchanged).
  - `succeeded sets a replay expiry 30 days ahead on database time; uncertain and awaiting_input set none`.
  - `expireOperations` (as `maintenance`): a terminal row aged past its expiry gets a tombstone and loses fingerprint, key id, expected and result, keeps id, principal, action, target, state and times; an `uncertain` row aged 60 days is untouched; `api_runtime` cannot run it (permission denied on the tombstone insert or the delete-free update — assert the SQLSTATE `42501`).
  - `the new columns hold what was inserted; a secret_name outside the pattern is refused by the database`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Migration `0011`, schema, repository.** **Step 4 — Run:** PASS; `pnpm run db:check`. **Commit** `feat(db): operation scope columns, dispatch claim, conditional finish, expiry`.

### Task B — replay

- [ ] **Step 1 — Failing tests.**
  - `tests/unit/operations/replay.test.ts`: the fixed vector of Run 3.9 is unchanged for an intent without `params`; an intent with `params: { name: "A" }` differs from the same intent with `{ name: "B" }` and from one without params; `replayAnswer` for each state of the table (seven rows and the expired case), with a route whose completed status is 201 and one whose is 200.
  - `tests/unit/api/respond.test.ts`: `operationId` appears in the envelope; `version_conflict` details pass their schema; a detail key outside the allowlist is dropped; details on a code that takes none are dropped.
  - `replay.test.ts` (integration; a test-only idempotent route `POST /v1/organizations/:org/projects/:project/environments/:env/test-ops/:name` mounted through `routes`, whose handler inserts an operation in the state the body names and answers from it):
    - each stored state gives exactly the status, code and `operationId` of P-65;
    - `the same key and body with another :name → 409 idempotency_conflict` (control: the same `:name` replays);
    - `the same key with another body → 409 idempotency_conflict`;
    - `a terminal row aged past its expiry → 409 replay_expired`; `after ops operations-expire the same key still → 409 replay_expired, and the status route still answers 200 with the state and no result`;
    - `an uncertain row aged 60 days still answers 503 outcome_unknown` (unfinished never expires);
    - `a rejected row whose error_code the route does not list answers dependency_unavailable and logs unlisted_error` (the test consumes the log entry);
    - `replay happens before the state check: with the environment set to needs_review a completed request still replays, and a new key gets backend_inconsistent`;
    - `a replay by a user whose grant was removed is 404` (control before the removal).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** (`intentOf`, `replayAnswer`, `ApiError`, `errorResponse`, the pipeline step; `ops operations-expire`). **Step 4 — Run:** PASS, and the whole `tests/integration/resources` directory (Session 3's replay cases must not move). **Commit** `feat(api): replay answers by state, path parameters in the intent, expiry`.

### Task C — status and list

- [ ] **Step 1 — Contract commit** (above).
- [ ] **Step 2 — Failing tests** (`status.test.ts`; `createTenants`; operations inserted through the test route of Task B as `ownerA`, `adminA`, `editorA` in environment 1a):
  - `the owner reads an operation of the editor; the editor reads its own; the editor gets 404 for the admin's operation in the same environment`.
  - `ownerB gets a 404 that equals the 404 of a random id` (status, header names, body but for `requestId`, length — the helper of `concealment.test.ts`).
  - `the editor's grant is removed: its own operation is 404 on the next request` (control before).
  - `readerA made no operation and sees none; envEditorA reads its own in 1a and gets 404 for an id of 1b`.
  - `a non-UUID id is 404`; `an operator's operation (no organization) is 404 for the owner`.
  - `the environment in needs_review: the status is still 200` (control: `secrets.list` there is `503 backend_inconsistent` through the stub); `the organization in needs_review: 503 backend_inconsistent`.
  - `the body's keys are exactly those of the envelope` — no `fingerprint`, `expected`, `idempotencyKey`, `principalId`.
  - List: `a member sees only its own; the owner sees all; children are not listed`; `state=unfinished` returns `accepted`, `executing`, `awaiting_input`, `uncertain` only; 120 operations page 50/50/20 in newest-first order, disjoint and complete; `an operation made between two pages does not appear and does not disturb them`; a cursor of another environment or of `projects.list` → `400 malformed_request`; `limit=0` and `limit=101` → 422.
  - `matrix.test.ts`: switch to `stubs: "all"`; add the rows for `operations.get` (the four targets: own operation, another member's, another organization's, absent) and `operations.list`; regenerate `docs/evidence/session-3/authorization-matrix.md` into `docs/evidence/session-4/authorization-matrix.md` if the test writes it.
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Implement.** **Step 5 — Run:** PASS; `pnpm run contracts:openapi`; `pnpm run check`. **Commit** `feat(api): operation status and list`.

### Task D — carried minors

- [ ] **Step 1 — Failing tests.**
  - `environment.test.ts`: `activation requires the environment to be pending and the claim to be current` — the environment is set to `needs_review` by the superuser after the last step and before activation (crash point `token-role:after-record`, then a restart with the row changed): it stays `needs_review`, the operation does not end `succeeded`. `a job held by a killed provisioner is taken again within three minutes` (kill at `machine-policy:before`; a second provisioner finishes it; one policy, one role).
  - `tests/integration/jobs/privileges.test.ts`: the denial asserts SQLSTATE `42501` and the object named, not "any error".
  - `tests/integration/resources/projects.test.ts`: `the admission recheck sees a state that changed after the pipeline` — `startTestApi` gains `beforeHandler?: (routeId) => Promise<void>` (runs after freshness, before the handler); the hook sets the organization to `needs_review` through the superuser; `projects.create` answers `503 backend_inconsistent` and nothing is created.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** (the `UPDATE … WHERE state = 'pending'` and a check that the operation is still `executing` under this worker; `expireInSeconds: 120` in `QUEUE_OPTIONS` — read `node_modules/pg-boss/docs` for the option name in 12.38.1 and for whether an existing queue needs `updateQueue`; the hook). **Step 4 — Run:** PASS. **Commit** `fix(provisioner): activation guard and job expiry; stricter privilege and admission tests`. Write D-35.

**Registry:** `FR-1.82`, `FR-1.83` → `SPIKE_PASS` after Run 4.6 (records and replay here; "no external effect tracked only in a lost transaction" needs the fault suite — the run note says so and Run 4.6 sets the status). **Covers:** FR-1.82, FR-1.83. **Done when:** concurrent identical requests produce one operation; a changed payload or path under the same key conflicts; a revoked caller gets 404 for a known operation id.

---

## Run 4.2 — Mutation protocol with create and update (D08-S19)

**Files:** `packages/openbao/src/client.ts`, `packages/audit/src/events.ts`, `packages/db/migrations/0012_environment_review.sql`, `packages/db/src/repos/{secrets,slots}.ts`, `packages/db/src/index.ts`, `packages/operations/src/{runtime,index}.ts`, `packages/operations/src/secrets/{lock,protocol,actions}.ts`, `apps/api/src/{runtime-bao,server,app}.ts`, `apps/api/src/pipeline/context.ts`, `apps/api/src/routes/secrets.ts`, `tests/harness/{api,api-process,api-worker,secrets-fixture,privilege-matrix}.ts`, `tests/unit/audit/events.test.ts`, `tests/integration/openbao/inline.test.ts`, `tests/integration/secrets/{create,update,capacity,protocol}.test.ts`, `tests/staging/secrets.staging.test.ts`, `docs/decisions/{D-34-runtime-identity,D-36-mutation-protocol}.md`.

**Consumes:** Run 4.1 (`claimDispatch`, `finishOperation`, `touchOperation`, `intentOf`, `ApiError` with `operationId` and details, `beforeHandler`); Session 3 (`lockParents`, `resolveAccess`, `decide`, `checkStates`, `readGate`, `createProvisioningFixture`, `startApiProcess`); `OpenBaoClient`, `secretPath`, `environmentPrefix`; `checkSecretName`, `checkSecretValue`, `LIMITS.environment`, `LIMITS.deadlines`.

**Produces:**

```ts
// @mykey/openbao — client.ts
export type BaoAuth = { token: string } | { inline: { roleId: string; secretId: string } };
new OpenBaoClient(target, { namespace, token })            // unchanged
new OpenBaoClient(target, { namespace, auth: BaoAuth })    // inline: X-Vault-Inline-Auth-Path "auth/approle/login", -Namespace, -Parameter-role, -Parameter-secret (base64url JSON {key,value}); no X-Vault-Token
kvMetadata(path): BaoResult<{ currentVersion: number; oldestVersion: number; versions: Record<string, { createdAt: string; deleted: boolean; destroyed: boolean }> }>
// @mykey/operations — runtime.ts
export interface RuntimeBao { clientFor(organizationId: OrganizationId): OpenBaoClient | null }   // null: this process holds no credential for it
// apps/api — runtime-bao.ts
export function runtimeBaoFromDirectory(target: OpenBaoTarget, directory: string): RuntimeBao;    // reads organization-id, runtime-role-id, runtime-secret-id; retries the read on each call until the files exist, then keeps them
// @mykey/db — repos/secrets.ts, repos/slots.ts
export interface IndexRow { name: string; currentVersion: number | null; stateTag: string; state: "live" | "deleted" | "needs_review"; liveValueBytes: number; lastChangedAt: Date; lastOperationId: OperationId | null }
export function lockIndexRow(tx: pg.PoolClient, scope: EnvironmentScope, name: string): Promise<IndexRow | null>;      // FOR UPDATE
export function environmentCounters(tx: pg.PoolClient, scope: EnvironmentScope): Promise<{ names: number; liveBytes: number; generation: bigint; lockKey: bigint }>;
export function writeIndexRow(tx: pg.PoolClient, scope: EnvironmentScope, row: Omit<IndexRow, "lastChangedAt">): Promise<void>;   // upsert; last_changed_at = now()
export function applyCounters(tx: pg.PoolClient, scope: EnvironmentScope, liveBytesDelta: number): Promise<bigint>;    // metadata_generation + 1, live_value_bytes + delta; answers the new generation
export function recordVersionEvent(tx: pg.PoolClient, scope: EnvironmentScope, e: { name: string; version: number; operationId: OperationId | null; actorKind: "user" | "operator" | "system" | "unknown"; actorId: string | null; action: string }): Promise<void>;
export function markKeyReview(tx: Queryable, scope: EnvironmentScope, name: string, operationId: OperationId | null): Promise<void>;   // upsert state needs_review, fresh tag
export function markEnvironmentReview(db: Queryable, scope: EnvironmentScope): Promise<void>;     // SELECT app.mark_environment_review($1, $2)
export function slotOf(tx: Queryable, scope: EnvironmentScope): Promise<{ operationId: OperationId; secretName: string | null } | null>;
export function takeSlot(tx: pg.PoolClient, scope: EnvironmentScope, operationId: OperationId, stepId: string, generation: bigint): Promise<void>;
export function releaseSlot(tx: pg.PoolClient, operationId: OperationId): Promise<void>;
// @mykey/operations — secrets/lock.ts
export interface Locked { client: pg.PoolClient; lost(): boolean }
export class Busy extends Error {}
export function withEnvironmentLock<T>(lockPool: pg.Pool, lockKey: bigint, fn: (locked: Locked) => Promise<T>, waitMs?: number): Promise<T>;
// @mykey/operations — secrets/protocol.ts
export type SecretAction = "create" | "update" | "delete" | "undelete" | "restore";
export const FAULT_POINTS = ["after_admission", "after_dispatch_marker", "after_send", "after_read_back", "before_finalize_commit", "after_finalize"] as const;
export interface EffectDeps { pool: pg.Pool; lockPool: pg.Pool; bao: RuntimeBao; bootId: string; ring: HmacRing; gateOpen: () => boolean;
  faults?: (point: (typeof FAULT_POINTS)[number], operationId: OperationId) => void | Promise<void> }
export interface SecretRequest { action: SecretAction; routeId: string; scope: EnvironmentScope; userId: UserId; name: string; value?: string;
  expected?: { version: number; stateTag: string }; sourceVersion?: number; idempotencyKey: string; intent: Intent; requestId: string;
  parent?: { operationId: OperationId; ordinal: number } }
export type SecretOutcome =
  | { kind: "succeeded" | "replay"; operation: OperationRow }
  | { kind: "refused"; code: ErrorCode; operationId?: OperationId; details?: Record<string, unknown> }
  | { kind: "unknown"; operationId: OperationId };
export function runSecretAction(deps: EffectDeps, request: SecretRequest): Promise<SecretOutcome>;
export const freshStateTag: () => string;
// tests/harness/secrets-fixture.ts
export function createSecretsFixture(opts?: { private?: boolean; processes?: 1 | 2 }): Promise<SecretsFixture>;   // tenants, organization A provisioned, provisioner run once, API with runtime identity
export function expectIndexMatchesBackend(fixture: SecretsFixture, environmentId: string): Promise<void>;
```

Design fixed here (P-62, P-66 … P-72; Doc 06 §5, §6.1–§6.3, §7.2):

- **`AppDeps`** gains `bao?: RuntimeBao`, `lockPool?: pg.Pool`, `bootId: string` (a UUID per process start) and `test.faults`. `startServer` creates `lockPool` (8) and the main pool with 12, and `runtimeBaoFromDirectory` when `MYKEY_BAO_URL` is set. A secret route on a process without `bao`, or whose `clientFor` answers null, is `503 dependency_unavailable`.
- **`withEnvironmentLock`**: connect from `lockPool` within `LIMITS.deadlines.poolAcquireMs` (`Busy` otherwise); `SET lock_timeout` to `LIMITS.deadlines.advisoryLockMs`; `SELECT pg_advisory_lock($1)` (`Busy` on SQLSTATE `55P03`); attach an `error` listener that latches `lost`; run `fn`; in `finally`: `pg_advisory_unlock`, `RESET lock_timeout`, release — with `release(true)` when `lost()` or when the unlock failed.
- **`runSecretAction`**, in order:
  1. `clientFor`, `secretPath`; `withEnvironmentLock`.
  2. **Pre-read** `kvMetadata(path)`: `ok`, or `not_found` (no history). `sealed` → refused `backend_sealed`; `denied` → `markEnvironmentReview`, audit `system.drift_detected` (`kv_data`), refused `backend_inconsistent`; anything else → refused `dependency_unavailable`.
  3. **Admission transaction** on `locked.client`: insert the operation as `accepted` with scope columns, `secret_name`, `expected`, `executor_boot_id` — `exists` → `replay` or refused `idempotency_conflict` (as `beginOperation`); `service_control.capture_mode` `FOR SHARE` must be `idle` (`busy`); `lockParents(…, null)` and `checkStates` again (the state code); `resolveAccess` + `decide` again (`not_found` when hidden, `action_denied` when denied); `slotOf` (refused `key_under_review` with the holder's `operationId`); `lockIndexRow`; the action's checks (below); capacity; step row with `before_state: { indexVersion, backendCurrentVersion, backendDeleted }`; `takeSlot`; audit `secret.<action>` with outcome `intent`. Any refusal rolls the transaction back: no operation remains.
  4. **Dispatch transaction:** `claimDispatch`; a fresh `dispatch_attempt_id` on the step; `capture_mode` still `idle` and `gateOpen()` — if not, roll back and finish `rejected` with `busy` or `quarantined` in a new transaction that releases the slot. From the commit of this transaction on, every failure is `unknown`.
  5. **One change** with `Correlation { operationId, dispatchId }`.
  6. **Read-back.** A write: `kvRead(path, version)` and `envelope.operation_id === operationId`. A delete or undelete (Run 4.4): `kvMetadata` shows the target version current and in the target state.
  7. **Finalize transaction:** `finishOperation` (null → `unknown`, change nothing else); on success `writeIndexRow` with a fresh tag, `applyCounters`, `recordVersionEvent`, audit outcome `success`, `releaseSlot`; result `{ name, version, stateTag, state, generation }` (`generation` as a decimal string). A definite refusal: `finishOperation` rejected, review as P-68, audit `failure`, `releaseSlot`. Unknown: `finishOperation` uncertain, `markKeyReview`, audit `unknown`, slot kept.
  8. A throw or `locked.lost()` anywhere in steps 4–7 → `{ kind: "unknown", operationId }`. The handler maps it to `503 outcome_unknown` with `operationId`.
- **Checks by action** (admission, comparing the request, the index row and the pre-read):
  - `create`: an index row in any state → `already_exists`; no row but backend metadata → `markKeyReview` (committed outside the rolled-back transaction, on the main pool) and `backend_inconsistent`; names ≥ `LIMITS.environment.maxNames` → `capacity_exceeded` `{ limit: "names" }`; bytes → `{ limit: "bytes" }`. Sends `cas: 0`.
  - `update`: no row → `not_found`; row `needs_review` → `key_under_review`; row `deleted` → `state_conflict`; version or tag differs → `version_conflict` with the row's `{ currentVersion, currentStateTag, state }`; the pre-read's current version differs from the row's, or is deleted → `markKeyReview`, `backend_inconsistent`; bytes after the change above the limit → `capacity_exceeded`. Sends `cas: expected.version`.
- **Handlers** (`routes/secrets.ts`): `secretsCreateHandler`, `secretsUpdateHandler` build the `SecretRequest` from `ctx` (name from the body for create, from `:name` for the others — a `:name` that fails `checkSecretName` is `404 not_found`) and map the outcome: `succeeded` → 201 or 200 with `operationResponse`; `replay` → `replayAnswer`; `refused` and `unknown` → `ApiError`.
- **Migration `0012`:** `app.mark_environment_review` (P-72), `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO api_runtime`. Privilege tests: `api_runtime` can call it; it cannot clear a review or write `review_reason` directly; `provisioner_runtime` cannot call it.
- **`createSecretsFixture`:** `createProvisioningFixture({ shared: true })` unless `private`; starts the provisioner until the tenants' environments are `active`, then stops it; writes the runtime credential into the API's secrets directory (`startTestApi({ runtime: true })` creates the directory and wires `runtimeBaoFromDirectory` and a `lockPool`); with `processes: 2` a second API process (`startApiProcess` gains `openBao`, `secretsDirectory`, `faults: { point, action: "crash" | "hang" | "throw" | "terminate_lock" }`). Helpers: `put(env, name, value)` and friends that call the API as `ownerA` and return the envelope; `backend(env, name)` (operator token: metadata and per-version operation ids, never values); `auditedChanges(operationId)` (requests of the audit device carrying the operation id).

### Task A — the runtime identity

- [ ] **Step 1 — Failing tests** (`inline.test.ts`, `createOrgFixture`):
  - `an inline client writes, reads, lists and soft-deletes` — the same calls as `client.test.ts` "runtime writes and reads an envelope".
  - `five inline calls add no accessor to the namespace` (the PO-3 check of `authority.test.ts`, now through the product client).
  - `a wrong secret id is denied, 403`; `an inline client cannot lookup-self` (403; D-17).
  - `kvMetadata gives createdAt per version and oldestVersion`; `after 21 writes oldestVersion is 2, twenty versions remain, and kvRead of version 1 is not_found`.
  - `cas equal to a soft-deleted current version succeeds; cas 0 on a path whose only version is deleted is a cas_mismatch` (source reading 1).
  - `runtimeBaoFromDirectory answers null while a file is missing and a client once all three exist; an organization other than the one in the directory is null`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS, and `tests/integration/openbao` whole. **Commit** `feat(openbao): inline AppRole authentication for the runtime; version times in metadata`. Write D-34.

### Task B — the protocol, with create

- [ ] **Step 1 — Audit actions** (P-71) with their unit tests in `events.test.ts`: `details.name` accepts a 128-character name and refuses lower case, a 129th character and any other string key over 63 characters; outcomes `intent` and `unknown` are accepted.
- [ ] **Step 2 — Failing tests** (`create.test.ts`, `protocol.test.ts`; `createSecretsFixture()`):
  - `create: 201, operation succeeded, result { name, version: 1, stateTag (22 characters), state: "live", generation }`; the backend's version 1 carries this operation id; one index row; one version event with the owner as actor; audit rows `intent` then `success`, both with `details.name`; no slot; no advisory lock.
  - Names: `A` and a 128-character name are created; 129 characters, `a`, `1A`, `A-B`, `SECRETS_X`, empty → `422 validation_failed`; for each refusal no operation row and no audited change.
  - Values: empty; 65,536 bytes made of 3-byte characters with a remainder; multiline with CR, LF and tabs; four-byte characters — each read back through the operator client with an equal digest. 65,537 bytes, a NUL, a lone surrogate → 422, nothing sent.
  - `a refused value is not echoed`: a 65,537-byte and a NUL-carrying value built around a run-time canary; the canary is in no response body, no log entry of the API and no `audit.event` row (Review focus 3).
  - `create over a live name → 409 already_exists`; `create over a name whose only version is deleted → 409 already_exists and no second version` (state set up through the backend and the index by the fixture); `no index row but backend history → 503 backend_inconsistent, the name appears in the index as needs_review, nothing written`.
  - `the same key and body again replays the 201 with the same version; the backend still has one version; one audited change`; `two identical requests at once, one key, two processes: one version, both answers name one operationId`.
  - `a reader gets 403, an ungranted member and ownerB 404` — each with the control (`editorA` creates in the same environment), and nothing written.
  - States: environment `pending` with `kv_ready` false → `409 state_conflict`; `archived` → 409; `needs_review` → 503 — control: `active` creates.
  - `protocol.test.ts`:
    - `the lock is busy: 503 busy after about two seconds, no operation` (another connection holds the advisory lock).
    - `an occupied slot: 409 key_under_review with the holder's operationId` (slot inserted for a synthetic uncertain operation; control after its removal).
    - `capture mode draining: 503 busy`.
    - `audit cannot be written: 503 audit_unavailable, no operation, nothing sent` (`INSERT` on `audit.event` revoked for the test).
    - `the backend refuses the connection: 503 dependency_unavailable, no operation` (the API's OpenBao URL points at a closed port).
    - `a throw at each fault point after the marker answers 503 outcome_unknown with operationId` — `after_dispatch_marker`, `after_send`, `after_read_back`, `before_finalize_commit`: the operation is `executing` or `uncertain`, never `rejected` or `succeeded` by mistake; the slot is held; `after_finalize`: the operation is `succeeded`, the answer is still 503, and a replay with the same key answers 201 (Review focus 1).
    - `the lock session is terminated after the send: 503 outcome_unknown; the connection is not reused` (`pg_terminate_backend` from the `after_send` hook; afterwards the pool's connections hold no advisory lock) (Review focus 2).
    - `a delayed answer: 503 outcome_unknown, operation uncertain, key needs_review, slot held, one audited change, and the version is in the backend` (TLS relay, answer held 8 s, deadline 5 s — AC-1.16's first half; Run 4.5 settles it).
    - `the gate closes between admission and dispatch: operation rejected with quarantined, slot released, nothing sent` (`beforeHandler` cannot reach this point: use the fault hook `after_admission`).
    - `after every test no advisory lock is held by an idle connection` (`afterEach`: `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE l.locktype = 'advisory' AND a.state = 'idle'` is 0).
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Migration `0012`, repositories, lock, protocol, `create`, handler, fixture.** **Step 5 — Run:** PASS. **Commit** `feat(secrets): the mutation protocol and secret create`.

### Task C — update, races, capacity

- [ ] **Step 1 — Failing tests** (`update.test.ts`, `capacity.test.ts`):
  - `update with the current version and tag: 200, version 2, a new tag, the old tag no longer accepted`.
  - `a stale version → 409 version_conflict with details { currentVersion, currentStateTag, state }`; `the right version with a stale tag → 409`; `no expectedVersion or no expectedStateTag → 422`; `an unknown body key (force: true) → 422`; `an absent name → 404`; `a deleted current version → 409 state_conflict` (state set by the fixture).
  - `two updates with the same version and tag at once: exactly one 200 and one 409 version_conflict; one new version; one audited change` — two API processes, 20 rounds (AC-1.14).
  - `twenty updates of twenty different keys of one environment at once all succeed or answer busy; none is lost` (those answered `busy` are retried with the same key and then succeed).
  - `the backend moved underneath: 503 backend_inconsistent and the key is needs_review` (a version written with the operator client between two API updates).
  - `the admission recheck: the environment archived after the pipeline → 409 state_conflict, no operation; the editor's grant removed after the pipeline → 404` (`beforeHandler`).
  - Capacity: 1,000 index rows (999 inserted by the fixture with their counters, one created) → the 1,001st create is `507 capacity_exceeded` `{ limit: "names" }`; live bytes at 8 MiB − 10: an update that adds 10 bytes passes and one that adds 11 is `507` `{ limit: "bytes" }`; `nothing is sent on a 507`; `a deleted name still counts as a name`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; the whole integration suite. **Commit** `feat(secrets): update with expected version and state tag; capacity`. Write D-36.

### Task D — staging

- [ ] **Step 1 — Deploy** the branch (API and provisioner images, `push`, `db-init`, `up`, `gate open`); `host.ts staging status` shows gate open, `runtimeLogin: ok`, `reviewOpen: 0`. Note the alert window in the run note.
- [ ] **Step 2 — `secrets.staging.test.ts`** (target assertion first; the owner's session from `stagingOwnerSession`; a new project `s4-<8 hex>` with its `development` environment, waited until `active`): `create and update through the public name`; `a stale tag is 409`; `the secrets directory's credential works from the API's address` (the create itself proves inline authentication under the bound CIDR). Then `fifty sequential updates`: record the median and the slowest time per request in the run note (the measurement of P-62; no assertion yet).
- [ ] **Step 3 — Run:** PASS. **Commit** `test(staging): first secret writes`.

**Registry:** `FR-1.20`, `FR-1.24`, `FR-1.25`, `AC-1.14` → `SPIKE_PASS` (staging for create and update; the races on the local stack). `AC-1.12` waits for Run 4.3 (search, history). **Covers:** FR-1.20, FR-1.24, FR-1.25; AC-1.12 (values), AC-1.14. **Done when:** two updates with the same version and tag yield exactly one success; oversize, NUL and reserved names are refused before any effect.

---

## Run 4.3 — Listing, history and reveal (D08-S19)

**Files:** `packages/contracts/src/routes.ts` (+ `openapi.json`, pending snapshot), `packages/db/src/repos/secrets.ts`, `packages/operations/src/secrets/{reveal,history,protocol}.ts`, `apps/api/src/routes/secrets.ts`, `apps/api/src/app.ts`, `tests/integration/secrets/{list,history,reveal}.test.ts`, `docs/decisions/D-37-value-reads.md`.

**Consumes:** Run 4.2 (`withEnvironmentLock`, `Locked`, `RuntimeBao`, `slotOf`, `lockIndexRow`, `markKeyReview`, `markEnvironmentReview`, `createSecretsFixture`, `expectIndexMatchesBackend`); `signCursor`/`readCursor`; `kvRead`, `kvMetadata`.

**Produces:**

```ts
// @mykey/db — repos/secrets.ts
export function listIndex(db: Queryable, scope: EnvironmentScope, page: { prefix: string | null; after: string | null; limit: number }): Promise<{ rows: IndexRow[]; generation: bigint }>;   // one statement: rows and generation from the same snapshot
export interface VersionEvent { version: number; action: string; actorKind: "user" | "operator" | "system" | "unknown"; actorId: string | null; operationId: OperationId | null; occurredAt: Date }
export function versionEvents(db: Queryable, scope: EnvironmentScope, name: string): Promise<VersionEvent[]>;
// @mykey/operations — secrets/protocol.ts
export function backendRefusal(db: Queryable, scope: EnvironmentScope, result: BaoFailure, requestId: string): Promise<ErrorCode>;   // the mapping of runSecretAction step 2, with its review and audit side effects
export function recheckAccess(tx: pg.PoolClient, scope: EnvironmentScope, userId: UserId, routeId: string): Promise<ErrorCode | null>;  // parent states, then resolveAccess + decide — the admission recheck, shared by reads
// @mykey/operations — secrets/reveal.ts, secrets/history.ts
export const READ_FAULT_POINTS = ["after_backend_read", "before_audit_commit"] as const;
export interface ReadDeps { pool: pg.Pool; lockPool: pg.Pool; bao: RuntimeBao; faults?: (point: (typeof READ_FAULT_POINTS)[number]) => void | Promise<void> }
export type Refused = { kind: "refused"; code: ErrorCode; operationId?: OperationId; details?: Record<string, unknown> };
export function revealSecret(deps: ReadDeps, request: { scope: EnvironmentScope; userId: UserId; name: string; version?: number; requestId: string }):
  Promise<{ kind: "ok"; value: string; version: number; stateTag: string } | Refused>;
export function readHistory(deps: ReadDeps, scope: EnvironmentScope, name: string): Promise<{ kind: "ok"; history: SecretHistory } | Refused>;
```

Design fixed here (P-73; Doc 06 §7.2, §8, §9; Doc 04 §1.2, FR-1.21, FR-1.26):

- **Contract commit** `contract: secret list, history, reveal`.
  - `secrets.list` → `200 { secrets: [{ name, version: int | null, stateTag, state: "live" | "deleted" | "needs_review", changedAt }], nextCursor: string | null }`. `prefix` in `secretsListQuery` becomes `z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional()`.
  - `secrets.history` → `200 { name, currentVersion: int | null, state, stateTag, versions: [{ version, createdAt, deleted, destroyed, current, written: { action: "create" | "update" | "restore" | null, actor: { kind, id: string | null }, operationId: string | null }, lastChange: { action: "delete" | "undelete", actor, occurredAt, operationId } | null }] }`, newest version first, at most twenty.
  - `secrets.reveal` → `200 { name, version, value, stateTag }`; add `state_conflict` to its error list if absent.
- **List** never calls OpenBao and takes no lock. The cursor's `generation` field holds `metadata_generation` of the first page; `listIndex` returns the generation it saw, and a difference is `409 listing_changed`.
- **History** takes no lock, reads `kvMetadata` once and `versionEvents` once, and joins them. `written` is the version's event with a write action; when there is none, `{ action: null, actor: { kind: "unknown", id: null }, operationId: null }`. `lastChange` is the newest delete or undelete event of that version. A key in review answers 200 with its state (Doc 04 §1.2: metadata stays visible); `key_under_review` in the route's error list stays unused and the run note says so. No index row → `404`. A backend failure goes through `backendRefusal`. History judges no drift: a difference between index and backend is the lock holders' business.
- **Reveal**, under `withEnvironmentLock`:
  1. Transaction on the lock connection: `recheckAccess`; `slotOf` — refused `key_under_review` with the holder's `operationId` only when `slot.secretName` is this name or null; `lockIndexRow`: none → `not_found`; `needs_review` → `key_under_review`; no `version` and state `deleted` → `state_conflict`; `version` above the current one or below 1 → `not_found`.
  2. `kvRead(path, version ?? current)`. `not_found` for a requested version → `state_conflict` (it existed and is deleted, destroyed or trimmed). For the current version the backend's reported version must equal the index's and the envelope must be format 1 — otherwise `markKeyReview` and `backend_inconsistent`. Other failures → `backendRefusal`.
  3. On the lock connection: the index row's tag is unchanged; `appendAudit` `secret.reveal`, outcome `success`, `details { name, version }`; commit. A failed commit → `audit_unavailable`; `locked.lost()` → `dependency_unavailable`. In both the value is dropped.
  4. Only then return the value. The handler answers with `cache-control: no-store`.

### Task A — list and history

- [ ] **Step 1 — Contract commit.**
- [ ] **Step 2 — Failing tests** (`list.test.ts`, `history.test.ts`; `createSecretsFixture()`; the fixture gains `seedIndex(env, names)` — index rows and counters only, through the superuser — for cases that never touch the backend):
  - List: `an empty environment → { secrets: [], nextCursor: null }`; `120 names page 50/50/20, disjoint and complete`; `order is bytewise: A1, AB, A_B`; `prefix DB_ returns DB_HOST and not DBX; prefix DB returns both; an underscore is literal (A_ does not match AB)`; `prefix db, D%, an empty prefix → 422`; `deleted and needs_review names are listed with their state`; `an item's keys are exactly name, version, stateTag, state, changedAt`; `a write between two pages → 409 listing_changed; the first page again works`; `a cursor of another prefix, another environment or another route → 400 malformed_request`; `the list answers while OpenBao is unreachable` (the API's OpenBao URL points at a closed port); roles per `decide` with one control each; environment in review → 503.
  - History: `create, update, update, delete, undelete, restore: four versions newest first, each with written.action and the acting user; the deleted-then-undeleted version carries lastChange undelete`; `no key of the body is called value and the body does not contain the run-time canary the values were built around`; `a version written past the product (operator client) has actor unknown and action null`; `?limit=5, ?cursor=x, ?version=1 → 400 unsupported_history_parameter`; `after 21 writes there are 20 versions and version 1 is gone`; `a key in review: 200, state needs_review`; `an absent name → 404`; `OpenBao unreachable → 503 dependency_unavailable`; roles per `decide`.
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Implement.** **Step 5 — Run:** PASS; `pnpm run contracts:openapi`. **Commit** `feat(secrets): list from the index and version history`.

### Task B — reveal

- [ ] **Step 1 — Failing tests** (`reveal.test.ts`):
  - `the current value: 200, digest equal, cache-control no-store, and the audit row secret.reveal (name, version) is committed when the answer arrives`.
  - `version: 1 after an update returns version 1`; `a version above the current → 404`; `a deleted older version → 409 state_conflict`; `version: 0, "1", 1.5 → 422`.
  - `a deleted current version without version → 409 state_conflict`; `a key in review → 409 key_under_review`.
  - `a slot held for this key → 409 key_under_review with operationId; a slot held for another key → 200` (P-67).
  - `audit cannot be written → 503 audit_unavailable and the body does not contain the canary`.
  - `the lock session is terminated after the backend read → 503 dependency_unavailable, no value, no secret.reveal row` (`after_backend_read`; Review focus 2).
  - `the lock is held elsewhere → 503 busy`.
  - `the backend holds a newer version than the index → 503 backend_inconsistent, the key is needs_review, no value`.
  - `a denied caller leaves access.denied and no secret.reveal`; roles per `decide` with controls.
  - `after ten reveals no log entry of the API contains the canary`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(secrets): reveal under the environment lock, audited before release`. Write D-37 (sections "list", "history", "reveal"; Runs 4.8 and 4.9 add theirs).

**Registry:** `FR-1.21`, `FR-1.26`, `AC-1.12` → `SPIKE_PASS`. `FR-1.22` stays `OPEN` (its browser half is Run 7.x); the run note records the server half. **Covers:** FR-1.21, FR-1.26, FR-1.22 (server). **Done when:** search and history never return a value, and every reveal has a committed audit row before the value leaves.

---

## Run 4.4 — Delete, undelete and restore (D08-S20)

**Files:** `packages/operations/src/secrets/{actions,protocol}.ts`, `apps/api/src/routes/secrets.ts`, `apps/api/src/app.ts`, `tests/integration/openbao/client.test.ts`, `tests/integration/secrets/{delete,undelete,restore,lifecycle}.test.ts`.

**Consumes:** Run 4.2 (`runSecretAction`, its admission, `IndexRow`, `applyCounters`), Run 4.3 (`backendRefusal`); `kvSoftDelete`, `kvUndelete`, `kvRead`.

**Produces:** the actions `delete`, `undelete`, `restore` of `runSecretAction`; handlers `secretsDeleteHandler`, `secretsUndeleteHandler`, `secretsRestoreHandler`. No new exported names.

Design fixed here (P-70, P-74; Doc 06 §7.2; FR-1.27–1.29):

| | delete | undelete | restore |
| --- | --- | --- | --- |
| Index row must be | `live` | `deleted` | `live` or `deleted` |
| Otherwise | `deleted` → `state_conflict` | `live` → `state_conflict` | — |
| Both | none → `not_found`; `needs_review` → `key_under_review`; version or tag differs → `version_conflict` with details | | |
| Pre-read must show | current = index version, not deleted | current = index version, deleted, not destroyed | current = index version |
| Otherwise | `markKeyReview`, `backend_inconsistent` | | |
| Extra pre-read | — | — | `kvRead(path, sourceVersion)`: unreadable → `state_conflict`; the value stays in memory |
| Capacity | — | live bytes + row bytes ≤ 8 MiB | live bytes − (row live ? row bytes : 0) + source length ≤ 8 MiB |
| Effect | `kvSoftDelete(path, [version])` | `kvUndelete(path, [version])` | `kvWrite(path, envelope, cas: version)` |
| Read-back | metadata: current = version, deleted | `kvRead(path, version)` succeeds | `kvRead(path, version + 1)` carries the operation id |
| Finalize | state `deleted`, counters − row bytes | state `live`, row bytes = length read back, counters + that | version + 1, state `live`, row bytes = source length, counters by the difference |
| Version event | `delete`, same version | `undelete`, same version | `restore`, new version |

- `sourceVersion >= expectedVersion` is `422 validation_failed` in the handler, before the lock.
- Delete and undelete carry no marker in the backend (D-20). Their `succeeded` rests on three things together: the pre-read showed the opposite state under the lock, the slot was held throughout, and the read-back shows the target state. D-36 gains a paragraph that says so; Run 4.5 gives the rule for the uncertain case.
- Audit details: `{ name, version }`; restore adds `sourceVersion`.

- [ ] **Step 1 — Failing tests.**
  - `client.test.ts`: `a soft delete of an already deleted version and an undelete of a live one answer ok` (source reading 4).
  - `delete.test.ts`: `delete: 200, state deleted, a new tag, the backend's version is deleted, live bytes reduced`; `after it: reveal → 409 state_conflict, update → 409 state_conflict, create of the same name → 409 already_exists, the list shows it deleted`; `a stale tag → 409 version_conflict`; `confirmed missing or false → 422`; `a replay answers the same result with one audited change`; `two deletes with the same tag at once: one 200 and one 409`; `a delayed answer → 503 outcome_unknown, key needs_review, slot held` (relay); roles with controls.
  - `undelete.test.ts`: `undelete: 200, live, the same version number, a new tag, digest equal, live bytes restored`; `undelete of a live key → 409 state_conflict`; `undelete that would pass 8 MiB → 507 and nothing sent`; `a delayed answer → 503 outcome_unknown`.
  - `restore.test.ts`: `versions 1, 2, 3: restore of 1 gives version 4 with the digest of version 1, and history says restore`; `sourceVersion equal to or above expectedVersion → 422`; `a deleted older version as source → 409 state_conflict` (delete version 2, restore 1 → version 3, then source 2); `a trimmed source (after 21 writes, source 1) → 409 state_conflict`; `restore over a deleted current version: version 4, live` (source reading 1; AC-1.15); `a stale tag → 409 version_conflict, nothing written`; `the restored value is in no row of app.operation, app.operation_step or audit.event` (run-time canary); `a replay does not write a second version`.
  - `lifecycle.test.ts` (Review focus 4): create (100 bytes) → update (250) → delete → undelete → restore of version 1 → delete; after each step `environment.live_value_bytes` is 100, 250, 0, 250, 100, 0, the name count is 1, the generation rose by one, and `expectIndexMatchesBackend` holds.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; `tests/integration/secrets` whole. **Commit** `feat(secrets): delete, undelete and restore`.

**Registry:** `FR-1.27`, `FR-1.28`, `FR-1.29`, `FR-1.32`, `AC-1.15`, `PO-7` → `SPIKE_PASS` (staging proof follows with Run 4.5's deploy). **Covers:** FR-1.27–1.29, FR-1.32; AC-1.15; PO-7. **Done when:** undelete restores the same version; restore creates a new version; a stale tag changes nothing.

---

## Run 4.5 — Uncertainty and reconciliation (D08-S21)

**Files:** `packages/db/src/repos/operations.ts`, `packages/operations/src/secrets/{sweep,protocol}.ts`, `packages/operations/src/reconcile/{operation,environment,rebuild}.ts`, `packages/operations/src/operator.ts`, `packages/operations/src/provisioning/environment.ts`, `packages/audit/src/events.ts`, `apps/api/src/{operation-sweep,server}.ts`, `apps/ops/src/commands/{operations,reconcile-operation,reconcile-environment}.ts`, `apps/ops/src/cli.ts`, `scripts/host.ts`, `infra/hosts/checks/status.sh`, `workers/probe/src/evaluate.ts` (and its test), `tests/integration/reconcile/{sweep,operation,environment,ops}.test.ts`, `tests/integration/provisioning/{environment,drift}.test.ts`, `tests/staging/{secrets,reconcile}.staging.test.ts`, `docs/runbooks/{reconciliation,provisioning,probe}.md`, `docs/decisions/D-38-uncertainty-and-reconciliation.md`.

**Consumes:** Runs 4.1–4.4; D-20; `OpsCommand`, `EXIT`, `OpsEnv`; `OpenBaoClient` with the operator's token; the TLS relay; `appendAudit`.

**Produces:**

```ts
// @mykey/db — repos/operations.ts
export interface Unresolved { id: OperationId; action: string; environmentId: EnvironmentId | null; secretName: string | null; state: string; heartbeatAt: Date | null; stale: boolean; holdsSlot: boolean }
export function listUnresolved(db: Queryable, organizationId: OrganizationId): Promise<Unresolved[]>;      // uncertain with completed_at NULL, or accepted/executing with a heartbeat older than 120 s
export function settleOperation(tx: pg.PoolClient, id: OperationId,
  verdict: { state: "succeeded"; result: Record<string, unknown> } | { state: "rejected"; errorCode: ErrorCode } | { state: "uncertain" /* closed as unknown */ }): Promise<boolean>;   // only from uncertain with completed_at NULL; sets completed_at and the replay expiry
// @mykey/operations — secrets/sweep.ts (root entry point)
export function sweepStaleOperations(pool: pg.Pool, opts?: { staleSeconds?: number }): Promise<{ uncertain: OperationId[]; rejected: OperationId[]; awaitingInput: OperationId[] }>;
// @mykey/operations/operator
export interface ReconcileDeps { database: pg.Pool /* maintenance */; bao: OpenBaoClient /* operator token, the organization's namespace */; operatorId: string; requestId: string }
export type OperationVerdict =
  | { kind: "succeeded"; version: number } | { kind: "rejected" } | { kind: "closed_unknown" }
  | { kind: "undetermined"; reason: "executors_not_excluded" | "backend_unreadable" | "evidence_conflict" | "not_unresolved" };
export function reconcileOperation(deps: ReconcileDeps, operationId: OperationId, opts: { executorsExcluded: boolean; closeUnknown?: boolean }): Promise<OperationVerdict>;
export function reconcileEnvironment(deps: ReconcileDeps, scope: EnvironmentScope):
  Promise<{ kind: "rebuilt"; names: number; changed: number } | { kind: "refused"; reason: "unresolved_operations" | "backend_unreadable" | "busy" }>;
export function rebuildKey(tx: pg.PoolClient, bao: OpenBaoClient, scope: EnvironmentScope, name: string, cause: OperationId | null): Promise<"written" | "removed" | "unchanged">;
```

Design fixed here (P-69, P-75; Doc 06 §6.2 step 6, §6.4; D-20; FR-1.30, 1.31, 1.88):

- **The sweep** (`operation-sweep.ts`: a timer every 30 s with up to 5 s of jitter, started by `startServer`, stopped on shutdown; one statement per rule, each a conditional update that also clears `executor_boot_id`):
  - action in `secrets.create|update|delete|undelete|restore`, state `executing`, heartbeat older than 120 s → `uncertain`; `markKeyReview`; audit `system.operation_stuck` `{ action, name }`, outcome `unknown`. The slot stays.
  - the same actions, state `accepted`, heartbeat older than 120 s → `rejected` with `dependency_unavailable`; the slot is released; audit `secret.<action>` outcome `failure`. No dispatch marker was written, so nothing was sent (D-20).
  - Run 4.7 adds the rule for import parents.
  - **Amendment to `runSecretAction` step 4:** when `claimDispatch` answers false, the action reads the row and answers through `replayAnswer` — the sweep got there first.
- **Verdicts of `reconcileOperation`.** The operation must be unresolved (`listUnresolved`) and one of the five secret actions; otherwise `not_unresolved`. A stale `executing` row is first moved to `uncertain` by the sweep's rule. Evidence: the step's `before_state`, the operation's `expected`, `kvMetadata` now, and for writes the envelope of every version above `before_state.backendCurrentVersion`.
  - **A write** (`create`, `update`, `restore`): a version whose envelope carries the operation id → `succeeded` with that version, **with or without exclusion** (a write cannot land twice). No such version: without exclusion → `undetermined: executors_not_excluded`; with exclusion and the current version still `before_state.backendCurrentVersion` → `rejected`; with exclusion and a version above it that cannot be read → `undetermined: evidence_conflict`.
  - **A delete or undelete:** always needs exclusion (a delete seen as done could still be followed by its late twin after an undelete). With exclusion: the current version is the expected one and is in the target state → `succeeded`; in the state before → `rejected`; anything else → `evidence_conflict`.
  - `closeUnknown` (only with `executorsExcluded`, only for `evidence_conflict`): the operation stays `uncertain` for ever, gets `completed_at`, and no longer counts as unresolved. Its replay keeps answering `503 outcome_unknown`. That is the truth (rule 11) and it frees the environment.
  - `rejected` stores the error code `dependency_unavailable`.
- **Every settlement** is one transaction as `maintenance`, holding the environment's advisory lock on its connection: `settleOperation`; `rebuildKey`; counters recomputed as the sum of live rows; generation + 1; `recordVersionEvent` for a write found (`actor` = the operation's principal, the operation's action); slot released; audit `operator.reconcile_operation` `{ name, verdict, executorsExcluded }` with the operator as actor and the operation id. When the operation has a `parent_operation_id` (Run 4.7), the parent is closed in the same transaction.
- **`rebuildKey`:** from `kvMetadata` — no metadata → the index row is removed; otherwise current version, state from the deleted flag, a fresh tag. Byte length: a live current version is read once for its length (the value is dropped; nothing else of it is kept); a deleted one keeps the row's length when the version is unchanged and takes `LIMITS.secret.valueMaxBytes` otherwise (the next undelete writes the true length).
- **`reconcileEnvironment`:** takes the environment lock (2 s, else `busy`); refuses while `listUnresolved` names the environment; then for the union of `kvList` names and index names runs `rebuildKey`; recomputes the counters; generation + 1; moves the environment from `needs_review` to `active` when `kv_ready` holds; audit `operator.reconcile_environment` `{ names, changed }`. It does not need exclusion: the lock and the empty slot are the proof that no write is in flight.
- **Commands.** `ops operations --organization <id>` prints one line per unresolved operation (id, action, environment, name, state, age). `ops reconcile-operation --operation <id> [--executors-excluded yes] [--close-unknown yes]`: exit 0 for a verdict that settles, 3 (`review`) for `undetermined`, with the reason and the next step of the runbook. `ops reconcile-environment --environment <id>`: exit 0 or 3. None prints a value.
- **`host.ts <host> quiesce`:** `gate close` → stop `api` and `provisioner` → restart `openbao` → wait until it is unsealed → print `executors: stopped`. **`resume`:** start both; the gate stays closed until `gate open`. Both are plain container commands through the existing remote path; no firewall change, no revert timer.
- **Alert.** `status.sh` adds `operationsUnresolved` (the count of `listUnresolved` over all organizations, read the way `reviewOpen` is read). The probe gains `operations_unresolved` (value above 0), with the same delivery and clearing rules as `review_open`. Deploy the probe with `node scripts/probe.ts deploy`.
- **Runbook `reconciliation.md`:** the alert → `ops operations` → the decision tree above → for a not-landed write or any delete/undelete: `quiesce`, `reconcile-operation --executors-excluded yes`, `resume`, `gate open` → an environment in review: fix the cause (`verify-organization`), then `reconcile-environment`. What is never done: editing rows by hand, sending the change again under a new key while the slot is held, clearing a review through the superuser. `provisioning.md` loses the superuser instruction.

### Task A — the sweep and the alert

- [ ] **Step 1 — Failing tests** (`sweep.test.ts`; rows aged through the superuser):
  - `executing with a heartbeat 121 s old → uncertain, key needs_review, slot kept, one system.operation_stuck`; `119 s old: untouched`.
  - `accepted and stale → rejected dependency_unavailable, slot released, key state unchanged, no audited change`.
  - `a swept executor cannot finalize`: the action hangs at `after_send` while the test calls `sweepStaleOperations(pool, { staleSeconds: 0 })`; the request answers `503 outcome_unknown`, the row stays `uncertain`, the index row is `needs_review`, not `live`.
  - `a swept accepted operation is not dispatched`: hang at `after_admission`, sweep, release → the request answers `503 dependency_unavailable` with `operationId`, nothing was sent.
  - `two processes sweep at once: one audit row per operation`.
  - `the sweep works while OpenBao is unreachable`.
  - The probe's unit test: `operationsUnresolved: 1` raises `operations_unresolved`; 0 clears it; a heartbeat without the field raises nothing.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** (sweep, timer, `status.sh`, probe). **Step 4 — Run:** PASS. **Commit** `feat(operations): stale operations become uncertain; alert on unresolved operations`.

### Task B — reconciliation

- [ ] **Step 1 — Failing tests** (`operation.test.ts`, `environment.test.ts`, `ops.test.ts`; `createSecretsFixture()` with the TLS relay between API and OpenBao: `landed(action)` holds the answer past the deadline, `notLanded(action)` holds the request and then drops it; both return the uncertain operation's id):
  - `a landed update, no exclusion → succeeded: index live at the new version, a new tag, counters right, slot free, the version event names the original user, the original key replays 200 with the result, one operator.reconcile_operation`.
  - `a not-landed update, no exclusion → undetermined executors_not_excluded; nothing changed, slot held`.
  - `a not-landed update, exclusion → rejected: the key is live at its old version with a new tag; the original key answers 503 dependency_unavailable with operationId; an update with the new tag succeeds`.
  - `a landed create → row live at version 1`; `a not-landed create, exclusion → the index row is gone and the name can be created`.
  - `a landed restore → succeeded`.
  - `a landed delete, no exclusion → undetermined; with exclusion → succeeded, state deleted, live bytes reduced`; `a not-landed delete, exclusion → rejected, live`; the same pair for undelete.
  - `evidence conflict`: after a not-landed update the operator client writes a version and destroys it → `undetermined evidence_conflict`; with `closeUnknown` → `closed_unknown`: the row is still `uncertain` with `completed_at`, the slot is free, the key is rebuilt from the backend, the original key still answers `503 outcome_unknown`, `listUnresolved` no longer names it.
  - `a succeeded operation → not_unresolved, nothing changes`; `the command twice: the second is not_unresolved`.
  - Environment: `drift on a request`: the runtime policy is replaced by an empty one (operator client) → the next create answers `503 backend_inconsistent`, the environment is `needs_review`, one `system.drift_detected` with object `kv_data`; after the provisioner's sweep restored the policy, `reconcileEnvironment` → `rebuilt`, the environment is `active`, a create succeeds.
  - `an index damaged on purpose` (a version lowered, a byte count changed, a row deleted, a ghost row added, through the superuser) `is rebuilt to equal the backend`; tags are new; the generation rose by one.
  - `it refuses while an operation is unresolved`; `it answers busy while the lock is held`.
  - `300 names are rebuilt within 60 s`.
  - `ops.test.ts`: exit codes 0, 3 and 64; the output of each command does not contain the canary; an unknown operation id exits 2.
  - The skeleton test: `apps/api` still imports only the root of `@mykey/operations`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** (repositories, reconcile, commands, `quiesce`/`resume`, runbooks). **Step 4 — Run:** PASS. **Commit** `feat(ops): reconciliation of operations and environments; quiesce and resume`. Write D-38.

### Task C — carried provisioning minors

- [ ] **Step 1 — Failing tests:** `drift.test.ts`: `a mount whose delete_version_after was changed is drift` (today only `cas_required` and `max_versions` are compared); `environment.test.ts`: `a step answered denied ends the job at once: one attempt, the environment in review, no retry` (the provisioner policy narrowed for one path; assert the job's retry count is 0).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Fix.** **Step 4 — Run:** PASS. **Commit** `fix(provisioner): kv-scope compares all three fields; denied ends the job`.

### Task D — staging

- [ ] **Step 1 — Deploy** the branch and the probe. Note the alert window.
- [ ] **Step 2 — `secrets.staging.test.ts`** gains: list with a prefix, history, reveal, delete, undelete, restore, the operation's status, one replay.
- [ ] **Step 3 — `reconcile.staging.test.ts`** (target assertion first; everything undone in `finally`: OpenBao unpaused, `resume`, `gate open`, the alert seen to clear). Host commands run as child processes of `scripts/host.ts`, with `MSYS_NO_PATHCONV=1`.
  1. Pause the OpenBao container (`sshExec`), send an update: `503 outcome_unknown` with `operationId`. Unpause.
  2. The key reads `409 key_under_review`; a create in the same environment is `409 key_under_review`; a reveal of another key is 200; the operation's status is `uncertain` after the next sweep or at once.
  3. Within five minutes the probe's state shows `operations_unresolved` (`node scripts/probe.ts state staging`); record the time of the Telegram message in the run note.
  4. `ops reconcile-operation --operation <id>` exits 3 (`executors_not_excluded`).
  5. `quiesce`; `ops reconcile-operation --operation <id> --executors-excluded yes` exits 0 with `rejected`; `resume`; `gate open`.
  6. An update with the new tag succeeds; the alert clears; `status` shows `operationsUnresolved: 0`, `reviewOpen: 0`.
- [ ] **Step 4 — Run:** PASS. **Commit** `test(staging): lifecycle and the uncertainty drill`.

**Registry:** `FR-1.30`, `FR-1.31`, `FR-1.88`, `AC-1.16` → `SPIKE_PASS`. **Covers:** FR-1.30, FR-1.31, FR-1.88; AC-1.16. **Done when:** a delayed write that landed is reconciled as success; an operation is called rejected only after executor exclusion and proof of no landing; no uncertain case stays without an alert.

---

## Run 4.6 — Fault suite (D08-S21)

**Files:** `tests/fault/secrets/fixture.ts`, `tests/fault/secrets/{boundaries,delays}.test.ts`, `tests/harness/{api-process,api-worker}.ts`, `docs/evidence/session-4/run-4.6.md`. Product code changes only to fix what the suite finds.

**Consumes:** everything of Runs 4.1–4.5; `startApiProcess` with `faults`; `startTlsRelay` (modes `pass`, `hold`, `drop`); `restartService`; `createSecretsFixture({ private: true })`.

**Produces:** `faultFixture()` in `tests/fault/secrets/fixture.ts`: a private stack, one child-process API behind which every OpenBao call passes the relay, a second child-process API for answers after a crash, and the helpers `settle(operationId, { excluded })` (the library call of Run 4.5 as `maintenance`), `excludeExecutors()` (kill the API process, `restartService("openbao")`, wait until unsealed), `changes(operationId)` (`auditedChanges`), `sweepNow()`.

Design fixed here (Doc 06 §6.2, D-20, AC-1.38):

- The suite runs **product code in a real process** that really dies. A fault `crash` is `process.kill(process.pid, "SIGKILL")` inside the fault hook.
- Each case asserts four things: the answers the client got and gets on replay at every stage are true; `changes(operationId).length <= 1`; after settlement `expectIndexMatchesBackend`; and no value in the output of the dead process.
- `boundaries.test.ts` is one table: five actions × six points (`FAULT_POINTS`). Expected course per point:

| Crash at | Row after the crash | After `sweepNow()` | Settlement | Backend changes |
| --- | --- | --- | --- | --- |
| `after_admission` | `accepted`, slot held | `rejected` (`dependency_unavailable`), slot free | none needed | 0 |
| `after_dispatch_marker` | `executing`, slot held | `uncertain` | write: `undetermined` without exclusion, `rejected` with it | 0 |
| `after_send`, `after_read_back`, `before_finalize_commit` | `executing`, slot held | `uncertain` | write: `succeeded` without exclusion; delete, undelete: `succeeded` with exclusion | 1 |
| `after_finalize` | `succeeded`, slot free | unchanged | none needed; the original key replays the result | 1 |

  While the slot is held, a new key for the same environment answers `409 key_under_review` naming the operation, and the original key answers 202 (`accepted`, `executing`) and then `503 outcome_unknown` (`uncertain`).

- [ ] **Step 1 — Failing tests.** `boundaries.test.ts` (thirty cases from the table) and `delays.test.ts`:
  - for each action: `the answer is held past the deadline → 503 outcome_unknown; settled as succeeded; one change`.
  - `the request is held, the executors are excluded, the relay lets go: nothing lands` — fifteen seconds later the backend's current version is the one before; settled `rejected` (D-20 on product code).
  - `the request is held, no exclusion: undetermined; the relay lets go and the write lands; settled as succeeded` — the reason the flag exists.
  - `the connection is cut after the request went out → outcome_unknown → succeeded`.
  - `the client repeats the original key eight times during all of it: 503 outcome_unknown each time, one change`.
  - `PostgreSQL restarts between the send and the finalizing transaction → 503 outcome_unknown; after the sweep and settlement the index equals the backend`.
  - `OpenBao sealed before dispatch → 503 backend_sealed, no operation`; `OpenBao stopped → 503 dependency_unavailable, no operation`.
  - `one API process dies in a write to environment X: the other still serves environment Y, and X answers key_under_review`.
  - `a provisioner job running at the same time is not disturbed and disturbs nothing` (one environment being provisioned while writes run in another).
- [ ] **Step 2 — Run:** FAIL where the product is wrong; a case that passes at once is checked by breaking the product on purpose once (remove the conditional in `finishOperation`, see `boundaries` fail, restore) and the run note says which case caught it.
- [ ] **Step 3 — Fix** what fails, each fix with its own commit `fix(secrets): …`.
- [ ] **Step 4 — Run** `pnpm exec vitest run --project integration tests/fault/secrets` three times in a row, then once inside `pnpm run test:integration`: all PASS. A case that fails only under the whole suite is a finding, not a retry.
- [ ] **Step 5 — Commit** `test(fault): the secret protocol under crashes and delays`. The run note carries the table with one line per case and the count of backend changes.

**Registry:** `AC-1.38`, `G-EFFECT` (KV actions; note "soft delete and undelete: no backend marker, settled under exclusion — D-38"), `FR-1.82`, `FR-1.83` → `SPIKE_PASS`. Effects of Sessions 5 (issuance, revocation, archive) stay owed. **Covers:** AC-1.38. **Done when:** every fault scenario ends in a truthful state with at most one audited backend change.

---

## Run 4.7 — Import (D08-S23)

**Files:** `packages/contracts/src/routes.ts` (+ `openapi.json`, pending snapshot), `packages/db/src/repos/{imports,operations}.ts`, `packages/operations/src/imports/{classify,preview,apply}.ts`, `packages/operations/src/secrets/sweep.ts`, `packages/operations/src/reconcile/operation.ts`, `packages/operations/src/index.ts`, `packages/audit/src/events.ts`, `apps/api/src/{large,operation-sweep}.ts`, `apps/api/src/routes/imports.ts`, `apps/api/src/app.ts`, `tests/unit/operations/classify.test.ts`, `tests/integration/imports/{preview,apply,resume}.test.ts`, `tests/fault/secrets/imports.test.ts`, `docs/decisions/D-39-import.md`.

**Consumes:** `parseDotenv`, `loaderWarnings`, `checkSecretName`, `checkSecretValue`; Run 4.2 (`runSecretAction` with `parent`, `withEnvironmentLock`), Run 4.3 (`ReadDeps`, `recheckAccess`, `backendRefusal`), Run 4.5 (sweep, `settleOperation`); the `replay-fingerprint` ring (`HmacRing`); `LIMITS.importPreview`, `LIMITS.concurrency.largePerProcess`, `LIMITS.deadlines.largeRequestMs`.

**Produces:**

```ts
// apps/api — large.ts
export function createLargeGate(max: number): { run<T>(fn: () => Promise<T>): Promise<T> };   // throws ApiError("busy") when `max` are running; never queues
// @mykey/operations — imports/classify.ts (pure)
export type Classification = "create" | "update" | "unchanged" | "invalid" | "duplicate" | "conflict";
export interface Classified { ordinal: number; line: number; name: string | null; classification: Classification; expectedVersion: number | null; expectedStateTag: string | null }
export function classifyEntries(entries: { name: string; value: string; line: number }[], index: Map<string, IndexRow>,
  sameValue: ((name: string, value: string) => boolean) | null): Classified[];      // sameValue null: the caller may not read; every live name is "update"
// @mykey/db — repos/imports.ts
export function insertPreview(tx: pg.PoolClient, p: { id: string; scope: EnvironmentScope; ownerUserId: UserId; fileHmac: Buffer; hmacKeyId: string; entries: Classified[]; ttlSeconds: number }): Promise<Date>;
export function claimPreview(tx: pg.PoolClient, id: string, scope: EnvironmentScope, userId: UserId, operationId: OperationId):
  Promise<{ kind: "claimed"; fileHmac: Buffer; hmacKeyId: string; entries: Classified[] } | { kind: "absent" | "expired" | "taken" }>;
export function insertImportEntries(tx: pg.PoolClient, parentId: OperationId, entries: Classified[]): Promise<void>;
export function nextImportEntry(db: Queryable, parentId: OperationId): Promise<Classified | null>;          // lowest ordinal without an outcome
export type EntryOutcome = "created" | "updated" | "unchanged" | "conflict" | "rejected" | "uncertain" | "not_attempted";
export function recordImportOutcome(tx: Queryable, parentId: OperationId, ordinal: number, outcome: EntryOutcome, childOperationId: OperationId | null): Promise<void>;
export function closeImportEntries(tx: Queryable, parentId: OperationId): Promise<void>;                     // every entry without an outcome becomes not_attempted
export function importResult(db: Queryable, parentId: OperationId): Promise<{ counts: Record<EntryOutcome, number>; entries: { ordinal: number; name: string; outcome: EntryOutcome }[] }>;
export function fileOfParent(db: Queryable, parentId: OperationId): Promise<{ fileHmac: Buffer; hmacKeyId: string } | null>;
export function deleteDeadPreviews(db: Queryable): Promise<number>;                                           // expired and unclaimed, or claimed by a finished parent
// @mykey/db — repos/operations.ts
export function claimResume(tx: pg.PoolClient, id: OperationId, bootId: string): Promise<boolean>;            // awaiting_input → executing, new boot id, heartbeat now
// @mykey/operations — imports/preview.ts, imports/apply.ts
export function fileHmac(ring: HmacRing, bytes: Uint8Array): { mac: Buffer; keyId: string };                  // HMAC-SHA-256(key, "import-file" ‖ 0x00 ‖ bytes)
export function previewImport(deps: ReadDeps & { ring: HmacRing }, request: { scope: EnvironmentScope; userId: UserId; mayRead: boolean; bytes: Uint8Array; requestId: string }): Promise<{ kind: "ok"; body: ImportPreviewBody } | Refused>;
export type ImportOutcome = { kind: "finished" | "waiting" | "replay"; operation: OperationRow } | Refused | { kind: "unknown"; operationId: OperationId };
export function applyImport(deps: EffectDeps, request: { scope: EnvironmentScope; userId: UserId; previewId: string; bytes: Uint8Array; idempotencyKey: string; intent: Intent; requestId: string; budgetMs: number }): Promise<ImportOutcome>;
export function resumeImport(deps: EffectDeps, request: { scope: EnvironmentScope; userId: UserId; operationId: OperationId; bytes: Uint8Array; requestId: string; budgetMs: number }): Promise<ImportOutcome>;
```

Design fixed here (P-76, P-77; Doc 06 §8 "Import", §9, §11; FR-1.35, FR-1.36):

- **Contract commit** `contract: import preview`. `import.preview` → `200 { previewId: string | null, expiresAt: string | null, applicable: boolean, counts: { create, update, unchanged, conflict, invalid, duplicate }, entries: [{ ordinal, line, name: string | null, classification }], issues: [{ line, rule }], warnings: [{ name, loader, kind }] }`. Add to its error list what the handler can answer and the list lacks: `busy` and the backend group. `key_under_review` is not added: a key in review is an entry classified `conflict`, not a refusal. Paths are the contract's: `…/import/preview`, `…/import/:preview/apply`, `…/import-operations/:operation/resume`.
- **Classification.** A name that fails `checkSecretName` or a value that fails `checkSecretValue` → `invalid`, returned with `name: null` (an invalid name is typed text and may be anything). The second and later entry of one name → `duplicate`. No index row → `create`. A row `deleted` or `needs_review`, or named by an occupied slot → `conflict`. A `live` row → `unchanged` when `sameValue` says so, `update` otherwise, with the row's version and tag as the entry's precondition.
- **Preview**, inside the large gate: parse (`ok: false` → `applicable: false`, the parser's issues, nothing stored); under `withEnvironmentLock`: `recheckAccess`; the index rows of the file's names; when `mayRead` (the handler asks `decide` for `secrets.read`), the current value of every `live` name, eight at a time, compared in memory by a constant-time comparison of equal-length buffers; `classifyEntries`; an `invalid` or `duplicate` entry, or no entry at all → `applicable: false`, nothing stored; projected names above 1,000 or projected live bytes above 8 MiB → `507 capacity_exceeded`; otherwise `insertPreview` and one audit row `import.preview` `{ entries: <count> }` in one transaction on the lock connection. The row stores names, lines, classifications, versions and tags — no value, no digest of a value, no length.
- **Apply**, inside the large gate:
  1. Acceptance transaction (main pool): insert the parent operation (action `import.apply`, state `executing`, boot id, heartbeat) — `exists` → `replay`; `claimPreview`: `absent` → refused `not_found`; `expired`, `taken` → `state_conflict`; `fileHmac` of the bytes under the preview's key id differs → `validation_failed`; `insertImportEntries`; audit `import.apply` outcome `intent`. A refusal rolls back: no parent, the preview unclaimed.
  2. Loop over `nextImportEntry`, checking first `touchOperation(parent)` (false → stop and answer from the row) and the budget (after the first entry: elapsed above `budgetMs` → parent `awaiting_input`, answer 202):
     - `unchanged` → outcome `unchanged`; `conflict` → outcome `conflict`; neither touches the backend.
     - `create`, `update` → `runSecretAction` with the value from the parsed file, the entry's precondition, `idempotencyKey: "<parentId>:<ordinal>"`, `parent`, and the child's action id `secrets.create` or `secrets.update`. The lock is taken and released inside each call.
     - Mapping: `succeeded`, or `replay` of a succeeded child → `created` / `updated`. Refused with `version_conflict`, `already_exists`, `state_conflict`, `not_found`, or `key_under_review` naming this entry's own key → `conflict`; with `capacity_exceeded` → `rejected`. `unknown`, or a replayed child that is `uncertain` or `executing` → outcome `uncertain`, **stop**: parent `uncertain`, answer `503 outcome_unknown` with the parent's id. Every other refusal (`busy`, a slot of another operation, `backend_sealed`, `backend_inconsistent`, `dependency_unavailable`, `quarantined`, a state code, lost authority, `audit_unavailable`) leaves the entry without an outcome: parent `awaiting_input`, answer 202.
  3. No entry left: `finishOperation` — `succeeded` when every outcome is `created`, `updated` or `unchanged`, else `partial` — with `importResult` as the result, and audit `import.apply` with the seven counts. Answer 200.
- **An uncertain import** is settled through its child: `reconcileOperation` on the child (the slot holder), then in the same transaction the entry's outcome becomes `created`/`updated` or `rejected`, `closeImportEntries`, and the parent is settled `partial` (or `succeeded` when nothing was left). An import is not resumed after uncertainty: the owner previews the file again, and what was applied shows as `unchanged`.
- **The sweep's import rule:** an `import.apply` parent `executing` with a heartbeat older than 120 s → `uncertain` when one of its children is `uncertain`, `accepted` or `executing` (the child rules run first), otherwise `awaiting_input`; `executor_boot_id` cleared. The sweep also runs `deleteDeadPreviews`.
- **Resume** (Task C; scope valve 3): the parent must be the caller's own (`principal_id`) in this environment, else `not_found`; `executing` → 202 with the current envelope; `uncertain` → `503 outcome_unknown`; terminal → `state_conflict`; the bytes' `fileHmac` must equal `fileOfParent`, else `validation_failed`; `claimResume` (false → 202 with the current envelope); then the loop of apply. Entries keep the preconditions of the preview: what changed in between becomes `conflict`. **If valve 3 is taken:** the route stays in the contract with a handler that answers `state_conflict`, every refusal of the third kind above closes the parent as `partial` with the rest `not_attempted`, and the sweep does the same instead of `awaiting_input`; record it in D-39.

### Task A — preview

- [ ] **Step 1 — Contract commit.**
- [ ] **Step 2 — Failing tests.**
  - `classify.test.ts` (pure): each of the six classifications; `sameValue` null never yields `unchanged`; an invalid name comes back as `null`; ordinals follow file order; the second `A` is `duplicate` and the first is not.
  - `preview.test.ts`: `one new, one changed, one equal name → create, update, unchanged; counts; a previewId; expiresAt 900 s ahead on database time`; `nothing is written: no audited change, index unchanged`; `the stored row, the response, the API log and audit.event do not contain the run-time canary the values carry`; `an unterminated quote → 200, applicable false, the issue with its line, previewId null, no row`; `an invalid name, a reserved prefix, a duplicate, a 65,537-byte value → applicable false, no row, and the invalid name is not in the response`; `an empty file → applicable false`; `a deleted name → conflict and still applicable`; `projected names 1,001 → 507 { limit: "names" }`; `projected bytes above 8 MiB → 507 { limit: "bytes" }`; `1,001 entries and 1 MiB + 1 byte are refused by the body limits with the code the pipeline already answers, before any backend read`; `loader warnings name the key`; `a third large request at once → 503 busy` (two previews held by `beforeHandler`); `the lock is held elsewhere → 503 busy`; `a dead preview is removed by the sweep` (aged through the superuser); roles per `decide` with controls.
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Implement.** **Step 5 — Run:** PASS; `pnpm run contracts:openapi`. **Commit** `feat(import): preview`.

### Task B — apply

- [ ] **Step 1 — Failing tests** (`apply.test.ts`):
  - `the previewed file applies: 200 succeeded; counts; every value's digest through reveal; one child operation per written entry with the parent's id; history names the caller; audited changes equal the created and updated entries; an unchanged key keeps its version`.
  - `the same key again replays the 200; no further change`.
  - `other bytes → 422 and the preview is still unclaimed`; `another member's preview → 404`; `a preview of another environment → 404`; `an expired preview → 409 state_conflict`; `a second apply with a new key → 409 state_conflict`.
  - `a key updated between preview and apply → that entry conflict, the rest applied, 200 partial, and the key holds the other writer's value` (digest).
  - `a name created between preview and apply → conflict`.
  - `an unknown outcome at entry 3 of 5 → 503 outcome_unknown with the parent's id; entries 1–2 applied, 3 uncertain, 4–5 without an outcome; the environment answers key_under_review; after reconcile-operation on the child the parent is partial, entries 4–5 are not_attempted, and the status route shows the result` (fault `after_send` on the third child).
  - `the budget: with budgetMs 0 the answer after the first entry is 202 awaiting_input`.
  - `the lock is free between entries: a reveal of another key answers 200 while the import waits in a hook`.
  - `children are not in operations.list; the parent is`.
  - `1,000 entries of 100 bytes finish` — `succeeded`, or `awaiting_input` and then resume (Task C); the run note records seconds per hundred entries.
  - `no table of app, audit or jobs contains the canary after an import` (text search of `import_preview`, `import_entry`, `operation`, `operation_step`, `outbox`, `audit.event`, `jobs.*`).
  - `expectIndexMatchesBackend` after every test.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** (apply, the sweep's rule, the parent in `reconcileOperation`). **Step 4 — Run:** PASS. **Commit** `feat(import): apply entry by entry through the mutation protocol`.

### Task C — resume and faults

- [ ] **Step 1 — Failing tests.**
  - `resume.test.ts`: `awaiting_input → resume with the same bytes → 200; no entry is written twice` (one audited change per child); `other bytes → 422`; `another member, the owner included → 404`; `a partial parent → 409 state_conflict`; `two resumes at once: one works, the other gets 202`; `a key changed while the import waited → conflict`.
  - `tests/fault/secrets/imports.test.ts` (`faultFixture()`): `the process dies between two entries → after the sweep the parent is awaiting_input; resume finishes; one change per entry`; `the process dies inside an entry after the send → child uncertain, parent uncertain; settled through the child; the parent is partial`; `the process dies after the last entry and before the parent is finished → resume answers 200 succeeded without a change`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(import): resume`. Write D-39.

**Registry:** `FR-1.35`, `FR-1.36`, `AC-1.39`, `PO-17` → `SPIKE_PASS`. **Covers:** FR-1.35, FR-1.36; AC-1.39; PO-17. **Done when:** import is truthfully non-atomic: every entry has one of the seven outcomes, and a resumed import never applies an entry twice.

---

## Run 4.8 — Consistent whole-environment read (D08-S24)

**Files:** `packages/operations/src/secrets/read-environment.ts`, `packages/operations/src/index.ts`, `tests/harness/secrets-fixture.ts`, `tests/integration/read/{complete,race,limits}.test.ts`, D-37 (section "complete read"). If the fallback is taken: `docs/decisions/D-40-complete-read-fallback.md`.

**Consumes:** Run 4.3 (`ReadDeps`, `Refused`, `recheckAccess`, `backendRefusal`), Run 4.2 (lock, slot, review), Run 4.7 (`createLargeGate`, import as a writer in the race); `kvList`, `kvRead`, `environmentPrefix`; `LIMITS.completeResponse`.

**Produces:**

```ts
// @mykey/operations — secrets/read-environment.ts
export interface EnvironmentRead { generation: bigint; entries: { name: string; value: string; version: number }[]; valueBytes: number }   // entries in bytewise name order
export function readEnvironment(deps: ReadDeps, request: { scope: EnvironmentScope; userId: UserId; routeId: string; requestId: string;
  /** Runs in the final transaction on the lock connection; must write the caller's audit row. */
  audit: (tx: pg.PoolClient, read: { names: number; generation: bigint }) => Promise<void> }): Promise<{ kind: "ok"; read: EnvironmentRead } | Refused>;
// tests/harness/secrets-fixture.ts
seedEnvironment(env: string, names: number, bytesEach: number): Promise<void>;     // values through the operator client, index rows and counters through the superuser
```

Session 5 widens the principal for machine resolve; nothing else of this function may change then.

Design fixed here (P-78; Doc 06 §8; FR-1.84; rule 4):

1. `withEnvironmentLock`.
2. One transaction on the lock connection: `recheckAccess`; `slotOf` → any slot is refused `key_under_review` with the holder's id; all index rows; any row `needs_review` → `key_under_review`; the generation `G`.
3. `kvList(environmentPrefix)`: `not_found` is the empty set. The set must equal the index's names (live and deleted). A difference → `markEnvironmentReview`, audit `system.drift_detected` (`kv_data`), `backend_inconsistent`.
4. `kvRead` of every live name, eight at a time. Each must report the index's version, an envelope of format 1 and the index's byte length — otherwise `markKeyReview` and `backend_inconsistent`. Any failed read ends the whole read through `backendRefusal`. Nothing partial is ever returned.
5. `valueBytes` plus the names plus 64 bytes per entry above `LIMITS.completeResponse.maxBodyBytes` → `capacity_exceeded` `{ limit: "response" }`.
6. On the lock connection, one transaction: generation still `G` and no slot → otherwise `environment_changed`; `request.audit(tx, …)`; commit. A failed commit → `audit_unavailable`; `locked.lost()` at any point → `dependency_unavailable`.
7. Unlock, return.

The lock is held for the whole read: a writer of that environment waits two seconds and answers `busy`. That is the design of Doc 06 §8, and the measurement below says how long it is.

**The fallback of Doc 10 §8.1** ("refuse run and export while any write is in flight") is taken when the race test below finds a returned set that matches no generation and half a day does not fix it: then step 2 also refuses while any operation of the environment is `accepted` or `executing`, the race test asserts refusal instead of equality, and D-40 records it.

- [ ] **Step 1 — Failing tests.** A test-only route `GET …/environments/:env/test-read` (through `routes`; inside the large gate) answers `{ generation, entries: [{ name, version, digest }] }` — digests, so that no value is printed by a failing assertion.
  - `complete.test.ts`: `an empty environment → no entries`; `three live and one deleted → three entries in bytewise order`; `a key in review → 409 key_under_review`; `a slot → 409 key_under_review with operationId`; `a name in the backend that the index lacks → 503 backend_inconsistent, environment needs_review, one drift event`; `a name in the index that the backend lacks → the same`; `a deleted name still listed by the backend is no drift` (source reading 3); `a version written past the product → 503 backend_inconsistent and that key in review`; `the Nth backend read fails (relay) → 503 dependency_unavailable, no entries, no audit row`; `audit cannot be written → 503 audit_unavailable, no entries`; `the lock session is terminated before the audit commit → 503 dependency_unavailable` (`before_audit_commit`; Review focus 2); `the generation moves under the read (superuser, in the hook) → 409 environment_changed`; `the audit row is committed when the answer arrives`.
  - `race.test.ts` (AC-1.41, PO-19): two API processes, thirty keys, twenty seconds. Four writers send random create, update, delete, undelete and restore requests (a `busy` answer is retried with the same key) and remember the digest of every value by name and version; one import of ten entries runs in the middle; four readers call `test-read` in a loop. Afterwards the test loads every succeeded secret operation of the environment (`result.generation`, name, version, state) and, for each read, rebuilds the set as of the read's generation. **Every read equals its set exactly**: the same names, versions and digests. The test fails as empty when fewer than 50 reads or fewer than 200 mutations succeeded. A reader may be refused only with `busy`. At the end `expectIndexMatchesBackend`.
  - `limits.test.ts`: `1,000 names of 8 KiB (seedEnvironment) are read completely` — record the seconds, assert under 60; `a third large read at once → 503 busy`; `a writer during the long read gets busy and succeeds on retry afterwards`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; run `race.test.ts` five times in a row. **Commit** `feat(secrets): the complete environment read`. Add the section to D-37; the run note records the local time for 1,000 names and the number of reads and mutations of one race run.

**Registry:** `FR-1.84`, `AC-1.41`, `PO-19` → `SPIKE_PASS`; `G-RESOLVE` → `SPIKE_PASS` with the note "human path; machine resolve is Run 5.1". **Covers:** FR-1.84; AC-1.41; PO-19, G-RESOLVE. **Done when:** a read racing a multi-key change returns a set from one generation or fails as a whole.

---

## Run 4.9 — Human export (D08-S25)

**Files:** `apps/api/src/pipeline/{route,context}.ts`, `apps/api/src/routes/export.ts`, `apps/api/src/app.ts`, `packages/audit/src/events.ts`, `tests/unit/api/export-headers.test.ts`, `tests/integration/export/{export,roundtrip,surfaces}.test.ts`, `tests/integration/authz/matrix-live.test.ts`, `tests/staging/export.staging.test.ts`, D-37 (section "export").

**Consumes:** Run 4.8 (`readEnvironment`), Run 4.7 (`createLargeGate`, preview and apply for the round trip), `serializeDotenv`, `loaderWarnings`; `stack.readAuditLog`, `pgDump`, `postgresLog`.

**Produces:**

```ts
// apps/api — pipeline/context.ts
export interface HandlerResult { status: number; body?: unknown; headers?: Record<string, string>;
  /** Only for a route whose response kind is "dotenv-attachment". */ raw?: { bytes: Uint8Array; contentType: string } }
// apps/api — routes/export.ts
export function exportHeaders(environmentName: string, bytes: Uint8Array, warnings: { name: string; loader: string; kind: string }[]): Record<string, string>;   // P-79
export const exportCreateHandler: Handler;
```

Design fixed here (P-79; Doc 06 §8, §9; FR-1.34, FR-1.37):

- The route asks for a fresh TOTP (`human_fresh_totp`, checked by the pipeline) and `{ confirmed: true }`. It is not idempotent and records no operation.
- The handler: large gate → `readEnvironment` with an audit callback that writes `secret.export` `{ names }` → `serializeDotenv` → `exportHeaders`. Every refusal is the JSON error envelope.
- The pipeline's answer for `raw`: the bytes as the body, `content-length` set from `bytes.length`, `cache-control: no-store`, no transformation. A `raw` result on any other route, or a `dotenv-attachment` route without it, is `output_invalid` → `503 dependency_unavailable`.
- File name: the environment's name lower-cased, every character outside `[a-z0-9-]` replaced by `-`, at most 63 characters; `environment` when nothing is left.

### Task A — export

- [ ] **Step 1 — Failing tests.**
  - `export-headers.test.ts`: the digest of a fixed input; a name with spaces, quotes and a line break gives a safe file name; 300 warnings give the truncated form under 8 KiB.
  - `export.test.ts`: `200 with exactly the headers of P-79; content-length equals the body; content-digest verifies; no content-encoding even when the request accepts gzip`; `the body parses to the environment's names with equal digests, in bytewise order`; `an empty environment → 200, length 0`; `without a fresh TOTP → 403 fresh_verification_required`; `confirmed missing → 422`; `the audit row secret.export is committed when the answer arrives`; `audit cannot be written → 503 as JSON, and the body does not contain the canary`; `a key in review → 409 key_under_review as JSON`; `the @next/env case of the dotenv tests appears in mykey-export-warnings by name`; `an 8 MiB environment exports` (`seedEnvironment`); roles per `decide` with controls; `a denied export leaves no secret.export`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(export): the environment as a dotenv attachment`.

### Task B — round trip and surfaces

- [ ] **Step 1 — Failing tests.**
  - `roundtrip.test.ts` (AC-1.17): an environment with values that are empty, multiline, quoted both ways, with `$`, `#`, `=`, backslashes, leading and trailing spaces, tabs, four-byte characters and 65,536 bytes → export → preview and apply into an empty environment → export again: the two bodies are byte-identical (compare digests) and every name is `created`. `An export above 1 MiB is refused by the import body limit` — the known limit of CLAUDE.md, asserted so that it stays known.
  - `surfaces.test.ts` (rule 2; a private stack): one run-time canary per action — created, updated, restored, revealed, imported, exported. Then the canaries are absent from: every log entry of the API processes; `pgDump()` of the whole database; `postgresLog()`; `stack.readAuditLog()` (OpenBao's audit device, where values are HMAC-ed); the provisioner's output. Control: each canary **is** found in the reveal or export response that should carry it, so the search itself is proven.
- [ ] **Step 2 — Run:** FAIL (or pass at once: then break the control once, see it fail, restore). **Step 3 — Fix what leaks.** **Step 4 — Run:** PASS. **Commit** `test(export): round trip and value surfaces`.

### Task C — the live matrix

- [ ] **Step 1 — Failing test** `matrix-live.test.ts` (P-80; `createSecretsFixture()`): for the fifteen routes of this session (`secrets.*` eight, `import.*` three, `export.create`, `operations.get`, `operations.list`, plus `environments.list` as the unchanged control) and the seven members of `createTenants`, in environment 1a and for `envEditorA` also 1b: the expectation comes from `decide`. Allowed → a valid request prepared by the fixture answers 2xx. Denied → `403 action_denied`. Hidden → a 404 equal to the 404 of a random id. For every cell that is not allowed: no audited backend change and no operation row.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Fix** what differs (a difference is a finding: write it into the run note before fixing). **Step 4 — Run:** PASS, and `matrix.test.ts` unchanged. **Commit** `test(authz): the matrix on real handlers`.

### Task D — staging

- [ ] **Step 1 — Deploy** the branch. Note the alert window.
- [ ] **Step 2 — `export.staging.test.ts`** (target assertion; a new project):
  - `export through the edge: content-length present, content-digest verifies, no content-encoding with Accept-Encoding: gzip, br, cache-control no-store`.
  - `round trip on staging` with twenty names.
  - **The measurement of P-62:** eight imports of 125 entries of 7 KiB build an environment of 1,000 names and about 7 MiB; record the seconds of each import (and how many answered `awaiting_input`), then export it three times and record the seconds. `The slowest export is under 60 s.`
- [ ] **Step 3 — Run.** PASS → write the numbers into D-34. Above 60 s → take the fallback of P-62 (one login token in memory for 15 minutes, revoked at shutdown, never written anywhere; `tests/integration/openbao/inline.test.ts` gains the token-mode cases), deploy, measure again, and record both in D-34.
- [ ] **Step 4 — Commit** `test(staging): export, round trip, full-size environment`.

**Registry:** `FR-1.37`, `AC-1.17` → `SPIKE_PASS`. **Covers:** FR-1.37; AC-1.17. **Done when:** the file round-trips, and no plaintext canary exists outside the response and the backend.

---

## Run 4.10 — Session 4 gate

- [ ] **Step 1 — Full suite from a clean clone** outside OneDrive (`git clone` of branch `session-4` into `C:/Users/gmpar/mykey-gate/session-4`): `pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm test`, `pnpm run test:integration`, `pnpm run test:cloud`. Expected: everything green except, from 15 Nov 2026 09:42 UTC, the R2 fixture guard in `test:cloud` — list the failing test names; any other failure is a finding. The watched load flakes (`tests/fault/effects/exclusion.test.ts`, `tests/integration/api/health.test.ts`, the ops kill-point cases, and now `tests/fault/secrets`): a failure under the whole suite is re-run alone once and listed in the report either way. CI on the branch is green (`gh run list --branch session-4 --limit 5`).
- [ ] **Step 2 — Dated items.**
  - `.trivyignore.images` (expires 20 Nov 2026): run `node scripts/ci-scan.ts images` against a copy without the ignore file; for each of its entries: a fixed stable upstream image exists → move the pin (digest) and drop the entry; none → keep it with a new expiry of at most 30 days and the reason. Commit `chore(scan): image ignore list reviewed`.
  - Remove the obsolete workstation copy of the `provisioner_runtime` password; update `docs/runbooks/credential-custody.md` (names and locations only).
- [ ] **Step 3 — Checkpoint `pairs-lock-session-gate`** (due from 15 Nov 2026 10:42:20 UTC): record it the way the retention fixture defines (`tests/restore/retention/fixture.cloud.test.ts` and the evidence file it reads say where and in which shape). If the gate runs before that time, write "not due" into the report and carry it to the Session 5 start.
- [ ] **Step 4 — Staging deploy** of the final commit; `status`: gate open, `runtimeLogin: ok`, `reviewOpen: 0`, `operationsUnresolved: 0`.
- [ ] **Step 5 — Staging suite:** `pnpm run test:staging` (about two hours with the drills; it reboots staging; announce the window). It includes `secrets`, `reconcile` and `export` of this session. Then by hand, recorded in the run note:
  - an import of 1,000 entries of 100 bytes through the public name, to its end (resume when it answers `awaiting_input`);
  - the canary sweep on staging → `docs/evidence/session-4/canary-sweep.txt`: for each surface (API and provisioner logs, `pg_dump`, PostgreSQL log, OpenBao audit device, Traefik access log) the command, the number of canaries searched and the number found — surface names and counts only, through `secretOutput` where the path demands it;
  - the time of the Telegram message for `operations_unresolved` and of its clearing.
- [ ] **Step 6 — Production**, only when `owner-requests.md` holds the owner's yes: image and migrations `0011`–`0012`, `up`; its gate stays not open; `status`. Otherwise write "not updated, by default" into the report.
- [ ] **Step 7 — One fresh-context review** of `git diff main...session-4` (`superpowers:requesting-code-review`), given the plan, Doc 10 §4.1 and these questions:
  1. Is there any path after the dispatch marker that answers something other than `outcome_unknown` or the true result?
  2. Can a backend change be sent twice — a retry, a loop, a replay that executes, a resumed import entry?
  3. Can a value reach PostgreSQL, a log line, an error body, an audit detail or a job?
  4. Is every value release (reveal, export) preceded by a committed audit row on the lock connection, and dropped when the lock was lost?
  5. Can an advisory lock or an effect slot outlive its request without an alert?
  6. Does any handler decide authority, or does any check read a cached row?
  7. Can `reconcile-operation` call an operation `rejected` without exclusion, or `succeeded` without evidence in the backend?
  8. Do the counters and the generation move in every finalizing path, and only there?
  9. What do the tests of this session not prove that the report claims?
- [ ] **Step 8 — Findings:** Critical and Important are fixed with a failing test first; minors are listed in the report with the run that owns them. Re-run what the fixes touch, then Step 1's `check`, unit and integration suites.
- [ ] **Step 9 — Registry:** set the statuses named in Runs 4.1–4.9 in `registry-overrides.json` (each with its run note; `SPIKE_PASS` or `FAIL` only), `pnpm run evidence:build`, `pnpm run check`.
- [ ] **Step 10 — Report** `docs/evidence/session-4/report.md`: verdict (PASS / PASS WITH ISSUES / FAIL); what exists; the gate's commands and results; the fault table of Run 4.6; the measurements (inline authentication, 1,000-name read, 1,000-entry import); decisions D-34 … D-39 (D-40 if taken); deviations from this plan; findings of the review and what became of them; open issues with owner runs; **"What Session 5 must know"** — at least: `readEnvironment` is the one complete read and how machine resolve must call it; the large gate; the effects still without a marker (issuance, revocation, archive); `ops operations-expire` and the sweep have no host timer yet (Run 6.9); rate limits for reveal, import and export are Run 6.3; the state of valves 3 and 5; the dated items that remain.
- [ ] **Step 11 — `CLAUDE.md`:** "Where we stand" (Session 4 done, what exists, what Session 5 needs) and "Things already learned" (only what every later session needs). Commit `docs: session 4 report`.
- [ ] **Step 12 — Pull request** `session-4` → `main` with the report's summary. Do not merge. Tell the owner in one message: the verdict, the open decisions, the pull request.

**Covers:** the session gate of Doc 10 §7. **Done when:** the report exists, the review's Critical and Important findings are closed, and the pull request is open.

---

## Session 4 end state

- **API:** handlers for `secrets.list`, `secrets.history`, `secrets.reveal`, `secrets.create`, `secrets.update`, `secrets.delete`, `secrets.undelete`, `secrets.restore`, `import.preview`, `import.apply`, `import.resume`, `export.create`, `operations.get`, `operations.list`. The pending snapshot loses `secrets.list`, `secrets.history`, `secrets.reveal`, `import.preview`, `operations.list`.
- **Runtime identity:** the API reads and writes KV as `runtime` with inline AppRole authentication (D-34), or with the in-memory token if the measurement forced it.
- **Operations engine:** `@mykey/operations` root exports the secret protocol, the reads, import and the stale-work sweep; `/operator` exports reconciliation. Migrations up to `0012`.
- **Operator:** `ops operations`, `reconcile-operation`, `reconcile-environment`, `operations-expire`; `host.ts quiesce | resume`; runbook `reconciliation.md`; the probe condition `operations_unresolved`.
- **Proof:** `tests/integration/{operations,secrets,reconcile,imports,read,export}`, `tests/fault/secrets`, `tests/integration/authz/matrix-live.test.ts`, `tests/staging/{secrets,reconcile,export}.staging.test.ts`; the canary sweep of staging.
- **Staging** runs the session's final commit with the gate open, no operation unresolved and nothing in review. **Production** is updated only on the owner's word and its gate stays not open.
- **Registry:** FR-1.20, 1.21, 1.24–1.32, 1.35–1.37, 1.82–1.84, 1.88; AC-1.12, 1.14–1.17, 1.38, 1.39, 1.41; PO-7, PO-17, PO-19; G-EFFECT (KV), G-RESOLVE (human path) at `SPIKE_PASS`. Nothing `PASS`.
- **Left for later, on purpose:** machine resolve and credentials (Session 5); archive (Run 5.3); rate limits (Run 6.3); host timers for expiry and cleanup (Run 6.9); the browser side of reveal, import and export (Session 7); the replacement of the Run 2.4 spike under the backup rehearsal (Run 6.5).
