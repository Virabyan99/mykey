# Run 4.5 — Uncertainty and reconciliation

**Result: DONE on 14 Nov 2026.**

- **Stuck operations.** An operation stuck after its dispatch marker becomes `uncertain` within a sweep; one stuck before the marker becomes `rejected`.
- **The alert.** Every unresolved operation raises `operations_unresolved`.
- **Settlement.**
  - A write that landed is settled as success without any exclusion.
  - A write that did not land is called rejected only after the operator has excluded the executors.
  - A delete or undelete is always settled under exclusion.
- **Environments.** An environment's index can be rebuilt from OpenBao, and that is the only way out of an environment review.

FR-1.30 SPIKE_PASS — product code, real stores: the sweep, two sweepers, a swept executor that can neither finalize nor dispatch (`tests/integration/reconcile/sweep.test.ts`, 7).
FR-1.31 SPIKE_PASS — product code, real stores, and the staging drill: verdicts for landed and not-landed writes, deletes and undeletes, evidence conflict, closed unknown (`operation.test.ts`, 12; `tests/staging/reconcile.staging.test.ts`).
FR-1.88 SPIKE_PASS — product code, real stores: reconcile-environment after drift and after damage, refusals, 300 names (`environment.test.ts`, 5; `ops.test.ts`, 4).
AC-1.16 SPIKE_PASS — local stack and staging: a timeout after a real backend change gives `uncertain` with its operation id, the slot held, the alert, and the operator's settlement.

## What was done

- **The sweep** (`@mykey/operations` root, `sweepStaleOperations`), and its timer in the API (`operation-sweep.ts`, every 30 s plus up to 5 s of jitter). One conditional update per rule; each clears `executor_boot_id`.
  - When `claimDispatch` fails, the protocol answers from the row the sweep wrote, as a replay would.
- **The alert path.**
  - `listUnresolved` in `@mykey/db`.
  - `status.sh` reports `operationsUnresolved` with the same predicate; a test extracts the statement from `status.sh` and compares the counts.
  - The heartbeat carries the field.
  - The probe's `operations_unresolved` condition and `parseHostStatus`.
- **Reconciliation** (`@mykey/operations/operator`): `reconcileOperation`, `reconcileEnvironment`, `rebuildKey`.
- **Repository functions** `settleOperation`, `recomputeCounters`, `deleteIndexRow`, `indexNames`.
- **Commands** `ops operations`, `ops reconcile-operation`, `ops reconcile-environment`, and `host.ts quiesce|resume` (staging only).
- **Documents.** Runbook `reconciliation.md`. `provisioning.md` loses the superuser instruction, and `probe.md` gains the row. D-38.
- **The harness.** The TLS relay gained `swallowRequests`, which makes a change that never reaches OpenBao. A request delayed with `delayRequests` still lands after the client gives up, so a delay cannot make a not-landed change.
- **Carried provisioner minors.**
  - The environment job's `kv-scope` step compares all three KV fields.
  - The organization sweep's `delete_version_after` case and the "denied ends the job" case are isolated in their own tests.

## Commands and results

| Command                                                                                                                                         | Result                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI 43497294096 (Run 4.3 head)                                                                                                                   | red: `projects.test.ts` rename and `drift.test.ts` still used `secrets.list` as a route without a handler → `cc0d8df`; CI 43501168992 green                                              |
| `sweep.test.ts` before the code                                                                                                                 | 7 failed (RED: `sweepStaleOperations is not a function`)                                                                                                                                 |
| the same after                                                                                                                                  | 6 passed, 1 failed in the test (the status.sh statement names its column `count`) → 7 passed                                                                                             |
| probe `evaluate`/`auth`, `hosts/status` before / after                                                                                          | 4 failed (RED) / 32 passed                                                                                                                                                               |
| `operation-sweep.test.ts` (the timer) before / after                                                                                            | 2 failed / 2 passed                                                                                                                                                                      |
| `operation`, `environment`, `ops` reconcile tests before the code                                                                               | 21 failed (RED: the functions and commands are missing; cascades of slots left held)                                                                                                     |
| the same after                                                                                                                                  | 21 passed                                                                                                                                                                                |
| `host-cli.test.ts` quiesce/resume before / after                                                                                                | 2 failed / 53 passed                                                                                                                                                                     |
| provisioning `kv-scope compares all three fields` before the fix                                                                                | failed (the environment ended `active`)                                                                                                                                                  |
| `denied ends the job` (retry_count 0), the organization sweep's `delete_version_after` case                                                     | passed **at once**: the code already did this; the minors asked for isolation                                                                                                            |
| `provisioning/{environment,drift}.test.ts` after the fix                                                                                        | 20 passed                                                                                                                                                                                |
| `secrets/protocol`, `secrets/update` after the protocol change                                                                                  | 23 passed                                                                                                                                                                                |
| unit suite                                                                                                                                      | 57 files, 859 passed                                                                                                                                                                     |
| `pnpm run check`                                                                                                                                | exit 0                                                                                                                                                                                   |
| staging: `push`, `image api` (`e5be96fe0a29`, `sha256:9394268a…`), `image provisioner` (`sha256:855f83dd…`), `db-init`, `up`; `probe.ts deploy` | applied nothing; gate stayed open (epoch 140); `operationsUnresolved: 0`                                                                                                                 |
| `vitest --project staging tests/staging/secrets.staging.test.ts`                                                                                | first run: my test sent `confirmed` with an update (400) → corrected; then 4 passed (list with a prefix, history, reveal, delete, undelete, restore, the operation's status, one replay) |
| `vitest --project staging tests/staging/reconcile.staging.test.ts`                                                                              | 1 passed (`run-4.5-drill.json`)                                                                                                                                                          |
| `host.ts staging status`, `probe.ts state staging` afterwards                                                                                   | gate open, `reviewOpen: 0`, `operationsUnresolved: 0`, provisioner healthy, unsealed; no open alert                                                                                      |

**The staging drill** (13 Nov 2026, UTC; project `s4-drill-3fe496`, `1d55c1b0-3451-4ea2-8a6a-64dde1a04c13`, environment `6a620f19-d1ee-4e40-acd1-1971313ed1e3`):

| Time     | What happened                                                                                                                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 21:17:29 | OpenBao paused for 8 s while twelve delete/undelete loops ran. Answers: 83 × 200, 11 × `503 busy`, 1 × `503 outcome_unknown` (operation `4e612eff-6477-468b-97b2-97a942c71c23`, key `S4_DRILL_94ADB7D7`). Caught on the first attempt. |
| 21:17:40 | Reveal of that key and a create in the environment: `409 key_under_review` (the create names the operation). Reveal of another key: 200. The operation's status: `uncertain`.                                                          |
| 21:18:27 | The probe delivered `operations_unresolved` (its `lastAlertAt`: the time the Telegram message went out).                                                                                                                               |
| —        | `ops reconcile-operation` without exclusion: exit 3, `executors_not_excluded`.                                                                                                                                                         |
| 21:19:16 | `quiesce` done (`executors: stopped`). With `--executors-excluded yes`: exit 0, **`rejected`** (the delete never landed).                                                                                                              |
| 21:20:09 | `resume`, `gate open`. The key changed again with its new tag (200).                                                                                                                                                                   |
| 21:20:30 | `operations_unresolved` resolved. `status`: `operationsUnresolved: 0`, `reviewOpen: 0`, gate open.                                                                                                                                     |

**Alert window:** 21:17:29–21:20:30 UTC. `/health` was down from the quiesce to the resume (under a minute), inside the probe's 3-minute grace, so `health_failing` never opened. An earlier window (deploy, 21:10) passed without an alert.

**Staging projects of this run:** `s4-0af987c7` (`7597657c-1cb6-410f-b7d2-3f076afaa5e9`, environment `1ebe3fc6-0096-43e3-8bb8-2842a5f86580`; `run-4.5-staging.json`). Fifty sequential updates: median 658 ms, slowest 1,113 ms.

## Deviations and decisions

- **The drill's uncertainty.** The plan paused OpenBao and then sent an update. The update's pre-read fails before the marker, so it answers `dependency_unavailable`, never `outcome_unknown`. An update caught mid-flight usually lands late and is settled without exclusion.
  - So the drill pauses OpenBao during delete/undelete loops. A delete or undelete caught after its marker always needs exclusion, and that path (exit 3, quiesce, exit 0) is what the drill is for.
  - Up to three attempts were allowed; the first caught one.
- **Verdict on staging** was `rejected`: the paused OpenBao never ran the delete.
- **The drift test of environment reconciliation** restores the runtime policy itself. The provisioner's sweep marks review and repairs nothing.
- **`rebuildKey`** keeps the tag of a row that already matches the backend (the plan said "a fresh tag"). A matching row was never wrong, and a new tag would refuse its clients for nothing. D-38 records it.
- **Version events** are recorded for every succeeded verdict, deletes and undeletes included, as the protocol's own finalize does (the plan said "for a write found").
- **"Two processes sweep at once"** is proven with two `api_runtime` pools in one process. The sweep is plain SQL, and the row lock decides.
- **The timer** got a unit test of its own (not in the plan).
- **`quiesce`/`resume`** are staging only: production has no OpenBao in this stage.

## Open issues

- The runbook's step 4 (an evidence conflict) asks the operator to read versions with the root token. There is no command for that yet.
- An uncertain import child (Run 4.7) needs the parent rule that this run left out.
