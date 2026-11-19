# Run 6.5 — Daily paired backup (D08-S41)

**Date:** 17 Nov 2026. **Branch:** `session-6`. **Decisions:** D-51 (the capture barrier), D-52 (the pair: format, verification, signature, custody). **Runbook:** `backup.md`.

## What was done

- **Task A — writing is closed while a pair is captured** (migration `0017`, D-51).
  - `app.service_control` is changed by `maintenance` only.
  - A statement trigger `capture_barrier` on every table of `app` and `auth` but four raises `MKC01` while capturing.
  - Admission (`captureStep` and the auth middleware) answers `503 busy` to writes while not idle. Reads, reveals, exports, machine resolves and the access reductions stay open.
  - The reductions record an invalidation through `app.capture_invalidate`; that row is their pass through the trigger.
  - The provisioner, the operation sweep, the outbox dispatcher and the session clean-up wait.
  - The six inline checks of the spike are gone.
- **Task B — the coordinator** (`ops capture --step begin|record|abort`).
  - The drain lasts at most 30 s, for executing operations and held slots.
  - The boundary is read again inside the change to capturing.
  - Record writes the candidate, its audit row and idle in one commit.
  - Abort releases only its owner's freeze and empties the pair's scratch.
- **Task C — the pair.**
  - `@mykey/backup` gains the manifest (`mykey-pair/1`), the eligibility record, canonical JSON and the Ed25519 signature, and the trust anchor.
  - `infra/hosts/backup/steps.ts` renders `backup.sh`.
  - `ops pair --step manifest|upload|verify`, with `settlePair` deciding deadline, access reduction or eligible.
  - New ops jobs `capture` and `pair`; units `mykey-backup` (03:00 UTC) and `mykey-capture-recover`.
  - New `host.ts` commands: `backup-init`, `backup-custody`, `r2-install pairs`.
  - The spike (`infra/backup/pair-spike/`, `pair.staging.test.ts`) is deleted.
- **Task D — on staging.**
  - API, provisioner and ops at `67f2c490dc85`, with migration `0017` applied.
  - `backup-init`: the keys were made on the host and the trust anchor `infra/hosts/backup/trust/staging-k1.pub` was committed.
  - The 27 spike objects were deleted from `mykey-staging-pairs`, then the lock rule `pairs-30d` was set on `pairs/`.
  - Then `r2-install pairs`, `timers` (backup timer, boot recovery, `MYKEY_BACKUP_EXPECTED=yes`) and `backup-custody`.
  - The heartbeat now reports `checks.backup: expected, newest eligible 2026-11-17T16:51:22.500Z`. This completes the `backup_stale` line of Run 6.4 with a real pair rather than the drill hook.

## Commits

- `fddf49c` feat(db): writing is closed by a trigger while a pair is captured
- `688c88e` docs: the full integration suite runs at the gate only (owner's rule)
- `75c6030` feat(ops): the capture coordinator drains, freezes, records, releases
- `67f2c49` feat(backup): a signed, verified pair as one locked object
- `66941ca` fix(hosts): the daily pair runs on staging
- this note's commit: docs, D-52, runbooks, registry

## Commands and results

- **Barrier** (`tests/integration/capture/barrier.test.ts`): 16/16. The whole integration suite ran once for Task A: 1292 passed. Three failures were fixed and rerun green (161/161): the id-column count, the `status.sh` statement moved by Run 6.4, and the spike rehearsal (removed). The exclusion fault test timed out under load and passes alone, 4/4.
- **Coordinator** 9/9. The gap race, a writer committing while the change to capturing waits, fails on the first coordinator and passes on the fix.
- **Crash** 4/4: killed in draining, in capturing and after the artifacts. The recover command releases, writing resumes, the pair is ineligible and the scratch is empty.
- **Compete** (`tests/fault/capture/compete.test.ts`): 40 captures under eight workers in 652 s.

  | Outcome                     | Count |
  | --------------------------- | ----- |
  | Eligible, restored whole    | 20    |
  | Crossed, `access_reduction` | 20    |
  | Busy                        | 0     |

  Freeze: **median 2,799 ms, worst 3,717 ms**. The slowest restore check took 17 s, at 323 tokens.

- **Scratch OpenBao** (`scratch.test.ts`) 1/1: two snapshot restores in a row.
- **Pair** (`tests/integration/capture/pair.test.ts`) 6/6:
  - eligible, with `eligible_until` = capture + 30 days and `system.backup_eligible`;
  - a changed read-back stays a candidate, exit 1;
  - a failing `restic check` stays a candidate;
  - a crossed window is ineligible;
  - two hours and one second after the capture it is ineligible (`deadline`);
  - `markEligible` is refused for an ineligible pair.
- **Units:** backup and hosts, 259/259.
- **Cloud** (`tests/restore/retention/cleanup.cloud.test.ts`) 1/1: a real bundle of the empty local stack went through `mykey-staging-pairs-upload` (`run-6.5-pair-cloud.json`). It was 155,136 bytes, the upload took 803 ms, the read-back was equal and the probe object was deleted.
- **Staging** (`tests/staging/backup.staging.test.ts`) 5/5 in 166 s (`run-6.5-backup-staging.json`):
  - The unit's capture is eligible, its two objects exist and `eligible.json` verifies against `staging-k1.pub`.
  - **Freeze 8,959 ms.** 10 of 17 writes answered `503 busy` over 7.4 s, and the last succeeded. All 4 reveals: 200.
  - Five credentials revoked during a second capture are all `revoked`. That pair is `ineligible` (`access_reduction`) and the unit succeeded.
  - The bundle (48.3 MB of artifacts) restored on the workstation with the custody password. Its three digests equal the manifest's.
  - The largest object under `pairs/` is 44 MB, under 5 GiB.
  - The password, the signing key and the R2 secret were found 0 times in the unit files, the unit's journal and a process list sampled every 200 ms during a capture. All controls were found.
- **Eligible pairs on staging made by the unit:** `1591f04a-…` (first run by hand through `systemctl start`), `c568b60e-…` and the one of the secret search. The timer's own first run is the checkpoint `backup-first-night` (18 Nov 2026 03:30 UTC, `tests/staging/backup-night.staging.test.ts`).
- `pnpm run check`: green.

## Deviations and decisions

- **Rulings** are in the ledger. In short:
  - The reduction's pass is a row only the definer function writes.
  - One invalidation row per writing transaction.
  - The drain counts executing operations and slots, not accepted ones. Counting accepted ones deadlocked against the provisioner, which defers its jobs while not idle.
  - The boundary is reread inside the change to capturing.
  - The pair tmpfs is `/var/lib/mykey/pairs` (the job table mounts only `/var/lib/mykey`).
  - `ops pair` has a third step, `manifest`.
  - Verify trusts Restic's own check output and also compares the restored digests.
  - `eligible.json` is written inside the transaction that makes the pair eligible.
  - A crossed pair exits 0; a missed deadline or a failed verification exits 1.
  - One upload token per host does both upload and read-back.
- **The spike's AppRole.** The root AppRole `backup` left by Run 2.9 gave secret ids 60 s. The product's single installed secret id stopped working a minute after `backup-init`. `putAppRole` gains an optional `secret_id_ttl`, and `backup-init` sets it to none.
- **27 spike objects, not 11.** Later staging spike runs had added 16. All were spike-format and unlocked, and all were deleted before the rule.
- **Compete took six attempts.**
  - The scratch OpenBao sealed itself: a restored snapshot brings the source's audit device, so it got a writable audit tmpfs.
  - The coordinator gap: a real bug, fixed.
  - The `accepted` deadlock: my own change, reverted.
  - A harness write of `auth.session` during a capture.
  - The restore check growing as environments × tokens: one lookup per token now.
  - One memory kill of the session.
- **Owner's rule (17 Nov 2026):** the full integration suite runs at the gate only (`CLAUDE.md`).

## Registry

- FR-1.66 SPIKE_PASS
- AC-1.27 SPIKE_PASS
- PO-13 SPIKE_PASS (keeps the status; the product's pair on staging is new evidence)
- PO-21 SPIKE_PASS (keeps the status; the bucket holds Restic ciphertext and signed records only, and the product's `eligible.json` verifies against the committed key)

## Open issues

- **Custody (OWN-4).** The owner's offline copy of `~/.mykey/custody/staging/backup/` is not confirmed yet (`owner-requests.md` §3).
- **Checkpoint `backup-first-night`.** Due 18 Nov 2026 03:30 UTC: the timer's own 03:00 run and the heartbeat's newest eligible capture.
- **The AppRole `backup` secret id** on the host has no expiry and is not bound to an address. It is root-only and its tokens carry the `backup` policy only. Rotating it is `backup-init`. For the Session 8 review.
- **Why the first secret id vanished** is explained (60 s TTL) but was found only on staging. No local test covers the role's settings.
- **Production** has none of this. It gets it at the gate with the owner's permission (`backup-init`, custody, `r2-install pairs`, `timers`).
- **Run 6.7:** a restored database carries `capture_mode = capturing`, and the restore must set it to `idle`.
