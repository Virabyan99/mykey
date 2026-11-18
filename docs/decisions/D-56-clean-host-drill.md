# D-56 — The restore drill runs on production's lent server, from a stale pair

**Date:** 2026-11-18

**Status:** DECIDED in Run 6.8 (P-125; Doc 10 §7 Run 6.8, OWN-5; AC-1.28, AC-1.43, AC-1.44, PO-22). It records a deviation from OWN-5. Evidence:

- `docs/evidence/session-6/run-6.8.md`, `docs/evidence/session-6/drill.json`;
- `tests/staging/drill.staging.test.ts`, `tests/harness/drill.ts`;
- the unit tests named in the run note (each fix RED → GREEN).

## Context

Doc 10 gives the owner a purchase for the drill (OWN-5: a temporary clean server). Production's VPS is the same plan, in the same region as staging, and held nothing: no OpenBao, no owner, no organization, no open gate (checked first, Task A). The owner does not want to pay for a test.

## Decision

1. **The clean host is production's server, reinstalled.** The owner reinstalls it from the OVHcloud panel before the drill and again at the gate.
   - During the drill it is the host `drill` of `~/.mykey/hosts.json`, with production's addresses. `prod` is marked `lent`, and every command to it is refused.
   - Its name is `mykey-drill.nomikey.com`.
   - Its KMS certificate is issued under staging's KMS domain, because the pair is sealed with staging's key.
   - After the gate's reinstall, production is installed fresh from the release, closed, as it was.
   - **This works only while production holds nothing.** From the day it serves, a drill needs a temporary server again (`known-limits.md`).
2. **The input is a stale pair.** After pair P is captured, staging changes:
   - the owner returns through a reset link, with a new password, a new authenticator and new recovery codes;
   - a session is signed out and one is left live;
   - a machine token is revoked;
   - the admin is removed;
   - a secret is written and a credential is issued.

   No second capture is taken. The restored host must refuse every credential of either side of P.

3. **Staging is declared lost and fenced.**
   - It is declared lost with the gate closed, the executors stopped and the probe entry `inService: false`.
   - `MYKEY_FENCED_HOSTS=staging` then refuses every SSH connection and tunnel to it, including from `host.ts` child processes, until the drill host opens.
4. **Recovery time is measured as the wall time from "declared lost" to "gate open".** `drill.json` also gives the sum of the timed steps of the run that passed, because the drill fixed the restore while it ran.
5. **What the drill host does not do.**
   - It does not take a pair under `pairs/drill/`. A pairs bucket is `mykey-<host>-pairs`, so that would need a fifth bucket, a token, a signing key and lock rules for a host that lives one day.
   - It has no probe entry.
   - Its host jobs fail closed, because the ops image knows `staging` and `prod` only.

   These are open, not proven (`known-limits.md`).

## What the drill found

The restore had been proven locally (Run 6.7) and against a fake shell. On a clean host it met eleven gaps. All are fixed, each with its unit test RED → GREEN, or written into `restore.md`'s "Before":

| Finding                                                                                                                                                 | Fix                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Upstream images (postgres, openbao, traefik) and the restic image are not on a clean host; its egress reaches the registry only in a maintenance window | `restore.md`: pulls by digest under `maint`                                             |
| okms was never installed (the pair's seal-key check needs it)                                                                                           | `restore.md`: `kms-install`                                                             |
| No Restic password of the source on the target; the install makes the host's own                                                                        | the restore installs the source's from custody; the host's own is kept, once, beside it |
| restic restores as uid 1000 into a directory unpacked by root                                                                                           | `chown` after the unpack                                                                |
| `compose start` reused containers that had the old incarnation and host instance id; the API refused to start                                           | step 7 recreates api and provisioner                                                    |
| A clean host serves no organization, so no runtime credential and no `organization-id` were delivered                                                   | `restore --organization <id>`; the delivery includes `organization-id`                  |
| A second run of the same pair sent the snapshot with a token the first run's snapshot had replaced                                                      | the restore's own root token while one waits; `ops` likewise                            |
| A long `observed` text (16 organizations) made the report impossible to write                                                                           | clipped to the schema's 2000 characters; a journey that throws says what it threw       |
| `restore-verify --journey` on a host did not exist                                                                                                      | built (staging and the drill only; never production)                                    |
| A new host measures `bao-audit/rotated` only after the first rotation (01:15 UTC), so every expanding change answered 503 until then                    | `timers` creates the directory                                                          |
| The host jobs kept the old `maintenance` and `backup_reader` passwords after a restore                                                                  | the restore installs the new ones there too                                             |

The data also held something: pair P contains 16 organizations from Session 2's spikes, with no member and no OpenBao namespace. `catalog_matches_backend` refused them. On the drill host they were marked `needs_review` (`namespace_missing`), and `drill.json` counts them. Staging still holds them (an owner decision at the gate).

## Consequences

- `restore.md`'s "Before" is the full list for a clean host. `--journey` and `--organization` are documented.
- The restore is now proven end to end on a reinstalled VPS, from R2 and the custody set alone: the reveals, the refused credentials and the audit order.
- `reconcile-credentials` per environment costs about 19 s each (84 environments: 27 min), the largest part of the recovery time (`known-limits.md`).
