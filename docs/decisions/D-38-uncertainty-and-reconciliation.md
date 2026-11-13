# D-38 — Uncertainty and reconciliation

**Date:** 2026-11-14

**Status:** DECIDED in the Session 4 plan (P-69, P-75), recorded by the executing agent in Run 4.5. Evidence: `tests/integration/reconcile/{sweep,operation,environment,ops}.test.ts`, `docs/evidence/session-4/run-4.5.md`. Runbook: `docs/runbooks/reconciliation.md`.

## The sweep

- **Where.** In every API process, every 30 s plus up to 5 s of jitter. It touches PostgreSQL only, so it runs while OpenBao is away.
- **What.** Two conditional updates, each clearing `executor_boot_id`:
  - A secret operation still `executing` with a heartbeat older than 120 s becomes `uncertain`. Its key goes to review, its slot stays held, and `system.operation_stuck` (outcome `unknown`) is audited.
  - One still `accepted` becomes `rejected` with `dependency_unavailable`, and its slot is released. No dispatch marker was written, so nothing was sent.
- **Two sweepers.** The row lock decides; each operation gets exactly one audit row.
- **The late executor.** Its `finishOperation` and `claimDispatch` find no row they own:
  - After the marker, it answers `503 outcome_unknown` and changes nothing.
  - Before the marker, the protocol reads the row and answers what the sweep wrote (`503 dependency_unavailable` with the operation id).

## Unresolved

An operation is **unresolved** when it is `uncertain` with `completed_at` NULL, or `accepted`/`executing` with a heartbeat older than 120 s. `listUnresolved` and `status.sh` (`operationsUnresolved`) use the same predicate. The probe's `operations_unresolved` opens on any count above 0, with no grace. So no uncertain case stays without an alert.

## Verdicts (`reconcileOperation`)

- **A write proves itself.** A version above the starting one whose envelope carries the operation id is `succeeded`, with or without executor exclusion: a write cannot land twice. With no such version:
  - without exclusion → `undetermined: executors_not_excluded`;
  - with exclusion, if nothing is above the start → `rejected`;
  - with exclusion, if anything else is above it (unreadable, destroyed, someone else's) → `evidence_conflict`.
- **A delete or undelete leaves no mark** (D-20, D-36), so it is judged only after exclusion. If the expected version is current and in the target state → `succeeded`; in the state before → `rejected`; otherwise → `evidence_conflict`.
  - Exclusion is never skipped for these: a delete that looks done could be followed by its late twin after an undelete.
- **Exclusion** is the operator's statement, made after `host.ts <host> quiesce`: gate closed, `api` and `provisioner` stopped, OpenBao restarted so that it holds no request.
- **`closeUnknown`** (only with exclusion, only for `evidence_conflict`) leaves the operation `uncertain` for ever with `completed_at` set. Its replay keeps answering `outcome_unknown` (rule 11), and it frees the environment.
- **A rejected verdict** stores `dependency_unavailable`.
- **A stale row first.** A stale `executing` or `accepted` row is first moved by the sweep's rule.
- **Finished rows.** An operation that is not unresolved is `not_unresolved` and nothing changes, so a second run is harmless.

## Settlement

One transaction as `maintenance`, holding the environment's advisory lock on its connection:

- the operation settled (only from unresolved);
- the key rebuilt from OpenBao;
- `live_value_bytes` summed again over live rows, and the generation increased by one;
- a version event for a change that happened, with the original principal and action (also for a delete or undelete, as the protocol's own finalize records one);
- the step's outcome;
- the slot released;
- `operator.reconcile_operation` `{ name, verdict, executorsExcluded }`.

A succeeded operation's result has the protocol's shape, so the original key replays it.

## Rebuilding a key

The row is rebuilt from `kvMetadata`:

- **No metadata** → the row is removed.
- **Otherwise** the row gets the current version, its state (deleted when the version is deleted or destroyed), and a fresh tag.
- **Byte length.** A live version is read once for its length; the value is dropped at once. A deleted version keeps the row's length when the version is unchanged. Otherwise it takes the largest value length, and the next undelete writes the true length.
- **A row that already matches** the backend keeps its tag, so a client holding it is not refused for nothing (a ruling of Run 4.5).

## Rebuilding an environment

- **Preconditions.** The environment's lock (2 s, else `busy`). It is refused while an operation of the environment is unresolved or its slot is held. That lock and the empty slot are the proof that no change is in flight, so no exclusion is needed.
- **The rebuild.** Every name of `kvList` (valid names only) and of the index is rebuilt. Then the counters are summed again and the generation increases by one.
- **The state.** A `needs_review` environment whose KV is ready becomes `active`. This is the only way out of an environment review: never the superuser.
- **Audit.** `operator.reconcile_environment` `{ names, changed }`.

## Not decided here

- The rule for import parents (`awaiting_input`) is Run 4.7's.
- The provisioner's drift sweep marks review and repairs nothing. Fixing the cause stays with the operator (`verify-organization`, the root token).
