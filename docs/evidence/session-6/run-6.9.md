# Run 6.9 — Release, deploy and timers (D08-S43)

**Date:** 18 Nov 2026. **Branch:** `session-6`. **Decision:** D-57 (a release built once, promoted through the closed gate). **Runbooks:**

- new: `deploy.md`;
- changed: `service-gate.md`, `network.md`, `provisioning.md`, `audit.md` (generated).

Staging now runs `host-v0.6.1` with a v2 gate. It got there through the deploy tooling: forward, back and forward again, then a forward deploy of 0.6.1. Production is untouched. From this run on, its server is lent to the drill (Run 6.8).

## What was done

- **Task A — build once (P-127).**
  - `infra/release/build.ts` (`pnpm run host:release`), on a clean clone outside OneDrive:
    - refuses a dirty tree and a commit origin does not hold;
    - builds `api`, `provisioner` and `ops` with `MYKEY_BUILD` = the commit's first 12 hex;
    - refuses an image that still holds `npm`, `npx` or `corepack` (every final stage removes them);
    - saves each archive;
    - scans the history, the dependencies and **the archives themselves** (`ci-scan images --archives`);
    - only then writes `release.json` (schema in `@mykey/contracts`, scans can only be `pass`) and `SHA256SUMS`.
  - Three releases are published on GitHub:

    | Release       | From      | api image          |
    | ------------- | --------- | ------------------ |
    | `host-v0.5.9` | `5a404a6` | `sha256:53729b84…` |
    | `host-v0.6.0` | `26fcbb8` | `sha256:1a8f38cc…` |
    | `host-v0.6.1` | `3c39f30` | `sha256:85215e5a…` |

- **Task B — promote, verify, open; roll back (P-128, P-131).** `host.ts <host> deploy --release <dir> [--resume] [--install-only | --stay-closed]`:
  - **The plan:** eight steps. A redeploy has no `migrate`. The plan refuses a downgrade, an unrelated commit and an unknown image.
  - **The state line:** `/var/lib/mykey/deploy-state.json`.
  - **The owner's journey through the verification listener:** sign-in with TOTP, a reveal compared with the last deploy's digest (`deploy-journey.json`), a refused write, sign-out.
  - **The report:** `REQUIRED_CHECKS.deploy`, audited as `operator.deploy {build}`.
  - **The opening:** `gate open` with that report.
  - **Converting a v1 host:**
    - close v1;
    - `db-init`, which writes the incarnation;
    - the copy into OpenBao where none is;
    - v2 closed + `verifying`.
  - **A rollback** is a deploy of the previous release.
- **Task C — timers and the carried minors (P-129, M-7).**
  - **M-7:** `expireOperations` ends an import parent stranded in `awaiting_input` after its entries' replay window; the resume answers 409 `replay_expired` (route contract updated).
  - **The archive tick:** one archive that throws no longer stops the next (`driveEach`; `archive_failed` log line).
  - **`ops sweep`:** "skipped: capture", or "swept: uncertain N, rejected M".
  - **Units:** `mykey-operations-expire` (02:00 UTC, `Persistent=true`), `mykey-auth-cleanup` (`*:15`), `mykey-sweep` (`*:0/5`).
  - **The audit journey's `PENDING_WRITERS` is empty.** The ten actions it cannot run name the test file that asserts their rows (`WRITTEN_ELSEWHERE`, checked by the test).

## What staging found (fixed in this run)

1. **The verification record named the old build.** `runGate` bound the build of the container still running, so the new API's listener refused (`gate_closed cause: build`). Now every gate write of a deploy binds the release's build, and the journey step rewrites closed + `verifying` for the build that runs.
2. **`--resume` would have started over.** After a stop the host already runs the release; the replanned deploy has no `migrate`, and `indexOf` was −1. A resume now continues by position in the step order. Unit test RED → GREEN.
3. **`previous_gate_closed` read the record from before `gate_close`.** That record is open on every normal deploy. The check now reads, at report time, the record the opening replaces. `failed-migration.test.ts` gained a redeploy over an open gate: RED ("check previous_gate_closed is failed") → GREEN.
4. **The journey's checks lived in a temporary directory.** It disappears when the command stops, so a resume at `report` would have lost them. They are now kept beside the report until `gate_open`.
5. **A reconcile locked the API's runtime role out of OpenBao (Critical).**
   - **The cause:** the deploy changed the planned provisioner policy (Run 6.7's read of `mykey-meta/data/incarnation`), so `provision-organization` put the organization in review.
   - **The reconcile:** the planned policy was written with the root token, after checking that the live one differed by exactly that line; `provision-organization` then took the organization back to `active`. That run rotated every secret id.
   - **What went wrong:** the API had kept its first runtime credential, failed with the destroyed one once a minute (`/health` `openbao_audit`), and its failed logins locked the runtime role id out (OpenBao user lockout: `permission denied` even for the right secret id; the issuer was unaffected). `provisioning.md`'s "restart the API (`host.ts up`)" would not have helped: `up -d` does not restart an unchanged container, and a restart during the lockout is refused too.
   - **The outage:** staging's runtime reads were down from 11:57 to about 12:17 UTC. No data was affected.
   - **The fix:** the API now follows its credential files (`runtime-bao.ts`: inode, size and time per call, for both identities). The integration test "a rotated secret id: the next runtime call and the next issuer session use the delivered one, without a restart" went RED ("runtime after rotation: invalid") → GREEN. Shipped as `host-v0.6.1`.
6. **`status.sh` read only v1 gate records.** A v2 record showed as `invalid`. Unit test RED → GREEN; pushed to staging.

## Staging, in order

| Time (UTC)  | What                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11:26       | First `deploy` of `host-v0.6.0`: conversion to v2 (incarnation `82e40516-…`, migration `0018`); stopped at `journey` (finding 1), gate closed                                                                                                                                                                                                              |
| 11:35–11:38 | Two `--resume` runs: findings 1, 2, 3                                                                                                                                                                                                                                                                                                                      |
| 11:41–11:52 | `deploy.staging.test.ts`: **PASS** (673 s). 0.6.0 → 0.5.9 → 0.6.0, each closed then open; the poller saw `quarantined` while closed; no proxy outage past the limit; the running image ids are the release's; v2 open + `serving` with the build and a report hash; one reveal digest; `operator.deploy` ×3 and `operator.gate_open` ×3 in the audit table |
| 11:53       | Timers installed: 9 `mykey-*` timers (below)                                                                                                                                                                                                                                                                                                               |
| 11:55       | First `mykey-sweep`: success, "swept: uncertain 0, rejected 0"                                                                                                                                                                                                                                                                                             |
| 11:54–11:57 | `provision-organization`: review on `policy:provisioner`; reconciled, `active`, `verify-organization` → `equal`                                                                                                                                                                                                                                            |
| 11:57–12:17 | Finding 5: runtime lockout; the API was restarted at 12:04, and the lockout ended at 12:17                                                                                                                                                                                                                                                                 |
| 12:52–12:58 | `deploy --release host-v0.6.1`: every step in one pass; gate open, epoch 247, build `3c39f30e5c32`                                                                                                                                                                                                                                                         |
| 13:00       | `status`: gate open, no `bad`, probe no open condition                                                                                                                                                                                                                                                                                                     |

```text
$ systemctl list-timers 'mykey-*' --no-pager   (staging, 11:53 UTC)
mykey-heartbeat.timer  mykey-sweep.timer  mykey-egress-refresh.timer  mykey-auth-cleanup.timer
mykey-bao-audit-rotate.timer  mykey-audit-archive.timer  mykey-operations-expire.timer
mykey-backup.timer  mykey-pair-retention.timer                       9 timers listed.
```

## Commits

- `1421618` contract: import.resume answers replay_expired (M-7)
- `5a404a6` feat(release): three images, scanned, built once
- `711fc63` feat(hosts): timers for expiry, clean-up and the sweeps
- `26fcbb8` feat(host): deploy promotes a release through the closed gate
- `ee808b1` docs(deploy): D-57 and the deploy runbook; no writer is pending
- `3c39f30` fix(deploy): what staging's first deploys found
- the docs commit of this note (registry)

## Commands and results

| Command                                                                                   | Result                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest --project unit tests/unit/release`                                                | schema, host-build, deploy-plan (10/10 after the resume test), RED first                                                                                                               |
| `vitest --project integration tests/integration/deploy/failed-migration.test.ts`          | 1/1: a failing migration leaves nothing (no table, history unchanged), stops closed; the previous release reopens; a redeploy over an open gate opens; the audit rows of three deploys |
| `vitest --project integration tests/integration/deploy/previous-release.test.ts`          | 2/2: the API of `45b5c1f3cc3a`, from its own worktree (`~/mykey-prev/45b5c1f3cc3a`), signs in, writes, reveals, issues and revokes on a database at `0018` (P-131)                     |
| `vitest --project integration tests/integration/deploy/{expire-resume,ops-sweep}.test.ts` | green (M-7, `ops sweep`)                                                                                                                                                               |
| `vitest --project integration tests/integration/audit/journey.test.ts`                    | 7/7                                                                                                                                                                                    |
| `vitest --project integration tests/integration/openbao/inline.test.ts`                   | 8/8, with the rotation test RED first                                                                                                                                                  |
| `vitest --project staging tests/staging/deploy.staging.test.ts`                           | 1/1, 673 s                                                                                                                                                                             |
| `pnpm test`                                                                               | 1205/1205                                                                                                                                                                              |
| `pnpm run check`                                                                          | green                                                                                                                                                                                  |

## Deviations and decisions

- **`host-v0.5.9` is built from `5a404a6`, not `c96b83d`:** the build tool did not exist at `c96b83d`. It is two commits later: one contract line and the Dockerfiles' npm removal. It has the same migrations, gate v2 and the listener.
- **The first 0.5.9 build was stopped** by Claude Code under memory pressure, during a scan. The restart passed every scan.
- **P-131 runs the old commit's own `api-process.ts`** from a git worktree, not its image: the same code, without a container on the test stack's network.
- **`failed-migration.test.ts` runs on a stack of its own**, with the gate, migrate and the report real. The host's steps (load, start, journey) are proven by the staging test.
- **The deploy's `migrate` copies the incarnation into OpenBao only where none is.** A different copy is a restore's to settle, and the report fails on it.
- **The deploy report reads OpenBao with the custody root token** (open issue below).
- **A release that changes a planned OpenBao object is reconciled by `provisioning.md`'s path after the deploy** (`deploy.md` says so), not by a deploy step.
- **`Persistent=false` for the frequent timers.** A missed `*:0/5` run is replaced by the next one.

## Registry

- FR-1.73 SPIKE_PASS
- FR-1.74 SPIKE_PASS
- AC-1.32 SPIKE_PASS

## Open issues

- **The deploy needs a namespace-listing OpenBao identity.** It is the custody root token today, and M1 revokes that at the gate. After that, deploys cannot fill `openbao_readable` or `incarnation_three_places` until another such identity exists.
- **The OpenBao user lockout turns a credential mistake into a 15-minute outage** of every secret read. It now needs a credential mistake rather than an ordinary reconcile (finding 5). Whether to tune `user_lockout` for AppRole is a question for Session 8's review (`known-limits.md`, Run 6.10).
