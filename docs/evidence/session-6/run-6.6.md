# Run 6.6 — Retention, clean-up and cost (D08-S41)

**Date:** 17 Nov 2026. **Branch:** `session-6`. **Decision:** D-53 (retention and clean-up). **Runbook:** `backup.md` (retention).

## What was done

- **Task A — the fixture of Run 1.9 is finished, and the dated guard is gone.**
  - `infra/backup/retention-fixture/cleanup.ts` ran once.
    - It downloaded `pairs/pair-20261111-1`; the bundle's digest equals its manifest.
    - `restic check --read-data` passed with the fixture's password.
    - The restore gave back the three synthetic files (two of 1 MiB; `globals.sql` equal to the builder's text).
    - Then it deleted all 10 objects of `mykey-retention-fixture` with the verified bulk delete: 10 deleted, 0 refused, 0 still present by `HEAD`.
    - Checkpoint `run-6.6-cleanup-and-restore` of `retention-fixture.json` is `observed`, with the outcome per object, and the fixture records no object.
  - `fixture.cloud.test.ts` no longer depends on the fixture.
    - Each run makes its own object under `probe/run-<epochMs>-<hex>/`, locked 600 s.
    - The refusals are as before: overwrite 409, delete 409, bulk delete HTTP 200 with a per-object error.
    - The objects of a run at least eleven minutes earlier are found by listing, deleted and proven gone. Each run appends to `run-6.6-lock-expiry.json`.
- **Task B — the retention job.**
  - `planRetention` (pure, `@mykey/backup`).
  - `applyRetention` (`@mykey/operations/operator`).
  - `ops pair --step retention [--delete-orphans <prefix>]`.
  - The job `pair-retention`: the cleanup token, no signer.
  - The unit `mykey-pair-retention` (05:00 UTC).
  - `host.ts <host> r2-install pairs-cleanup`.
  - `keyReadable`, with the KMS state probe `kmsKeyStateCommand` / `kmsKeyState`.
  - New repo functions `listPairs` and `closePair`.
  - `OpsEnv.pairs.signing` is optional.
- **On staging:** the ops image `b5ca9283e843`, `push`, `r2-install pairs-cleanup` and `timers`. The unit run by hand: `retention staging: nothing to delete (4 kept)`, result `success`; next run 18 Nov 2026 05:00 UTC.
- **Task C — cost and the 30-day checkpoint.**
  - `cost-sheet.md` gains the used staging pair, the audit archive per day and the projection for one host.
  - `pair-30-day.staging.test.ts` is registered as a dated checkpoint, from 17 Dec 2026 19:00 UTC.

## Commits

- `04e429c` test(cloud): the retention fixture is restored, cleaned up and no longer dated
- `b5ca928` feat(ops): retention deletes verified, in order, never the last pair
- this note's commit: cost sheet, the 30-day checkpoint, D-53, runbook, registry

## Commands and results

- **Unit:**
  - `tests/unit/backup/retention.test.ts`: 14/14. It failed first (`planRetention is not a function`).
  - `tests/unit/hosts/units.test.ts`: 7/7. It failed first: three tests without the job, the token and the unit.
  - `tests/unit/hosts/deploy.test.ts`: 28/28. The KMS state test failed first.
  - `tests/unit/ops/host-env.test.ts`: 3/3. It failed against the old `host-env.ts`.
  - The touched unit directories (`ops`, `hosts`, `backup`, `audit`): 304/304.
- **Integration:**
  - `tests/integration/capture/retention.test.ts`: 7/7, after failing first (`applyRetention is not a function`).
    - `eligible.json` goes first. When `bundle.tar` is refused, the row is `expired` and the refusal recorded; the next run deletes only the bundle.
    - A refused `eligible.json` leaves the row and the bundle untouched.
    - A delete that claims a key still there: `stillPresent`, exit 1, row untouched.
    - `system.backup_cleanup`: `{deleted: 2, kept: 2, refused: 0}`, then `{0, 2, 0}` with "nothing to delete".
    - Stale uploads aborted under `pairs/<host>/`.
    - A candidate past two hours becomes `ineligible` (`deadline`).
    - The newest eligible pair stays when every pair is expired.
  - `tests/integration/capture/pair.test.ts`: 6/6 (the signing path touched).
- **Cloud (`pnpm run test:cloud`, three files):**

  | Start (UTC) | Result  | Notes                                                                                                                                                                                                                                                 |
  | ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 17:16       | 13 / 14 | Run 6.2's `segment.cloud.test.ts` hit vitest's default 5 s (5,017 ms beside two other files). It got the 60 s of the other cloud tests. The probe run of 17:04 (12 min old) was deleted.                                                              |
  | 17:26       | 14 / 14 |                                                                                                                                                                                                                                                       |
  | 17:36       | 14 / 14 | `applyRetention` with the real store deleted the 20-minute-old `ret-` prefix of 17:16 (2 objects, proven gone). This run's own prefix was refused `ObjectLockedByBucketPolicy`, reported, not thrown. The 17:16 probe run was deleted (20 min).       |
  | 17:47       | 14 / 14 | Eleven minutes after the 17:36 run. `applyRetention` deleted the `ret-` prefixes of 17:26 (21 min) and 17:36 (11 min), 2 objects each, proven gone; the probe runs of 17:26 and 17:36 were deleted. Two green runs eleven minutes apart: Task A done. |

- **Staging:**
  - `backup.staging.test.ts --testNamePattern=keyReadable`: 1/1 (`run-6.6-key-readable.json`). The destroyed loss-test key `436f2b46-…` of Run 2.7 is false (`State` `Destroyed`); staging's seal key `5ec11f05-…` is true (`Active`).
  - The retention unit ran, with the outcome above.
- `pnpm run check`: green.

## Deviations and decisions

- **The plan's interface is wider by four fields** (rulings in the ledger):
  - A delete entry carries its keys (`{ pair, keys }`), so a pair whose bundle was refused is retried for the bundle alone.
  - `keep` has a fourth reason, `locked`, for ineligible or expired pairs inside the lock.
  - A plan has `expire`, the candidates past their deadline.
  - `CleanupResult` adds `expired` and `closed`.
- **Placement.** `applyRetention` lives in `@mykey/operations` (database, audit), which now depends on `@mykey/backup`. The pure planner and `keyReadable` live in `@mykey/backup`.
- **The release point is capture + 30 days + 2 hours**, the latest a lock can end: the upload comes within the two-hour deadline.
- **The cleanup event keeps Run 6.1's schema** (deleted, kept, refused); a still-present key counts as refused.
- **The retention job has its own token** (`mykey-<host>-pairs-cleanup`) and no signing key; `MYKEY_PAIR_RETENTION=yes` selects it.
- **The 30-day checkpoint opens on 17 Dec 2026 at 19:00 UTC, not 18 Dec.** The first staging pair's lock ends on 17 Dec at 18:38, and the 05:00 timer of 18 Dec would delete it before an 18 Dec checkpoint could restore it. If the timer was first, the test proves its deletion and restores the next pair.
- **The checkpoint restores to the artifacts' digests on the workstation, not into scratch instances.** The restore tooling into new stores is Run 6.7's; the checkpoint can use it by then.
- **Cloud evidence by file, not console.** Vitest shows no console output of passed tests here, so the expiry runs append to `run-6.6-lock-expiry.json` and `run-6.6-retention-cloud.json`.
- **`cleanup.cloud.test.ts` rewrites `run-6.5-pair-cloud.json` on every run** (Run 6.5's test). It was restored before each commit.

## Registry

- FR-1.78 SPIKE_PASS
- AC-1.36 SPIKE_PASS
- PO-9 SPIKE_PASS
- R2-L1 SPIKE_PASS
- COST-B1 SPIKE_PASS

## Open issues

- **Checkpoint `pair-30-day`**, from 17 Dec 2026 19:00 UTC, before the 05:00 timer of 18 Dec.
- **No invoice figure** for COST-B1 until a whole month of daily pairs is billed (December 2026).
- **Production** has no retention job yet. At the gate, with the owner's permission: the ops image, `r2-install pairs-cleanup`, `timers`.
- **Run 6.5's cloud test rewrites its evidence file on every run.** It should write a file of its own run or append, as the Run 6.6 tests do (deferred minor).
