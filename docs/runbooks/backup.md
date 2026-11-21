# Runbook — the daily pair (backup)

Run 6.5 (D-51, D-52). How a host backs itself up every night, how to read a failed run, and what a restore needs.

## What runs when

| Unit                                      | When                                | What                                                                                                       |
| ----------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `mykey-backup.timer` → `.service`         | 03:00 UTC (catches up after a boot) | `/opt/mykey/hosts/backup/backup.sh`: capture, pack, upload, verify, sign. At most 2 h (`TimeoutStartSec`). |
| `mykey-backup.service` `ExecStopPost`     | after every run                     | `backup.sh recover`                                                                                        |
| `mykey-capture-recover.service`           | at boot                             | `backup.sh recover`: releases a freeze a crash left and removes any pair tmpfs                             |
| `mykey-pair-retention.timer` → `.service` | 05:00 UTC                           | `ops pair --step retention`: deletes expired pairs, never the newest eligible one (Run 6.6, D-53)          |

One run:

1. `ops capture --step begin`. The coordinator drains for at most 30 s, waiting for running operations and held effect slots, then closes writing (D-51). Exit 75 means busy: another capture runs, or the drain did not finish. The timer tries again the next night; run it by hand if needed.
2. **The frozen part, at most 120 s.** A watchdog aborts the capture after that. It takes `postgres.dump`, `globals.sql` and `openbao.snap` into the tmpfs `/var/lib/mykey/pairs/<pairId>` (1 GiB, RAM only).
3. `ops pair --step manifest`, then `ops capture --step record`. The pair becomes a `candidate` and **writing reopens**. On staging the freeze measured 9.0 s (17 Nov 2026).
4. Restic packs `bundle.tar`. `ops pair --step upload` puts it into `mykey-<host>-pairs` and reads it back.
5. `restic check --read-data` and a restore run on the read-back copy. `ops pair --step verify` compares the digests with the manifest, signs, and writes `eligible.json`. The pair is now `eligible` until capture + 30 days.

While writing is closed, writes answer `503 busy` and reads, reveals and exports are served. Sign-out and revocation still work; they make that night's pair `ineligible` (`access_reduction`).

## Reading a failed run

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts staging status          # checks.backup, checks.captureSince, unitsFailed
# on the host:
systemctl status mykey-backup.service
journalctl -u mykey-backup.service --since -1d --no-pager
```

| Journal line                                             | Meaning, what to do                                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `capture: busy (not_idle)` / `(drain_deadline)`, exit 75 | Another capture held the row, or work did not drain in 30 s. Nothing was frozen. Run again later.                           |
| `released <pairId>` then the unit failed                 | A step failed while writing was closed; the trap released it. The pair is `ineligible` (`aborted`). Read the line above it. |
| `curl: (22) … 400` then `… 403`                          | The AppRole `backup` login was refused (secret id gone or expired). Run `host.ts <host> backup-init` again.                 |
| `upload: the bundle read back differs …`                 | The bucket returned other bytes. The pair stays a candidate and becomes `ineligible` (`deadline`) after 2 h.                |
| `verify: restic check --read-data did not pass`          | The read-back copy is damaged. Same as above.                                                                               |
| `ineligible <pairId> (access_reduction)`, unit succeeded | Someone signed out or revoked during the capture. Expected; the next night's pair covers it.                                |
| `ineligible <pairId> (deadline)`                         | Verification came more than 2 h after the capture.                                                                          |

The alerts that cover this: `capture_frozen` (writing closed too long) and `backup_stale` (no eligible pair recently while `MYKEY_BACKUP_EXPECTED=yes`).

## A capture by hand

```sh
# on the host:
sudo systemctl start mykey-backup.service    # waits until it is done; then read the journal
```

Write a staging window (`docs/evidence/session-6/staging-windows.md`) first: writes answer busy for some seconds.

## Install on a host

```sh
node scripts/host.ts <host> push
node scripts/host.ts <host> backup-init       # password and signing key on the host; commit infra/hosts/backup/trust/<host>-k1.pub
node scripts/host.ts <host> backup-custody    # then the owner copies ~/.mykey/custody/<host>/backup/ offline (OWN-4)
node scripts/host.ts <host> r2-install pairs  # mykey-<host>-pairs-upload
node scripts/host.ts <host> timers            # installs mykey-backup.timer and mykey-capture-recover; sets MYKEY_BACKUP_EXPECTED=yes
```

The bucket's lock rule `pairs-30d` is set by `infra/backup/retention-fixture/provision.ts --locks-only`. From then on every object under `pairs/` stays 30 days, test pairs included: no token a host or CI holds can delete it or change the rule. The workstation's `mykey-r2-admin`, which sets the rule, could remove it (D-16).

## Retention (Run 6.6, D-53)

Every morning at 05:00 UTC `mykey-pair-retention` deletes, through `mykey-<host>-pairs-cleanup`:

- eligible pairs older than 30 days;
- ineligible pairs once their lock has ended (capture + 30 days + 2 hours).

It never deletes the newest eligible pair. Per pair it deletes `eligible.json` first and proves it gone, then closes the row (`expired`, `deleted_at`), then deletes `bundle.tar`.

| Journal line                                           | Meaning, what to do                                                                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `retention <host>: nothing to delete (N kept)`         | Normal until pairs are 30 days old.                                                                                           |
| `expired <pairId>`                                     | Its `eligible.json` is gone and the row closed; the bundle follows in the same run or the next.                               |
| `… refused (ObjectLockedByBucketPolicy)`               | The lock still holds; the next run tries again. With `, 3 days after its lock` the unit fails: check the bucket's rule.       |
| `… still present after a delete that answered success` | The unit fails. Read the object with `HEAD`; do not delete the row by hand.                                                   |
| `orphan pairs/<host>/<prefix>/ (not deleted)`          | Objects without a row. Find out where they came from; remove them with `ops pair --step retention --delete-orphans <prefix>`. |

Install on a host: `node scripts/host.ts <host> r2-install pairs-cleanup`, then `timers`.

## Why a pair is ineligible

| Reason             | Cause                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `aborted`          | The capture was released before it was recorded (failure, crash, abort).                              |
| `access_reduction` | A sign-out, session revocation, credential revocation or archive committed inside the capture window. |
| `deadline`         | No verification within 2 h of the capture.                                                            |
| `verification`     | Marked by hand after a failed check.                                                                  |

## What a restore needs (the custody set)

The pairs bucket holds only ciphertext and signed records (the audit archive's segments are audit rows, gzipped, not encrypted). A restore also needs:

- **the backup password** (`~/.mykey/custody/<host>/backup/password` and the owner's offline copy);
- **the trust anchor** `infra/hosts/backup/trust/<host>-<keyId>.pub` in this repository, to verify `eligible.json`;
- **OpenBao's recovery keys** (`~/.mykey/custody/<host>/openbao-init.json`);
- **access to the KMS key** that seals OpenBao (runbook `kms-and-unseal.md`);
- **an R2 read token** for `mykey-<host>-pairs`.

Only a pair with an `eligible.json` that verifies is restored. The restore procedure itself is Run 6.7's runbook. A restored database comes back with writing closed (`capture_mode = capturing`, because the dump was taken then); the restore sets it to `idle`.
