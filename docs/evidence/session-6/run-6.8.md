# Run 6.8 — The clean-host restore drill (D08-S42)

**Date:** 18 Nov 2026. **Branch:** `session-6`. **Decision:** D-56. **Evidence:** `drill.json` beside this note.

**Runbooks:**

- changed: `restore.md` (the full "Before" for a clean host, `--organization`, `--journey`, the restore's token for `ops`), `kms-and-unseal.md`, `custody-map.md`, `network.md` (Task A).

Staging's pair P was restored on production's server, reinstalled and lent as the host `drill`, from R2 and the custody set alone, while staging was fenced. The drill host opened through a report with all 20 checks `ok`. Every old credential was refused there, and the 50 secrets revealed with their digests. Staging is back in service.

## Timeline (UTC, 18 Nov)

| Time        | What                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 13:2x       | B1: the drill's project, two environments, 50 secrets (run-time canaries, digests kept), two tokens, an admin                    |
| 13:30:20    | B2: pair P `55f15ea7-…` captured by the unit, `eligible`                                                                         |
| 13:3x       | B3: the changes after P (below)                                                                                                  |
| 13:34:29    | B4: **staging declared lost**: gate closed, quiesced, probe `inService: false`; the fence on                                     |
| 13:39–13:43 | C1: release, stack, OpenBao (staging's seal key), database, keys on the clean host                                               |
| 13:58–15:00 | C2/C3, first and second runs: the restore met its gaps (D-56's table); each was fixed with a test and the restore run again      |
| 15:00:42    | C2, third run: steps 1–7, 224 s                                                                                                  |
| 15:04:53    | C3: `verify-organization`, the 16 spike organizations marked for review, `reconcile-credentials` × 84 (27 min), the reset        |
| 15:44:09    | C4: `restore-verify --journey`: 20/20 ok, members 2                                                                              |
| 15:4x       | D: the refusals                                                                                                                  |
| 15:52:49    | C9: a fresh journey and report; **gate open** (`origin.kind: restore`)                                                           |
| 15:53–16:05 | After the opening: the reveals, the old credentials, a new token through `resolve`, `/health`, `status`, the audit order         |
| 16:06–16:13 | E: `drill.json`; staging `resume` and a redeploy of `host-v0.6.1` (gate open); the drill's tokens on staging revoked; probe back |

**Recovery time:**

- **Wall time from "lost" to "gate open":** 8,300 s (2 h 18 min), the fixes made during the drill included.
- **Sum of the timed steps of the run that passed:** 2,545 s (42 min). Of that, 27.7 min is `reconcile-credentials`.

## What was proven

- **The stale pair (AC-1.43).** After P:
  - the owner returned through an operator reset: a new password, a new authenticator, new recovery codes, the link used;
  - one session signed out, one left live;
  - a token revoked, the admin removed, a secret written, a token issued.

  On the drill host after the opening, all nine old credentials answered **401**:

  - tokens: live at P, revoked after P, issued after P;
  - sessions: the owner's at P, the admin's at P, the owner's after P;
  - passwords: the admin's at P, the owner's at P, the owner's after P.

  The secret written after P answers 404.

- **The data (PO-22).**
  - The 50 secrets reveal with their digests.
  - A new token's `resolve` returns the development environment with every digest.
  - The audit table holds `operator.restore_begin`, `restore_invalidate`, `restore_verify`, `gate_open` in that order.
  - The owner reads rows from before P through the audit route.
- **Closed until verified (AC-1.28).** These were refused, and the gate stayed closed:
  - `gate open` without a report;
  - with a report older than 30 minutes;
  - with another incarnation's report;
  - `restore --pair` naming an ineligible pair ("no eligible pair").
- **Off-host material only (AC-1.44).** The clean host was rebuilt from:
  - the release on GitHub;
  - R2 (P picked by listing);
  - the committed trust anchor;
  - the custody copies (OpenBao init, backup password);
  - a KMS certificate under staging's domain.

  Staging was unreachable throughout: `MYKEY_FENCED_HOSTS`, checked in `sshArgs`.

## Fixed in this run (each with its test RED → GREEN)

`fd72194`, `e021d84`, `77bd4ca`, `46d1a7d`, `810261b`, `8a7018e`, `ced1f01`, `9dcea90`, `3f56234`. The full list is D-56's table. In short:

- the fence;
- `deploy --install-only` on a host that never ran `up`;
- `restore-verify --journey` on a host;
- the source's backup password on the target;
- restic's output directory;
- step 7 recreating the executors from the new `host.env`;
- `--organization` and the `organization-id` delivery;
- the restore's own root token for a second run and for `ops`;
- clipped `observed`;
- `timers` creating `bao-audit/rotated`;
- the host jobs' copies of the restored passwords.

## Deviations and rulings

- **The drill used `host-v0.6.1`**, not `host-v0.6.0`: 0.6.0 keeps a destroyed runtime secret id after the restore's rotation (Run 6.9's finding).
- **Step 1 is the whole of `restore.md`'s "Before":**
  - `deploy --install-only`;
  - the upstream, restic and okms installs;
  - `up`, `bao-init`, `db-init`, `keys init`, `timers`, the heartbeat units;
  - `quiesce`.

  C1's 225 s is its second attempt; the pulls and installs between attempts each took under a minute.

- **The restore ran three times for P** (D-56). `drill.json` times the third and lists the first two.
- **The spike leftovers.** Pair P holds Session 2's 16 spike organizations (no member, no namespace) and 28 environments. On the drill host they were marked `needs_review` / `namespace_missing` before the report. Staging still holds them: an owner decision at the gate (marking them there opens `review_open`).
- **Admin removal by SQL.** The admin was removed by SQL on staging: there is no member route before Session 7.
- **Not proven on the drill host:**
  - a pair under `pairs/drill/` (a fifth bucket, token, signing key and lock rules for a one-day host);
  - a probe entry for it;
  - `secrets run` with the released CLI (the `resolve` route with every digest instead).
- **Its host jobs fail closed:** the ops image knows `staging` and `prod` only (`known-limits.md`).
- **The three remaining negative steps of the plan** are proven by Run 6.7's integration tests, not repeated on the drill host:
  - a v2 gate file from before the restore → `quarantined`;
  - a restore stopped after step 5 and rebooted;
  - an `eligible.json` signed by a throw-away key.

  Each would need steps 2–4 again (with the reconciles, about 35 minutes).

- **The probe:** staging was set to `inService: false` in the deployed Worker for the window only (not committed), then deployed back from the committed configuration.

## Registry

- AC-1.28 SPIKE_PASS
- AC-1.43 SPIKE_PASS
- AC-1.44 SPIKE_PASS
- PO-22 SPIKE_PASS
- KMS-L1 SPIKE_PASS (the drill added as evidence)
- DB-G1 SPIKE_PASS (the drill added as evidence)

## Open issues

- **`reconcile-credentials` per environment** costs about 19 s each (a process and two tunnels). It is the largest part of the recovery time. An `--all` form is for Session 8 (`known-limits.md`).
- **The ops image refuses a third host name**, so the drill host's timers fail closed.
- **The drill host stays as it is until the gate.** The gate then:
  1. has the owner reinstall the server;
  2. removes `drill` from `hosts.json` and takes down its DNS record (`probe.ts drill-host-dns down`);
  3. un-lends `prod`;
  4. rebuilds production closed, with the owner's permission;
  5. puts the probe entry back as `inService: false`.
