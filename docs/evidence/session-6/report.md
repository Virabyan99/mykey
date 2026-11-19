# Session 6 report — Audit, limits, backup, recovery and deployment

**Gate date:** 18 Nov 2026. **Branch:** `session-6`, pull request #16. **Runs:** 6.1 … 6.10 (tags `session-6-run-6.N`). **Decisions:** D-46 … D-57. **Migrations:** `0015`–`0018`.

## Result

**PASS WITH ISSUES.** The review's two Important findings are settled, the first full CI run's seven failures are fixed (one was a product defect of Run 6.7), CI is green, staging runs `host-v0.6.5` (two more defects found and fixed at the gate), and production's lent server is back, reinstalled and closed on `host-v0.6.3`. The resting root token (M1) is carried to Session 8 as a Blocker candidate.

What the session built and proved:

- **Audit** (6.1, 6.2): the organization's audit route and activity timeline, with a coverage table that fails the build when a route has no decision. Both audit streams are archived to R2 as verified, locked segments; the purge cannot outrun them.
- **Limits** (6.3): every limit of Doc 06 §11 enforced in the pipeline, failing closed. This covers:
  - rate limits per person, session, source and machine token, answering 429 with `retry-after`;
  - the disk capacity record (507);
  - the per-credential read lock with a 1.5 s cool-down.
- **Status and alerts** (6.4): a private status view; fifteen probe conditions, each opened, delivered on Telegram and resolved on staging (`alerts.md`); a watcher of the probe outside Cloudflare.
- **Backup** (6.5, 6.6): a nightly pair under a capture barrier. A pair is eligible only after it was read back from R2, checked by Restic, restored to scratch stores and signed. Retention never deletes the newest eligible pair.
- **Gate and restore** (6.7): a v2 gate bound to host, backend incarnation, release and report; a restore that invalidates every credential by class.
- **Releases** (6.9): host releases built once and promoted through the closed gate (`host.ts deploy`); the job timers on the host.
- **The clean-host drill** (6.8, D-56): staging's pair restored on production's lent, reinstalled server from R2 and the custody set alone, while staging was fenced. All 20 checks were `ok` and the gate opened. All nine old credentials were refused, and the 50 secrets revealed with their digests.
- **Runbooks** (6.10): one runbook section per alert and an honest `known-limits.md`, kept true by three unit tests.

Registry: all 38 of the session's items are `SPIKE_PASS`, and nothing is `PASS`. The totals are 154 `SPIKE_PASS` and 37 `OPEN` (116 and 75 after Session 5).

## Step 1 — the full suite

| Command                                      | Where                | Result                                   |
| -------------------------------------------- | -------------------- | ---------------------------------------- |
| `pnpm run check`                             | workstation          | green                                    |
| `pnpm test`                                  | workstation          | 1,228 tests, 108 files, green            |
| `pnpm run test:integration` (two shards)     | CI, pull request #16 | green on `e93e9cf` (run 44377315097)     |
| `pnpm run test:cloud`                        | workstation          | 14/14 (3 files), **no dated guard left** |
| `pnpm run test:cli`, `pnpm run test:browser` | workstation          | 53/53 (8 files); 4/4                     |

The full integration suite ran on CI, not on the workstation (the owner's rule of 17 Nov, and the owner's yes on 18 Nov). The review and this report were written while it ran. `test:cloud` rewrote its three committed evidence files, and they were restored.

**The first full run failed** (run 44348491466, 13 tests in 7 files; the run on `945322d` failed the same way). It was the session's first full integration run, because each run proved only its own files. What it found:

| Failure                                                                       | Cause                                                                                                                                                                                                                                                                                                       | Fix                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `environment.test.ts` "provisioner credential destroyed", `readiness.test.ts` | **A product defect of Run 6.7.** The provisioner reads OpenBao's incarnation before a job. With its own secret id destroyed, that read fails at login and counted as cause `incarnation`, so the job was deferred every 30 s for ever: the environment stayed `pending`, and `review_open` could never open | `054a80c`: a refused AppRole login (`ProvisionerClient.loginRefused`) lets the job run. It can change nothing and ends `provisioning_failed` / `needs_review` as before. A different or unreadable incarnation still defers. RED → GREEN locally (both files whole, 17/17, Run 6.7's guard test included); released as `host-v0.6.3` |
| `restore/full.test.ts`, the last test, sign-in 429                            | Test defect. Its deliberate refusals spent four of the source's five password attempts a minute, and the journey needed three more, so passing depended on where the minute's boundary fell. The throttle is right                                                                                          | The test gives the source its budget back after the refusals                                                                                                                                                                                                                                                                         |
| `privileges.test.ts`, `access.test.ts`                                        | The privilege matrix did not know 0018's two columns, which only `maintenance` writes (the database is right)                                                                                                                                                                                               | Matrix updated                                                                                                                                                                                                                                                                                                                       |
| `boundaries.test.ts` "has 39 points"                                          | Run 6.7 added the step `incarnation` (42 points; all 42 passed)                                                                                                                                                                                                                                             | Count updated                                                                                                                                                                                                                                                                                                                        |
| `pair.test.ts` (6 tests)                                                      | `EACCES` on Linux: Restic and tar in containers wrote as root, and the test could not remove or damage their files. Windows Docker hides ownership                                                                                                                                                          | The harness runs its containers as the calling user on Linux                                                                                                                                                                                                                                                                         |
| `previous-release.test.ts`                                                    | The CI checkout is shallow, so commit `45b5c1f3cc3a` is missing                                                                                                                                                                                                                                             | The integration job checks out the whole history                                                                                                                                                                                                                                                                                     |

**After the fixes:** run 44377315097 on `e93e9cf` was green: `check`, both scans, the secret scan, and both integration shards.

**What the runs after it found:**

- **A second defect of Run 6.7's guard.** On the next three runs `drift.test.ts` failed (OpenBao stopped during a sweep): the provisioner kept a _failed_ incarnation read for 5 s and called it cause `incarnation`. So after OpenBao came back, the next sweep was still skipped; passing depended on timing. It reproduced locally. `7a9a1d4`: a read with no answer closes as `unreachable` and is never cached, while a real mismatch stays `incarnation`. RED → GREEN 8/8; `environment.test.ts` and `starvation.test.ts` 14/14. Released as `host-v0.6.5`.
- **A new upstream CVE.** `CVE-2026-97054` (Go stdlib, published after the green scan) is in postgres/gosu, restic, OpenBao and Traefik; the fix needs new upstream images. It was reviewed into `.trivyignore.images` (`2072215`). OpenBao and Traefik serve HTTP/1, so it is **carried to Session 8's security review**.
- **Two timing failures:** `starvation.test.ts` (3 writes instead of 4, once) and `large.test.ts` (a 120 s timeout, once). Both passed on the other runs and locally (ruling).

**Final:** run 44481743101 on `2072215` is green: `check`, both scans, the secret scan, and both integration shards. The last commit changes one staging test and documents only.

## Step 2 — dated items and checkpoints

- **`test:cloud`'s dated guard is gone** (Run 6.6): R2's lock rules are checked against real objects now, not a fixture date.
- **KMS certificates expire on 12 Dec 2026** (staging seal 10:50 UTC), checkpoint `kms-cert-expiry` from 12 Dec 09:57 UTC. Since Run 6.4, `certificate_expiring` also opens on its own: 10 days before for a 30-day certificate (D-50). The drill host's certificate `drill-seal-1` expires 18 Dec 2026 and is revoked at the end of the drill (below).
- **`.trivyignore.images` expires on 14 Dec 2026.**
- **`backup-first-night`: observed.** The timer's own capture of 18 Nov 03:00:06 UTC is `eligible` (`app.backup_pair` on staging). `backup-night.staging.test.ts` reads the newest eligible pair, which today is the drill's 13:30 capture. It is green again after the 19 Nov 03:00 run.
- **`pair-30-day`**, from 17 Dec 2026 19:00 UTC: the oldest pair restores, then retention deletes it (Run 6.6).

## Steps 3–4 — staging

**Step 3: a release through the closed gate** (`deploy.staging.test.ts`, 1/1). `host-v0.6.3` → `host-v0.6.1` → `host-v0.6.3` on staging, each through the closed gate with a verification report.

**Step 4: the staging suite, one file at a time.** It was reduced at the owner's request for speed (ruling). It covered this session's files, the files that cover what the session changed, and `unseal` once instead of three times. Left out: `boundary` and `transport` (the network is unchanged since Session 2), and `identity`, `export`, `cli`, `key-loss` and `probe`, plus `test:consumers` (unchanged since Session 5).

| File           | Result                 | Note                                                                                                    |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `api`          | 12/12 (second run)     | stale: wrote v1 gate records (fixed `a047a08`); counted one user (fixed `584eda6`)                      |
| `provisioning` | 5/5                    | on `host-v0.6.5` too                                                                                    |
| `credentials`  | 2/2 (third run)        | stale against Run 6.3's limits: re-paced, aimed at the measured pause, a fresh minute for its 409 check |
| `reconcile`    | 1/1                    | re-paced, reopened by a redeploy                                                                        |
| `machine`      | 1/1                    |                                                                                                         |
| `secrets`      | 4/4                    |                                                                                                         |
| `token-sweep`  | 1/1                    |                                                                                                         |
| `archive`      | 1/1                    |                                                                                                         |
| `audit`        | 5/5 (on `host-v0.6.4`) | **found a product defect** (below)                                                                      |
| `limits`       | 2/2                    |                                                                                                         |
| `status`       | 3/3                    |                                                                                                         |
| `backup`       | 6/6                    |                                                                                                         |
| `unseal`       | 10/10                  |                                                                                                         |

- **The product defect `audit` found.** The audit archive stopped on staging at its tenth segment: "the chain is broken: sequence 10 follows 1". `listSegments` selects `sequence::text AS sequence` and ordered by `sequence`, which PostgreSQL resolves to the text alias, so the chain read 1, 10, 11, 2. No integration test had more than nine segments. `f060d2d` orders by `archive_segment.sequence` (`long-chain.test.ts` RED → GREEN; archive files 17/17). Released as `host-v0.6.4` and deployed; the timer's next run archived again.
- **Two incidents of the gate itself:**
  - `pnpm run test:staging -- <file>` ran every staging file, because pnpm 10 passes the `--` and vitest then drops the filter. It was stopped at once, and `vitest.config.ts` now refuses a `--`.
  - The stale `api` test left a v1 record on staging's v2 gate, so staging answered 503 until a redeploy reopened it.
- **Releases at the gate:** `host-v0.6.3` (`e93e9cf`), `host-v0.6.4` (`584eda6`) and `host-v0.6.5` (`7a9a1d4`), all published. Staging runs `host-v0.6.5`, gate open.

## Step 5 — staging's root token (M1)

**Stopped, as the plan allows; carried to Session 8 as a Blocker candidate.** Two tools still need a root token at rest on the workstation:

- `ops` over the tunnel (`opsRootToken`, `scripts/host.ts`), which reads OpenBao for `verify-organization`, `reconcile-credentials` and the restore commands;
- the deploy's report, which lists namespaces for `openbao_readable` and `incarnation_three_places` (Run 6.9, D-57).

Revoking the custody root token today would break both. The way out is an identity of their own: an operator policy that lists namespaces and reads the incarnation, with a short token per use from `generate-root` or an AppRole. It needs its own design and tests (`known-limits.md`).

## Steps 6–7 — the drill host ends, production comes back

- **The drill host ended** (18–19 Nov):
  - its gate closed (epoch 6) and its DNS record `mykey-drill.nomikey.com` removed;
  - the owner deleted its KMS certificate in the console (`d1491e6a-…`; staging's `staging-seal-2` still locates the key);
  - it left `~/.mykey/hosts.json` (backups `*.before-prod-rebuild`).
- **No R2 credential to roll.** The restore reads the pair on the workstation and streams it, so the drill host never held one (ruling).
- **Production came back** (19 Nov, with the owner's yes):
  1. the owner reinstalled the server a second time and changed the `ubuntu` password;
  2. the new host key was taken right after (`SHA256:GNBAiYA1p9NZ/c1Pr9JFjAJH9zeVcMas45hEZ1TrIuA`);
  3. `bootstrap`, then `apply ssh` + `confirm`, then `apply firewall` + `confirm` (no revert pending); the owner restarted the WireGuard tunnel after bootstrap;
  4. `deploy --install-only`, `up`, postgres and traefik pulled by digest, `up`, `db-init` (`0018`);
  5. `deploy --release host-v0.6.3 --stay-closed`, `keys init`, `acme production` + `up`.
- **What production is now:**
  - 0 users, 0 organizations, schema `0018`;
  - containers `api`, `edge` and `postgres`, and no OpenBao;
  - `/v1/organizations` answers 503 `quarantined` and `/health` answers 503 `down`;
  - the public certificate verifies;
  - a closed v2 gate record (epoch 1, `fresh_install`);
  - back in the probe as `inService: false` (`fa373a7` reverted; probe deployed; both heartbeats reinstalled by `probe.ts secrets`).

## Step 8 — the fresh-context review

One fresh-context review (Opus) of `git diff main...session-6`, with the plan's nine questions and none of its reasoning. It ran nothing against hosts.

**Its answers** (in short):

1. **Writes during a capture:** none reach an authority table, apart from Finding C. A pair becomes `eligible` only through `settlePair`, after the read-back digest, `restic check --read-data` and the restored artifacts all match.
2. **Credentials after a restore:** every class is invalidated:
   - sessions, verifications and reset tokens deleted;
   - accounts set to `recovery_pending` with a new epoch;
   - credential rows revoked;
   - every token accessor in the root and the namespaces revoked;
   - every AppRole secret id rotated;
   - new role passwords;
   - the restore's own token revoked at the opening.
3. **The gate:** no way to open without a fresh, matching report.
4. **Deciding when unsure:** rate limits and the capacity record fail closed. Minor gaps are listed below.
5. **Audit leaks:** none. Rows are bound to the organization, global rows are never served, and details are re-parsed.
6. **Audit deletion:** none before verification. `purge_archived` deletes only verified, counted intervals older than 365 days.
7. **Secrets:** none in logs, units, manifests, reports, heartbeats or committed files.
8. **Alerts:** see A, F, H.
9. **Expand-only:** yes, with two notes:
   - 0015's generated column rewrites `audit.event` under a lock, so audited requests stall during that migration;
   - a v2 gate record reads as invalid to the previous release, so a rollback rewrites a v1 record.

| Finding | Grade (re-graded)         | What                                                                                                                                                                       | Outcome                                                                                                                                                                                                                              |
| ------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A       | Important → **gate step** | The probe's `HOSTS` lacks production (removed for the drill)                                                                                                               | **Done at step 7**: production is back as `inService: false` (`fa373a7` reverted in `f060d2d`). Not a code defect. Putting it back before that would open `heartbeat_missing`, because the lent server sends no production heartbeat |
| B       | **Important**             | After a restore under the same host name, the audit archive stops for good: the restored chain's next segment lands on a key the lost host had already filled and locked   | **Fixed** (`945322d`): new segment keys hold the backend incarnation, which every restore renews. `restored-chain.test.ts` RED ("segment 1 reads back differently") → GREEN; archive files 16/16; released as `host-v0.6.2`          |
| C       | Minor                     | `capture_invalidate` records the transaction's start time, so a reduction that began just before `capturing` committed can go unseen, and a crossed pair stays eligible    | Session 8 (`clock_timestamp()` in a migration). A restore resets every credential anyway, and members are confirmed by count                                                                                                         |
| D       | Minor                     | A restore accepts any signed `eligible.json`: one past `eligibleUntil`, or one published before a commit that failed                                                       | Session 8                                                                                                                                                                                                                            |
| E       | Minor                     | The verification listener has in-flight and large-body slots of its own, so two listeners double the per-process limits                                                    | Session 8                                                                                                                                                                                                                            |
| F       | Minor                     | `status.sh` counts an absent OpenBao container as audit-healthy (`sealed` then reads unknown, so `checks_unknown` still opens)                                             | Session 8                                                                                                                                                                                                                            |
| G       | Minor                     | `mykey-backup` lacks `SuccessExitStatus=75`, so a busy drain leaves `unit_failed` open until the next night                                                                | Session 8                                                                                                                                                                                                                            |
| H       | Minor                     | `mykey-capture-recover` is ordered only after Docker. At boot, before PostgreSQL accepts connections, it fails and stays failed (`capture_frozen` and `unit_failed` alert) | Session 8                                                                                                                                                                                                                            |
| I       | Minor                     | The coordinator's mode updates have no `lock_timeout`, so one long writer stalls every API write behind them during the drain                                              | Session 8                                                                                                                                                                                                                            |

## The drill (Run 6.8, `drill.json`, D-56)

| Step                                                                                                | Seconds   |
| --------------------------------------------------------------------------------------------------- | --------- |
| C1 — the clean host: release, upstream images, okms, stack, OpenBao and database init, keys, timers | 225.4     |
| C2 — `restore` steps 1–7 (the third run)                                                            | 224.2     |
| C3 — `verify-organization`, the spike organizations marked, `reconcile-credentials` × 84, the reset | 1,661.3   |
| C4 — `restore-verify --journey`: 20/20 ok                                                           | 200.0     |
| C9 — a fresh journey and report; `--open`                                                           | 234.2     |
| **Sum of the timed steps**                                                                          | **2,545** |
| **Wall time from "staging lost" (13:34:29) to "gate open" (15:52:49), the fixes included**          | **8,300** |

- **The refusals:**
  - `gate open` without a report;
  - with a report older than 30 minutes;
  - with another incarnation's report;
  - `restore --pair` on an ineligible pair.
- **After the opening:**
  - the nine old credentials answered 401: three tokens, three sessions, three passwords;
  - the secret written after P answered 404;
  - a new token's `resolve` returned every digest;
  - the audit table held `restore_begin`, `restore_invalidate`, `restore_verify` and `gate_open` in that order.
- **The drill found eleven restore gaps**, each fixed with a test (D-56's table):
  - the fence;
  - an install on a host that never ran `up`;
  - `--journey` on a host;
  - the source's backup password;
  - restic's output directory;
  - step 7 recreating the executors;
  - `--organization` and the organization id;
  - the restore's root token for `ops`;
  - a clipped `observed`;
  - `timers` creating `bao-audit/rotated`;
  - the jobs' copies of the restored passwords.

## Measurements

- **The capture's freeze on staging:** median 2,799 ms, worst 3,717 ms. Once with writes in flight it froze for 8,959 ms: 10 of 17 writes answered `busy` over 7.4 s, and the last succeeded. Reads continue (Run 6.5).
- **Pair size:**
  - the bundle of the used staging pair is 44.3 MB (Run 6.6);
  - the first product capture's bundle is 48.3 MB (Run 6.5);
  - the frozen artifacts must fit the 1 GiB tmpfs.
- **Audit segments:**
  - the app stream grows about 6 MB a month (kept 365 days in production, 30 days on staging);
  - OpenBao's stream grows up to 450 MB a month under test traffic;
  - the first rotation copied a 1.87 GB file (Run 6.2).
- **Monthly R2 cost for one host** (`cost-sheet.md`, estimated from measured sizes): 32 pairs of 44.3 MB are 1.42 GB-month, which is **$0.00** inside the included 10 GB, or $0.03 without it. Operations stay below $0.001. COST-B1 waits for December's invoice.
- **Starvation** (Run 6.3): with the 1.5 s cool-down every write succeeded within three attempts; the worst took 6.4 s. The margin is thin on a slower host (`known-limits.md`).
- **Restore** (FR-1.69): see the drill. `reconcile-credentials` costs about 19 s per environment, which is 27.7 of the 42 minutes.

## Alerts (Run 6.4, `docs/evidence/session-6/alerts.md`)

Every condition opened, was delivered, and resolved on staging. The delays below are from cause to delivery, and from removal to the resolved delivery.

| Condition               | Opened       | Resolved                           |
| ----------------------- | ------------ | ---------------------------------- |
| `heartbeat_missing`     | 177 s        | 50 s                               |
| `health_failing`        | 225 s        | 39 s                               |
| `openbao_sealed`        | 270 s        | 45 s                               |
| `kms_unreachable`       | 296 s        | 50 s                               |
| `review_open`           | 21:31:26 UTC | 21:32:26 UTC (the Session 3 drill) |
| `operations_unresolved` | 49 s         | 54 s                               |
| `disk_low`              | 294 s        | 105 s                              |
| `audit_failing`         | 265 s        | 44 s                               |
| `capture_frozen`        | 634 s        | 111 s                              |
| `backup_stale`          | 54 s         | 56 s                               |
| `certificate_expiring`  | 80 s         | 48 s                               |
| `credential_expiring`   | 34 s         | 56 s                               |
| `firewall_unloaded`     | 231 s        | 102 s                              |
| `unit_failed`           | 289 s        | 53 s                               |
| `checks_unknown`        | 282 s        | 47 s                               |

`health_failing` was also proven from outside, through a sink-test Worker: for a name that does not resolve, for a name outside the certificate, and for a stopped API. `docs/runbooks/alerts.md` has the runbook of each condition, and `alerts.test.ts` keeps both lists equal to the probe's `CONDITIONS`.

## Decisions

- **D-46:** audit coverage and the view.
- **D-47:** operator jobs on the host.
- **D-48:** the audit archive.
- **D-49:** limits and capacity.
- **D-50:** alerts and the operator status.
- **D-51:** the capture barrier.
- **D-52:** the pair (format and custody).
- **D-53:** retention and clean-up.
- **D-54:** gate v2.
- **D-55:** restore by class.
- **D-56:** the clean-host drill.
- **D-57:** a release built once, promoted through the closed gate.

## Deviations from the plan

The ledger holds every ruling, each with its cost if wrong. These are the ones that change what the plan said:

- **Run 6.1:** list errors keep the pipeline's 400 `malformed_request`, not the plan's 422, for unknown keys and bad cursors (one contract since Run 3.9).
- **Run 6.3:**
  - the class limits count per person, not per session;
  - the per-credential lock is a session-level advisory lock on the read's own connection.
- **Run 6.4:**
  - the watcher's first scheduled run waits for the merge (schedules run only from the default branch);
  - `checks_unknown` was drilled with `openssl` shadowed, not `jq`.
- **Run 6.5:**
  - the barrier also closes superusers;
  - the pair tmpfs is `/var/lib/mykey/pairs/<id>`;
  - `ops pair` has a third step, `manifest`;
  - the backup AppRole's secret id never expires.
- **Run 6.6:** checkpoint `pair-30-day` opens 17 Dec 19:00, not 18 Dec, so it runs before the 05:00 timer would delete the pair.
- **Run 6.7:**
  - the verification listener serves every `/v1/auth/*` path, because the restore's reset needs them;
  - `host.ts restore` is two commands (`restore`, `restore-verify`).
- **Run 6.9:**
  - `host-v0.5.9` was built from `5a404a6`, the first commit with the build tool;
  - the deploy report reads OpenBao with the custody root token.
- **Run 6.8:**
  - the drill used `host-v0.6.1`;
  - step 1 is the whole of `restore.md`'s "Before";
  - the restore ran three times for P;
  - the drill host's 16 spike organizations were marked for review before the report;
  - left out on the drill host: a pair under `pairs/drill/`, a probe entry, and `secrets run` with the released CLI (the `resolve` route with every digest instead);
  - three negative steps were left to Run 6.7's integration tests;
  - the probe ran with staging `inService: false` for the window.
- **Run 6.10:**
  - the evidence lines carry dates and delays, not alert-log row ids;
  - no separate `runbook-coverage.ts`.
- **The gate:**
  - the full integration suite ran on CI;
  - M1 stopped (above);
  - step 6's R2 roll has nothing to roll, because the restore streams the pair from the workstation and the drill host never held an R2 credential.

**Findings of the session's own runs, fixed as they were found:**

- Runs 6.8–6.10 put their registry claims in the `owners` list, which the build ignores. `loadOverrides` now refuses an entry in the wrong list.
- Run 6.9's deploy found five defects on real hosts (its run note).

## Open issues (with owner runs)

- **M1, the resting root token** → Session 8 (Blocker candidate, above).
- **`reconcile-credentials --all`**: a restore spends 27 of its 42 minutes on one process per environment → Session 8.
- **The OpenBao user lockout** turns a credential mistake into a 15-minute outage of every secret read → Session 8's review.
- **The ops image knows only `staging` and `prod`** → when a third host is real.
- **Two Session 4/5 staging drills are stale** against Run 6.3's limits: `credentials.staging.test.ts` ("the drill") and `reconcile.staging.test.ts` (Run 6.4's open issue). Re-paced at the gate (each attempt in a fresh minute) and reopened by a redeploy; see Steps 3–4.
- **Staging's 16 spike organizations** stay in its pairs. A restore of staging must mark them, and marking them on staging opens `review_open` → owner decision.
- **`credential_expiring` and short credentials:** a credential issued for under 7 days is "expiring" from its first minute → Session 8.
- **Run 6.5's cloud test rewrites its evidence file on every run** (deferred minor).
- **The watcher's first Actions run** comes after the merge: run `gh workflow run probe-watch` once and see it green.
- **CVE-2026-97054 in OpenBao and Traefik** (HTTP/1 servers; reviewed into `.trivyignore.images` until 14 Dec) → Session 8's security review; move the pins when upstream rebuilds.
- **The credential drill is probabilistic:** it caught an unknown issuance on attempt 3 of one run, 0 of 5 in the next, and attempt 8 of 10 in the third. A drill that cannot place its fault deterministically → Session 8 (a fault point in the issuance path would make it exact).
- **The staging suite at this gate was reduced** (ruling): `boundary`, `transport`, `identity`, `export`, `cli`, `key-loss`, `probe` and `test:consumers` were not rerun → run them at Session 7's gate.
- **OWN-4:** the owner's offline copy of `~/.mykey/custody/staging/backup/` is not confirmed yet.

## What Sessions 7, 8 and 9 must know

- **The audit and activity contracts:**
  - `GET /v1/organizations/{id}/audit` (owner and admin) and the activity timeline, paged by an opaque cursor;
  - filters (`auditListQuery` in `packages/contracts/src/routes.ts`):
    - `from`/`to` (RFC 3339; the last 30 days by default, at most 92 days apart);
    - `action`, `outcome`, `actorKind`, `actorId`;
    - `projectId`, `environmentId`, `operationId`, `requestId`;
  - `details` is parsed again with the action's own schema on the way out (`{}` when a row fails it);
  - an unknown key or a cursor that does not verify answers 400 `malformed_request`, and a cursor reused with other filters answers 409 `listing_changed`;
  - rows of another organization and global rows never appear;
  - the coverage table (`AUDIT_COVERAGE`) must name every new route, or `check` fails.
- **The new answers a workspace must show:**
  - `429 rate_limited` with `retry-after` (seconds);
  - `507 capacity_exceeded` when a volume is low (expanding changes only);
  - `503 busy` during a capture's freeze (seconds, safe to repeat);
  - `503 dependency_unavailable` when the capacity record is missing or stale;
  - `quarantined` while the gate is closed.
- **The verification listener** (`10.78.2.3:8444`, reached through `host.ts <host> tunnel verify`) serves the product while the gate is closed + `verifying`, refuses every change, and is how the owner proves a restored host.
- **A restore resets everyone.**
  - Every account becomes `recovery_pending` (an operator reset each).
  - Every machine token is revoked: each consumer needs a new credential.
  - `ops reconcile-credentials` must run for every environment.
  - Session 7's workspace should explain this state, not hide it.
- **The timers on a host:**
  - daily (UTC): `mykey-bao-audit-rotate` 01:15, `mykey-audit-archive` 01:30, `mykey-operations-expire` 02:00, `mykey-backup` 03:00, `mykey-pair-retention` 05:00;
  - `mykey-auth-cleanup` hourly at :15, `mykey-sweep` every 5 minutes, `mykey-egress-refresh` every 5 minutes;
  - `mykey-capture-recover` at boot;
  - the heartbeat every minute (it also writes the capacity record).

  A host without the heartbeat answers 503 to every expanding change.

- **`known-limits.md`** is the honest list. Session 8's review starts from it.
- **Production** runs `host-v0.6.3` closed (a v2 closed record, no OpenBao, no owner, migrations up to `0018`), in the probe as `inService: false`. Bringing it into service is the owner's decision: OpenBao, the owner, `timers`, the R2 credentials, then a report and `gate open`.
- **Checkpoints:**
  - `kms-cert-expiry` (12 Dec 09:57 UTC);
  - `pair-30-day` (17 Dec 19:00 UTC);
  - `.trivyignore.images` (14 Dec);
  - `drill-seal-1` (18 Dec, revoked at the end of the drill).
