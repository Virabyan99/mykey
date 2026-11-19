# D-53 — Retention and clean-up of pairs

**Date:** 2026-11-17

**Status:** DECIDED in Run 6.6 (P-121; Doc 06 §11, §13; FR-1.78; AC-1.36 per D-04; PO-9; R2-L1; COST-B1). Evidence:

- `docs/evidence/session-6/run-6.6.md`;
- `tests/unit/backup/retention.test.ts`, `tests/integration/capture/retention.test.ts`;
- `tests/restore/retention/{fixture,cleanup}.cloud.test.ts`;
- the checkpoint `pair-30-day` (`tests/staging/checkpoints/pair-30-day.staging.test.ts`, from 17 Dec 2026 19:00 UTC).

## Decision

### What is kept

`planRetention` (pure, `@mykey/backup`) decides per host. It reads the rows and the bucket listing and decides as follows.

| Pair                                                         | Outcome                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| The host's newest eligible pair                              | Kept, even when expired and even when it is the only pair |
| Eligible, inside its 30 days                                 | Kept (`not_expired`)                                      |
| Candidate inside its two hours                               | Kept (`candidate_in_deadline`)                            |
| Candidate past its two hours                                 | Made ineligible (`deadline`) first                        |
| Ineligible, or expired eligible, while the bucket lock holds | Kept (`locked`)                                           |
| Ineligible, or expired eligible, after the lock              | Deleted                                                   |
| A closed row whose objects are still there                   | Its remaining objects are deleted again                   |
| An object prefix without a row                               | An orphan: reported, never deleted by the job             |

The lock ends at capture + 30 days + 2 hours at the latest: the upload comes within the two-hour verification deadline, and the bucket rule counts 30 days from the upload. Deleting earlier would only collect refusals.

### In what order

`applyRetention` (`@mykey/operations`) works per pair, in this order:

1. delete `eligible.json`, and prove it gone with a `HEAD`;
2. set the row to `expired` with `deleted_at`;
3. delete `bundle.tar`, and prove it gone.

From step 1 the pair no longer exists for a restore (D-52). A crash between steps leaves a bundle without a record, which the next run deletes.

A refusal stops that pair where it is, and so does a delete that answers success for a key still there. Bulk deletes are never trusted by their status (R2 answers 200 with errors per object). One `system.backup_cleanup` row carries the counts: deleted, kept, refused (still-present keys included). Multipart uploads older than a day under `pairs/<host>/` are aborted.

### How it runs

- **The job:** `ops pair --step retention` as the job `pair-retention`, with its own token `mykey-<host>-pairs-cleanup` and no signing key (`MYKEY_PAIR_RETENTION=yes`).
- **The schedule:** `mykey-pair-retention.timer` runs it at 05:00 UTC, after the night's pair.
- **Exit 1:** for a key still present after a successful delete, or for a refusal more than three days after the pair's lock should have ended. The unit failure raises `unit_failed`.
- **Orphans:** removed only by hand, `ops pair --step retention --delete-orphans <prefix>`, and only a prefix the plan reports as an orphan.

### KMS keys

`keyReadable(kmsKeyId, probe)` answers whether a pair's KMS key is usable. The probe reads the key's `State` through okms (`kmsKeyStateCommand`, `kmsKeyState`): only `Active` is readable, and a probe that fails is "not readable". Run 6.7's restore refuses a pair whose key is not readable.

### The fixture of Run 1.9

`infra/backup/retention-fixture/cleanup.ts` ran once and recorded checkpoint 3 of `retention-fixture.json`. It restored the oldest fixture pair, then deleted every fixture object, verified. The bucket and its rules stay.

The cloud tests now make their own objects under `probe/` (locked 600 s) and delete those of a run at least eleven minutes earlier, so no test is dated.

## Alternatives rejected

- **Deleting the bundle first.** A crash would leave `eligible.json` pointing at nothing, and a restore would try a pair that is gone.
- **A lifecycle rule in the bucket.** It would delete the newest pair as readily as any other, and nothing would be recorded in the audit.
- **Deleting orphans automatically.** An orphan may be the only copy of something the rows lost (a restored database older than the bucket). An operator decides.
- **Retention in the backup unit.** A failed capture would then stop the clean-up too, and the clean-up's refusals would mark a good pair's night as failed.
