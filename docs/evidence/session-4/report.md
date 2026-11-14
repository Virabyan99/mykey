# Session 4 report — Operations engine and secret lifecycle

**Date:** 13–14 November 2026 · **Branch:** `session-4` · **Plan:** `docs/plans/session-4-plan.md`

## Result

**PASS WITH ISSUES.** All ten runs are done. On the integrated product, locally on real stores and on staging through the public name:

- **Secret lifecycle.** Secrets are created, updated, deleted, undeleted and restored under the six-step protocol: one environment lock on its own connection, a dispatch marker, exactly one backend change, a read-back and a finalize.
- **After the marker.** Any failure after the dispatch marker answers `503 outcome_unknown` with the operation id.
- **Reconciliation.** Stale work becomes `uncertain`, raises `operations_unresolved`, and is settled only by the operator. A write that did not land is called `rejected` only under exclusion.
- **Import.** Previewed, applied entry by entry through the same protocol, resumable, and truthfully non-atomic.
- **Complete read and export.** The environment is read completely under the lock, and a dotenv export makes a byte-identical round trip.
- **Faults.** The fault suite (killed processes at every point of every action, held and cut connections, store restarts) ended every case truthfully with at most one backend change.

Nothing is `PASS`. 30 items moved to `SPIKE_PASS`.

The issues:

- The fresh review found two Important defects in import (fixed with failing tests first) and eight Minors (deferred, each with an owner run).
- The staging suite had gone stale in five places over Sessions 3–4: tests that expected 404 from routes that now have handlers, production's by-design `health_failing`, the provisioner container, and a password the workstation no longer holds. All were fixed in the tests; none was a product fault.
- **A finding of my own at the gate:** the host-side search I wrote for the staging canary sweeps could find nothing. It ran `producer | grep -f /dev/stdin`, and inside a pipeline grep's stdin is the producer's output. The first sweep's 0 was therefore worthless. Its controls exposed it, and the search was fixed and proven with controls (`4ce558c`). The valid sweep found 0 canaries on all six surfaces, with every control found.
- Two heavy suites at once exhaust the workstation's memory: the gate's first staging run and an integration rerun killed each other. Heavy jobs now run one at a time.
- Production was updated on the owner's yes (API and migrations `0011`–`0012`). Its gate stays not open.

## Step 1 — the full suite

From a clean clone outside OneDrive (`C:/Users/gmpar/mykey-gate/session-4c`, commit `2d6678a`, the final product code; later commits change tests and documents only), each suite alone on the workstation:

| Command                                        | Result                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`               | exit 0                                                                             |
| `pnpm run check` (before and after the suites) | exit 0 both times (registry ok, 191 items); the clone stayed clean                 |
| `pnpm test`                                    | 61 files, 874 passed                                                               |
| `pnpm run test:integration --maxWorkers=2`     | **98 files, 1,055 passed** in 29 min (14:05–14:35 UTC)                             |
| `pnpm run test:cloud`                          | 8 of 8, 14 Nov 2026 15:12 UTC, before the R2 fixture guard date (15 Nov 09:42 UTC) |

CI on the branch: green on every push of the session's last day (`43582428213`, `43585586924`, `43588405515`, `43602900249`). Since Run 4.9 the integration job runs as two shards, about 16 and 21 minutes.

How the gate got there:

- **The first full run** (clone `session-4`, after the review fixes): `imports/preview.test.ts` "nothing is written" failed twice. It counted KV changes in every namespace, so another file's writes counted against it. The test now counts its own namespace (`3e48098`).
- **A rerun alongside the staging suite** ran out of memory. Workers failed to start (`0xC0000142`), and `read/race.test.ts` and `fault/effects/exclusion.test.ts` starved. The run was stopped; the owner chose one heavy job at a time.
- **Watched load flakes:** `fault/effects/exclusion.test.ts`, `api/health.test.ts`, the ops kill-point cases and `tests/fault/secrets`. None failed in the final run.

## Step 2 — dated items

- **`.trivyignore.images`** (due to expire 20 Nov): re-reviewed on 14 Nov. PostgreSQL 18.7 and `node:24.22.3-alpine` carry the same findings, and OpenBao 2.7.2 and restic 0.19.1 are the latest releases. No pin moved. All 52 entries now expire on **14 Dec 2026** (`39f28f4`).
- **The workstation copy of `provisioner_runtime`:** the owner shredded both hosts' copies (`shred -u`). The auto-mode classifier refused to let the agent do it. `credential-custody.md` and `network.md` now say the password lives only on the host. `tests/harness/staging-db.ts` reads it there.

## Step 3 — checkpoint `pairs-lock-session-gate`

**Not due.** It is due from 15 Nov 2026 10:42:20 UTC and the gate ran on 14 Nov. Carried to the Session 5 start.

## Steps 4–5 — staging

**Images now on staging** (deployed 14 Nov 2026 14:37–14:40 UTC):

- API `2d6678af2342` (`sha256:d3af80b7…`)
- Provisioner `sha256:b85e3f5c…`
- Migrations up to `0012` (`db-init` applied nothing new)

**State:** gate open, provisioner healthy, unsealed, `runtimeLogin: ok`, `reviewOpen: 0`, `operationsUnresolved: 0`.

**The suite, one file at a time** (the whole-suite run had been cut short by the memory reaper):

| File                           | Result                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| `probe.staging.test.ts`        | 4 passed (the drills: sink failure, blackout, dead endpoint) |
| `boundary.staging.test.ts`     | 12 passed                                                    |
| `identity.staging.test.ts`     | 14 passed (again after the search fix, with its control)     |
| `api.staging.test.ts`          | 12 passed                                                    |
| `transport.staging.test.ts`    | 10 passed                                                    |
| `provisioning.staging.test.ts` | 5 passed                                                     |
| `pair.staging.test.ts`         | 12 passed                                                    |
| `secrets.staging.test.ts`      | 4 passed; again on the final image                           |
| `reconcile.staging.test.ts`    | 1 passed; again on the final image                           |
| `export.staging.test.ts`       | 3 passed; again on the final image                           |
| `unseal.staging.test.ts`       | 10 passed (includes a reboot)                                |
| `key-loss.staging.test.ts`     | 2 passed                                                     |
| `kms-expiry.staging.test.ts`   | not due (excluded until 12 Dec 2026 09:57 UTC, by design)    |

The suite's first run on Session 4 code failed in seven tests across five files, all stale assumptions in the tests. They were fixed in `b212856` and `2d6678a`:

- `identity`: `secrets.list` and `secrets.create` have handlers now (200 and 201, not 404). Also, the download of OpenBao's audit device timed out because the file had grown to about 500 MB.
- `boundary`: the provisioner container was missing from the expected container list.
- `probe` and `transport`: production's `/health` is down by design, and a down `/health` logs `health_down` under the same request id.
- `pair`: `staging-db.ts` read the shredded workstation copy of `provisioner_runtime`.

The suite also rewrote evidence files of earlier runs (host scans, `pair-spike.json`, the Session 3 sweep, `run-4.5-*.json`, `run-4.9-staging.json`). They were restored to their committed versions, and the gate's numbers are in this report. The append-only drill logs of Session 2 (probe, pair, key-loss, unseal) keep the gate's lines.

**By hand, on the final image:**

- **1,000 entries of 100 bytes** through the public name: one `apply` answered `200 succeeded` in **75.7 s** (1,000 created, nothing else), with no resume. That is about 76 ms per entry, against 150–220 ms on the workstation's Docker. Project `s4-bulk-9526967b` (`ecbdf8ab-8853-43a0-95a1-4f22bc9b3178`), operation `2070c1a2-e9a5-4096-afad-710d0fa8eda4`.
- **The canary sweep** (`canary-sweep.txt`), 15:01 UTC:
  - Six run-time canaries went through create, update, restore, reveal, import and export in project `s4-sweep-8fde1614`. Controls: the reveal carries its canary, and the export carries the five stored ones.
  - Each surface was searched on the host with the canaries on stdin and only counts coming back: API log, provisioner log, a `pg_dump` of the database, PostgreSQL log, OpenBao's audit device (502 MB) and Traefik's access log.
  - Each surface has non-secret controls that must be found: the export's request id, a job line, a secret name and the project name, the server's ready line, the KV path, the export path.
  - **Result: 0 canaries found on every surface, and every control found.**
- **`operations_unresolved` on the real channel**, from the reconcile drill (the probe's delivery is the Telegram message):

  | Run               | Uncertain | Alert delivered   | Quiesced | Verdict    | Resumed  | Cleared  |
  | ----------------- | --------- | ----------------- | -------- | ---------- | -------- | -------- |
  | gate, first image | 13:13:15  | 13:14:26 (+71 s)  | 13:15:15 | `rejected` | 13:16:04 | 13:17:29 |
  | gate, final image | 14:42:40  | 14:44:27 (+107 s) | 14:45:02 | `rejected` | 14:45:33 | 14:46:30 |

**Alert windows** (14 Nov, UTC): the drills of `probe` (about 10:43–11:03 in the cut-short run and 12:20–12:40) and `unseal` (13:22–13:36), the reconcile drills above, and the deploy (14:39–14:40). Every alert opened and resolved. At 15:15 UTC none is open on staging, and production has only its by-design `health_failing`.

## Step 6 — production

Updated on the owner's yes (`owner-requests.md`), 14 Nov 2026 15:09–15:11 UTC:

- `push`, `image api` (`2d6678af2342`, `sha256:d3af80b7…`), `db-init` (applied `0011_operation_scope`, `0012_environment_review`; job queues present), `up`.
- The API started (`listening`; `selfcheck runtimeLogin: absent`, because production has no OpenBao).
- No gate file, no OpenBao, no provisioner, no owner. Every route answers `503 quarantined` and `/health` reports `down`. The probe's `health_failing` stays open for production until the owner opens its gate.
- `status`: API, edge and postgres running, `pki-init` exited (it runs once); `gate: absent`; `reviewOpen: 0`; `operationsUnresolved: 0`; `provisioner: absent`.

## Step 7 — the fresh-context review

A reviewer agent with no history of the session got `git diff main...session-4`, the plan, Doc 10 §4.1 and the plan's nine questions. **No Critical finding.** The reviewer found the single-key protocol sound on every question: no path after the marker answers anything but `outcome_unknown` or the truth, nothing sends twice, no value reaches PostgreSQL, a log, an error or a job, every value release is preceded by its committed audit row on the lock connection, and reconciliation never calls a not-landed write `rejected` without exclusion. Two Important findings were in import.

**Fixed, each with a test that failed first** (`fa6667b`):

| Finding                                                                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                                                                                                      | Test (`tests/fault/secrets/imports.test.ts`)                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **I-1.** An uncertain import parent whose child had already been settled by the sweep (a child that lost its lock between admission and the marker) could not be reconciled: `reconcile-operation` answered undetermined for ever | `reconcileOperation` settles such a parent from its entries (`settleParentFromEntries`): after the sweep, under the parent's row lock, each open entry takes its latest child's verdict; a child still running is `executors_not_excluded`, an uncertain one is settled first. Then the entries close and the parent settles with audit. | "a child loses its lock between admission and the marker": RED (undetermined) → GREEN; the parent ends `partial`, 0 backend changes |
| **I-2.** A throw inside the entry loop after acceptance (a database error between entries) answered `503 dependency_unavailable` without the parent's id, so the client could not find its import                                 | `runEntries` catches anything thrown by the loop and answers `503 outcome_unknown` with the parent id; the sweep and resume continue from there                                                                                                                                                                                          | "a failure inside the loop": RED (`dependency_unavailable`) → GREEN; resume → 200 `succeeded`, one change per child                 |

The touched suites ran 11 files, 120 passed.

**Deferred (Minor), with owner runs:**

- **M-1** (6.x): a gate closed during an import rejects the remaining entries instead of leaving them for a resume (`gateOpen` is checked only in the dispatch transaction).
- **M-2** (5.x): `unchanged` entries are not rechecked at apply or resume (expected version and tag against the index).
- **M-3** (6.x): `operations_unresolved` counts every action, so a killed provisioner's `environment.provision` row raises it. The premise of the ruling that left it so was false: the provisioner does heartbeat.
- **M-4** (6.x): a heartbeat with a null `operationsUnresolved` clears the alert (inherited from `review_open`).
- **M-5** (6.3): the third large request is refused only after its body was read; P-77 says before.
- **M-6** (5.x): a stored `busy` or `quarantined` rejection replays as such for 30 days to a retry with the same key. Document it, or store `dependency_unavailable`.
- **M-7** (6.9): a resume more than 30 days later, after `operations-expire`, parks on `idempotency_conflict`.
- **M-8** (8): `recheckOf` decides authority in the handler module and writes no `access.denied` row.

**What the tests do not prove** (question 9, the reviewer's list; the claims in this report are worded to fit):

- FR-1.30 "two sweepers" runs two `api_runtime` pools in one process, not two processes. The sweep is plain SQL and the row lock decides.
- On staging, FR-1.31 never settles a landed write without exclusion. The drill caught a delete, which always needs exclusion; the landed-write verdicts are proven locally (`operation.test.ts`, the fault table).
- The boundaries table cannot catch an unconditional `finishOperation`. Run 4.5's "a swept executor cannot finalize" does.
- The AC-1.41 race uses writers on disjoint keys.

## Step 8 — the fix pass

After `fa6667b` the gate suite found two test defects of its own:

- `tests/integration/imports/preview.test.ts` "nothing is written" counted KV changes in every namespace, and failed when another file wrote at the same time. It now counts its own namespace (`3e48098`).
- `tests/integration/authz/matrix.test.ts` wrote `authorization-matrix.md` unformatted, so `check` failed after any run of it. It now writes through prettier (`3e48098`).

## Step 9 — registry

Applied through `registry-overrides.json`, each entry with its run note: **83 `SPIKE_PASS`, 108 `OPEN`, nothing `PASS`.** The 30 Session 4 items:

| Run | Items                                             |
| --- | ------------------------------------------------- |
| 4.2 | FR-1.20, FR-1.24, FR-1.25, AC-1.14                |
| 4.3 | FR-1.21, FR-1.26, AC-1.12                         |
| 4.4 | FR-1.27, FR-1.28, FR-1.29, FR-1.32, AC-1.15, PO-7 |
| 4.5 | FR-1.30, FR-1.31, FR-1.88, AC-1.16                |
| 4.6 | FR-1.82, FR-1.83, AC-1.38, PO-16 (G-EFFECT, KV)   |
| 4.7 | FR-1.35, FR-1.36, AC-1.39, PO-17                  |
| 4.8 | FR-1.84, AC-1.41, PO-19 (G-RESOLVE, human path)   |
| 4.9 | FR-1.37, AC-1.17                                  |

`FR-1.22` (reveal) stays `OPEN` on purpose: its server half is proven (`reveal.test.ts`), its browser half is Run 7.x.

## The fault table (Run 4.6)

Real API processes killed at each point, for each of the five actions. In every case the index equals the backend and no value is in the dead process's output.

| Crash at                                                  | Actions                 | Row after the crash  | After the sweep                                          | Settlement                                                        | Changes |
| --------------------------------------------------------- | ----------------------- | -------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| `after_admission`                                         | all 5                   | accepted, slot held  | rejected, slot free; replay `503 dependency_unavailable` | none                                                              | 0       |
| `after_dispatch_marker`                                   | all 5                   | executing, slot held | uncertain; replay `503 outcome_unknown`                  | undetermined without exclusion, **rejected** with it              | 0       |
| `after_send`, `after_read_back`, `before_finalize_commit` | create, update, restore | executing, slot held | uncertain                                                | **succeeded without exclusion**; replay 200/201                   | 1       |
| the same three points                                     | delete, undelete        | executing, slot held | uncertain                                                | undetermined without exclusion, **succeeded** with it; replay 200 | 1       |
| `after_finalize`                                          | all 5                   | succeeded, slot free | unchanged                                                | none; replay 200/201                                              | 1       |

The delays file (13 cases: answers held past the deadline, requests held with and without exclusion, a cut connection, PostgreSQL restarted between send and finalize, OpenBao sealed and stopped, a process dying while another serves, a provisioner job alongside) is in `run-4.6.md`. The import fault file has five cases, two of them the review's.

## Measurements

| What                                                                | Where                      | Result                                                                                                                       |
| ------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 50 sequential updates, inline AppRole on every request (D-34)       | staging, public name       | Run 4.2: median 677 ms (570–1,150). Gate: median **257 ms** (238–326); final image 260 ms (235–355)                          |
| 1,000 names of 8 KiB, complete read under the lock                  | local stack                | 5.32 s                                                                                                                       |
| 8 MiB export (1,000 × 8,388 bytes)                                  | local stack                | 5.72 s                                                                                                                       |
| 8 imports × 125 entries of 7 KiB                                    | staging                    | Run 4.9: 9.1–13.1 s each. Gate: 11.2–13.1 s; final image 10.9–12.1 s; none needed a resume                                   |
| export of 1,000 names (7,182,000 bytes), P-62's ceiling 60 s        | staging, public name       | Run 4.9: 10.6, 18.8, 19.8 s. Gate: 12.2, 15.4, 23.5 s; final image 13.8, 11.5, 8.9 s. **Inline authentication stays** (D-34) |
| 1,000 entries of 100 bytes                                          | local stack                | 684 in the 100 s budget, then `202 → 202 → 200`, 220 s in all                                                                |
| 1,000 entries of 100 bytes                                          | staging, public name       | one request, `200 succeeded` in **75.7 s** (76 ms per entry), no resume                                                      |
| `operations_unresolved` on the real channel (reconcile drill, gate) | staging → probe → Telegram | uncertain 13:13:15, **delivered 13:14:26** (71 s), quiesced 13:15:15, `rejected`, resumed 13:16:04, **cleared 13:17:29** UTC |

## Decisions

- **D-34:** the API's runtime identity is the organization's `runtime` AppRole with inline authentication on every request, with no token held. The bound of P-62 was measured on staging and holds, so the fallback (an in-memory token) is not taken.
- **D-35:** operations carry their scope (project, environment, secret name, parent); a replay answers by stored state; path parameters are part of the intent; terminal records expire into tombstones (`replay_expired`, `ops operations-expire`); `operations.get` and `operations.list` follow scope `operation`.
- **D-36:** the mutation protocol — one advisory lock per environment on a dedicated connection; pre-read, admission, dispatch marker, one change, read-back, finalize; `uncertain` after the marker; delete and undelete have no backend marker and are settled under exclusion.
- **D-37:** list from the index, history from metadata plus version events, reveal under the lock with its audit row committed before release; the complete read (`readEnvironment`); export as a dotenv attachment.
- **D-38:** the stale-work sweep, the `operations_unresolved` alert, operator reconciliation of operations and environments, exclusion before `rejected`.
- **D-39:** import — preview, apply entry by entry as child operations, resume, seven outcomes, `partial`; scope valve 3 not taken.

No D-40 was needed.

## Deviations from the plan

Each is in its run note and the ledger. The ones that change what the product does:

- **Tombstone rights** (4.1): migration `0011` revokes `INSERT, UPDATE` on `app.operation_tombstone` from `api_runtime`; the plan said no grant changes.
- **Body shapes** (4.2, 4.3): a missing or wrongly typed field is `400 malformed_request`, not 422 (Doc 06 §9 as the pipeline applies it).
- **The reconcile drill** (4.5) pauses OpenBao during delete/undelete loops: an update caught by the pause fails its pre-read before the marker.
- **`rebuildKey`** (4.5) keeps the tag of a row that already matches the backend.
- **An import whose entries are all conflict or rejected ends `partial`** (4.7), not `rejected` as Doc 06 §8 says (D-39).
- **A dotenv body is bytes** (4.7) and enters the fingerprint as its SHA-256 digest.
- **CI integration in two shards** (4.9): the job hit its 30-minute limit.
- **The identity sweep searches OpenBao's audit device on the host** (gate): the file outgrew a 120 s download. The canaries go on stdin and only counts come back. The first version read its patterns from the pipe and searched nothing; `countOnHost` (`tests/harness/staging.ts`) puts them on fd 3 and requires controls (`4ce558c`).

## Open issues (with owner runs)

- **5.x:** M-2, M-6.
- **5.1:** machine resolve must call `readEnvironment` (below).
- **5.3:** archive and reactivate; their own grants.
- **6.3:** rate limits for reveal, import and export; M-5.
- **6.x:** M-1, M-3, M-4.
- **6.9:** host timers for `ops operations-expire`, the stale-work sweep outside the API, and `ops auth-cleanup`; M-7.
- **7.x:** the browser side of reveal, import (including the resume) and export.
- **8:** M-8.
- **Runbook `reconciliation.md` step 4** (an evidence conflict) asks the operator to read versions with the root token; there is no command for it yet.
- **Throughput of import:** about 150–220 ms per entry on the workstation's Docker, 76 ms on staging, where 1,000 entries fit one request. Locally a full environment needs resumes; the web workspace must still offer them.
- **The watched load flakes**, listed under Step 1.

## What Session 5 must know

1. **`readEnvironment`** (`@mykey/operations` root, `secrets/read-environment.ts`) is the one complete read: under the environment lock, recheck and slot check, every index row, the generation, the backend's list against the index, values eight at a time with version and length checked, the response limit, then a final transaction that checks the generation and commits the caller's audit row before anything leaves. Machine resolve (Run 5.1) must call it with its own audit row and its own recheck callback (a machine principal), never read KV around it. Any refusal refuses the whole read.
2. **The large gate** (`apps/api/src/large.ts`): two large requests per process, a third answers `503 busy` (today after its body is read: M-5). Import, export and the complete read run inside it; machine resolve of a large environment should too.
3. **Effects still without a marker:** issuance, revocation and archive (Session 5) are not under the protocol yet. PO-16 (G-EFFECT) is proven for the KV actions only. Each new effect needs its marker or its exclusion rule (D-36, D-38) and rows in the fault table.
4. **No host timers yet:** `ops operations-expire` and an operation sweep outside the API run only by hand (Run 6.9). The sweep runs inside each API process every 30 s.
5. **Rate limits** for reveal, import and export are Run 6.3; they build on `bumpCounter`.
6. **Scope valves:** valve 3 (import resume) and valve 5 (restore of an old version) were **not** taken; both features exist.
7. **Reconciliation:** `ops operations`, `ops reconcile-operation <id>` (exit 3 = needs exclusion), `ops reconcile-environment`, `host.ts staging quiesce|resume`; runbook `reconciliation.md`. An import parent is settled through its child, or from its entries when no child is open.
8. **Staging tests are part of the product:** every route that gains a handler, every container added to a host and every credential moved breaks a staging test written earlier. Run the staging files one at a time, alone on the workstation. A staging run also rewrites committed evidence files of earlier runs; restore them before a commit.
9. **Searching a host for values:** use `countOnHost(host, producer, secrets, controls)` from `tests/harness/staging.ts`. Never write `producer | grep -f /dev/stdin`, which reads its patterns from the pipe. Give every search a non-secret control that must be found.
10. **Deploy:** the API image needs `--build-arg MYKEY_BUILD=$(git rev-parse --short=12 HEAD)` or it refuses to start.
11. **Dated items:**
    - R2 fixture guard: `test:cloud` fails on purpose from 15 Nov 2026 09:42 UTC until Run 6.6.
    - Checkpoint `pairs-lock-session-gate`: due from 15 Nov 2026 10:42:20 UTC — **record it at the Session 5 start.**
    - `.trivyignore.images` expires 14 Dec 2026.
    - All KMS certificates expire 12 Dec 2026 (staging seal 10:50 UTC); runbook `kms-and-unseal.md`. Checkpoint `kms-cert-expiry` from 12 Dec 09:57 UTC.
