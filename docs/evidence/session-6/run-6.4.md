# Run 6.4 — Health, operator status and alerts

**Result: DONE on 17 Nov 2026.** Every one of the fifteen conditions was opened, delivered on the real Telegram channel and resolved on staging (`docs/evidence/session-6/alerts.md`). Decision: D-50 (alerts, readiness and the operator status view).

## What was done

- **Conditions (Task A, P-116, M-4):**
  - nine new conditions in the Worker: `disk_low`, `audit_failing`, `capture_frozen`, `backup_stale`, `certificate_expiring`, `credential_expiring`, `firewall_unloaded`, `unit_failed`, `checks_unknown`;
  - **unknown is not healthy:** a `null` reading never opens and never resolves a condition, and after 180 s it opens `checks_unknown`;
  - heartbeat version 2 is read strictly beside the three old key sets;
  - a `resolved` message that failed is sent again;
  - the certificate threshold is 30 days, or a third of a lifetime of 60 days or less;
  - the Worker gains `POST /v1/test-alert/<host>` and `evaluatedAt` in its state answer.
- **Readiness and the status view (Task B, P-117, M-3):**
  - `/health` is down when an `audit.event` insert (rolled back) or an audited OpenBao call fails, both reused for 15 s;
  - `status.sh` measures the twelve checks, and the heartbeat sends version 2;
  - `operations_unresolved` counts a provisioning operation only after 600 s (`sql/operations-unresolved.sql`);
  - `node scripts/host.ts <host> status [--json]` is the private view: every line has its observation time, and a stale or missing one is `unknown`;
  - the API has no diagnostic route.
- **Drills (Task C):**
  - `tests/staging/alerts.staging.test.ts` holds one drill per condition, announced in the host's journal and undone in `finally`;
  - drill hooks in `/etc/mykey/checks/` exist only while a drill runs;
  - from outside the host: the sink-test Worker with three targets (`probe.ts sinktest up --outside`, `drill-dns up|down`).
- **The watcher (Task D, P-117):**
  - `.github/workflows/probe-watch.yml` runs every 15 minutes with `permissions: {}`;
  - `scripts/probe-watch.ts` sends one Telegram message when the probe has not evaluated for 10 minutes or does not answer.
- **Staging:** API, provisioner and ops images of `c5c037e41946` deployed; `status.sh` and `heartbeat.sh` updated. **Production was not touched** (below).

## Commits

- `a2cead7` feat(probe): nine more conditions; unknown is not healthy
- `c5c037e` feat(hosts): readiness covers audit; one private status view
- `87039db` test(staging): every alert opened, delivered and resolved
- `182fb25` feat(ci): a watcher for the probe itself
- this note, D-50, the runbooks `probe.md`, `operator-status.md` and `kms-and-unseal.md`, the registry

## Commands and results

- **Unit:**
  - the probe suite 80/80; with "unknown as healthy" put back, 11 fail;
  - `tests/unit/ops/status-view.test.ts` 7, `tests/unit/hosts/checks.test.ts` 5, `tests/unit/probe/watch.test.ts` 4.
- **Integration:**
  - `tests/integration/health/readiness.test.ts` 3/3 on a stack with a full audit volume; with the audit probe removed, 2 fail;
  - `unresolved.test.ts` 3/3; with the old query, 1 fails;
  - the api, health and capacity groups 60/60.
- **Staging:**
  - `status.staging.test.ts` 3/3: eight diagnostic paths 404, the proxy's dashboard ports closed, and SSH as the control;
  - `limits.staging.test.ts` (Run 6.3) 2/2 after the deploy;
  - `alerts.staging.test.ts`, every test passed, run one condition at a time. The opened and resolved times below are each the time from cause to delivered message:

| Condition                                                               | Opened    | Resolved     |
| ----------------------------------------------------------------------- | --------- | ------------ |
| `test_alert`                                                            | on demand | —            |
| `certificate_expiring`                                                  | 80 s      | 48 s         |
| `credential_expiring`                                                   | 34 s      | 56 s         |
| `firewall_unloaded`                                                     | 231 s     | 102 s        |
| `unit_failed`                                                           | 289 s     | 53 s         |
| `audit_failing`                                                         | 265 s     | 44 s         |
| `disk_low`                                                              | 294 s     | 105 s        |
| `backup_stale`                                                          | 54 s      | 56 s         |
| `checks_unknown`                                                        | 282 s     | 47 s         |
| `heartbeat_missing`                                                     | 177 s     | 50 s         |
| `health_failing`                                                        | 225 s     | 39 s         |
| `openbao_sealed`                                                        | 270 s     | 45 s         |
| `kms_unreachable`                                                       | 296 s     | 50 s         |
| `capture_frozen`                                                        | 634 s     | 111 s        |
| `operations_unresolved`                                                 | 49 s      | 54 s         |
| `review_open` (Session 3 drill, `provisioning.staging -t AC-1.09`, 1/1) | 21:31:26  | 21:32:26 UTC |

- **Outside the host** (sink-test Worker, AC-1.25):
  - a name that does not resolve: `health_failing` 612 s after the deploy;
  - a name of our zone that points at staging but is not in its certificate: 612 s after the deploy;
  - staging with its API stopped: 213 s after the API stopped.
- **The watcher** (`scripts/probe-watch.ts`, run locally with the three values):
  - before: silent, exit 0;
  - the probe deployed with `--no-cron` at 08:33:57 UTC: Cloudflare kept running the removed cron until about 08:39:30;
  - at 08:45:57 the age was about 390 s, so the watcher stayed silent, rightly;
  - redeployed without a cron at 08:49:09; at 08:50:10 the age was 643 s, and the watcher sent `MyKey probe: not evaluated for 10 min (watcher)` and exited 1;
  - the cron restored at 08:50:16; the probe evaluated again at 08:54:35, with nothing open.
- **Afterwards:** staging and the probe are clean: nothing open, `/health` up.
- `pnpm run check` green.

## Deviations and decisions

- **Graces.** The states that can flap (sealed, kms, `disk_low`, `audit_failing`, `firewall_unloaded`, `unit_failed`) wait 180 s. The thresholds that are already a time open at once.
- **No D1 migration:** `evaluatedAt` is `host_state.updated_at`, written by every evaluation and by nothing else.
- **A stale heartbeat freezes every reported condition**, `checks_unknown` included. An old-shape heartbeat never opens `checks_unknown` (the deploy window).
- **Both heartbeat shapes were proven on the real Worker**, since the sink-test Worker has no route. The Worker was deployed first and accepted the hosts' old beats; version 2 is live since Task B.
- **The audited OpenBao call** is a metadata read of a path no environment can hold. `lookup-self` answers 403 for inline AppRole (P-110 named it).
- **The containers line** is bad only for a restarting, dead or paused container. Stopped one-shot jobs (migrations, setup) are normal.
- **Drill hooks.** `firewall_unloaded` uses a flag: a drill never flushes the ruleset. `certificate_expiring` adds an entry and forges no certificate. `backup_stale` overrides the newest-pair time, because staging holds a pair from 16 Nov 2026 07:23.
- **`checks_unknown`:** the cause is `openssl` shadowed in the heartbeat unit's PATH. The plan said `jq`, but without `jq` no heartbeat is built at all.
  - The stub lives under `/var/lib/mykey`, because `/run` is mounted `noexec` on the hosts; the first attempt found the real `openssl`.
- **`openbao_sealed`:** sealed through `sys/seal` with the custody root token, and unsealed by a restart.
  - The first attempt, cutting the KMS and restarting OpenBao, left OpenBao's listener silent. The host then reported `sealed: null`, and the probe opened `checks_unknown` and `kms_unreachable`. That is the rule working, so it is recorded in `alerts.md` as a finding.
  - `kms_unreachable` is drilled on its own, with the KMS blocked for 420 s while OpenBao runs.
- **`operations_unresolved`:** a synthetic uncertain operation, of an action no sweep knows, is inserted and deleted by the drill. The drills of Sessions 4 and 5 are stale against Run 6.3's limits (open issues).
- **KMS certificate lifetime:** `okms x509 sign --validity` signs a CSR with a domain key as our own CA. It does not issue the KMS's access certificates, and the console offers 30 days only. The threshold follows that lifetime (D-50, `kms-and-unseal.md`).
- **Cron changes apply minutes late, both ways.** A removed cron kept running for about 5½ minutes, and a restored one started 4 to 8 minutes late. A probe deploy that touches the crons can therefore leave a gap of several minutes without evaluation. Recorded in `probe.md`; the watcher's 10-minute threshold is above that gap.
- **Production:** its `status.sh` and `heartbeat.sh` are still the Session 5 versions, sending the old heartbeat shape, which the Worker reads. Updating them is a production deploy, which needs the owner's permission. It is deferred to the gate (Run 6.11) with the API image.
- **Watcher secrets:** `PROBE_READ_TOKEN`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` were set by the owner from stdin (17 Nov 2026 08:18–08:19 UTC). The agent's `gh secret set` was refused by the permission classifier.

## Registry

- FR-1.57 SPIKE_PASS
- FR-1.62 SPIKE_PASS
- FR-1.63 SPIKE_PASS
- FR-1.95 SPIKE_PASS
- AC-1.18 SPIKE_PASS
- AC-1.23 SPIKE_PASS
- AC-1.25 SPIKE_PASS
- AC-1.49 SPIKE_PASS
- PO-23 SPIKE_PASS
- PO-14 SPIKE_PASS (keeps the status; this note is new evidence)

## Open issues

- **The watcher's scheduled run.** GitHub runs a schedule only from the default branch, so the first run on Actions comes after the merge. Then run `gh workflow run probe-watch` once and see a green run (Run 6.11).
- **Two staging drills are stale.** `credentials.staging.test.ts` ("the drill") and `reconcile.staging.test.ts` (the uncertainty drill) now meet Run 6.3's limits: issuance at 5 a minute, sign-in at 5 a minute. They fail before their fault and need their pacing rewritten. They were the evidence of Runs 4.5 and 5.2, and Run 6.11's full staging run will meet them.
- **`credential_expiring` and short credentials.** A credential issued for under 7 days is "expiring" from its first minute, so a CI credential of hours keeps the condition open. The likely rule is a fraction of the lifetime, as for certificates. It is not changed here (Session 8 review, or a ruling at the gate).
- **Production** still runs the Session 5 host scripts (above).
