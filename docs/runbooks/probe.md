# Probe runbook

The off-host probe is the Cloudflare Worker `mykey-probe` at `https://mykey-probe.nomikey.com` (D-22). Every minute it fetches `https://<host>/health` of both servers, and both servers send it a heartbeat every minute. Alerts go to the owner's Telegram chat.

## What an alert means

Every message reads `MyKey <host>: <condition> <opened|reminder|resolved> (since <UTC time>)`. An open condition is repeated every hour (`reminder`) and announced once when it ends (`resolved`).

| Condition               | Meaning                                                                                                                                                                                                       | First look                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `heartbeat_missing`     | No heartbeat from the host for more than 3 minutes. The host is down, cut off, or its heartbeat timer stopped.                                                                                                | `ping 10.77.x.1`; `node scripts/host.ts <host> status`; if SSH does not answer: `docs/runbooks/network.md`, break-glass.             |
| `health_failing`        | `/health` has not answered `200 {"status":"up"}` for 3 minutes, from outside.                                                                                                                                 | `curl -s https://<hostname>/health`; `status` → containers; `docker logs mykey-edge-1` / `mykey-api-1` on the host.                  |
| `openbao_sealed`        | The host reported OpenBao sealed for 3 minutes (from Run 2.7 on).                                                                                                                                             | `status` → `sealed`, `sealType`; the unseal procedure of Run 2.7.                                                                    |
| `kms_unreachable`       | The host reported the KMS unreachable for 3 minutes (from Run 2.7 on). OpenBao may still be serving.                                                                                                          | `status` → `kmsReachable`; `mykey-egress.sh counts` → set `kms`.                                                                     |
| `review_open`           | The last heartbeat counted an organization, project or environment in `needs_review` (Run 3.8; no grace). It opens at once and resolves when the count is back to 0; `null` (not readable) is not this alert. | `status` → `reviewOpen`, `provisioner`; `docs/runbooks/provisioning.md` (what review means, how to reconcile).                       |
| `operations_unresolved` | The last heartbeat counted an unresolved secret operation: uncertain and not closed, or stale (Run 4.5; no grace). Same rules as `review_open`.                                                               | `status` → `operationsUnresolved`; `docs/runbooks/reconciliation.md`.                                                                |
| `disk_low`              | A volume is under its threshold: free bytes under 15 % or 4 GiB, or free inodes under 10 % (Run 6.3's capacity record; 3 minutes). Expanding mutations already answer 507.                                    | `status` → `checks.diskLow`; `sudo jq . /etc/mykey/gate/capacity.json`; runbook `limits.md`.                                         |
| `audit_failing`         | The API's last `health_down` named audit, OpenBao's audit directory takes no byte, an archive unit failed, or the archive is more than 48 h behind (3 minutes).                                               | `status` → `checks.auditFailing`; `systemctl status mykey-audit-archive.service mykey-bao-audit-rotate.service`; runbook `audit.md`. |
| `capture_frozen`        | A backup capture has run for more than 600 s (no grace). Writes answer `busy` meanwhile.                                                                                                                      | `status` → `checks.captureSince`; runbook `backup.md` (Run 6.5).                                                                     |
| `backup_stale`          | Backups are expected (`MYKEY_BACKUP_EXPECTED=yes`) and the newest eligible capture is older than 26 h or absent (no grace). Silent on a host not in service.                                                  | `status` → `checks.backup`; `journalctl -u mykey-backup`.                                                                            |
| `certificate_expiring`  | A certificate is within its threshold: 30 days, or a third of the life of a certificate that lives 60 days or less (a 30-day KMS certificate: 10 days). The message names no certificate.                     | `status` → `checks.certificates`; runbook `kms-and-unseal.md` (replace a certificate).                                               |
| `credential_expiring`   | An active machine credential expires within 7 days (no grace).                                                                                                                                                | The workspace's credential list; issue a new credential and revoke the old one (runbook `machine-credentials.md`).                   |
| `firewall_unloaded`     | Table `inet mykey` is not loaded (3 minutes).                                                                                                                                                                 | `status` → `firewall`; `sudo nft list table inet mykey`; runbook `network.md`.                                                       |
| `unit_failed`           | A `mykey-*` systemd unit failed (3 minutes).                                                                                                                                                                  | `status` → `checks.unitsFailed`; `systemctl status <unit>`, `journalctl -u <unit>`.                                                  |
| `checks_unknown`        | A check of the heartbeat has been unknown for more than 3 minutes. Unknown is never healthy: an open condition stays open while its check is unknown.                                                         | `status` → the `unknown` line; `sudo /opt/mykey/hosts/checks/status.sh \| jq .checks` on the host.                                   |

Since Run 6.4 (D-50) a `null` reading is **unknown**, never healthy: it neither opens nor resolves a condition. A `resolved` message that could not be delivered is sent again at the next evaluation.

## Planned work

There is no silence switch for planned work. An alert that opens during planned work is expected; it resolves when the work is finished. Keep planned outages short.

## A host not in service yet

A host that is deliberately not serving carries `"inService": false` in `HOSTS` (`workers/probe/wrangler.jsonc`). Production has it since 16 Nov 2026: its gate is closed on purpose and it has no OpenBao, so its `/health` answers down.

- **What changes:** `health_failing` never opens for such a host, and an open one is closed without a message. A "resolved" message would claim the host is healthy.
- **What still alerts:** every other condition, `heartbeat_missing` included.
- **Before it existed:** production's `health_failing` repeated every hour from 13 to 16 Nov 2026.

When the host is brought into service, remove the flag (or set it to `true`) and run `node scripts/probe.ts deploy`. If `/health` is still failing then, `health_failing` opens at once with one message.

## Operating the probe

```sh
node scripts/probe.ts state staging     # the probe's view: last heartbeat, open conditions, last 20 alerts
node scripts/probe.ts deploy            # after a change in workers/probe/
node scripts/probe.ts secrets           # new heartbeat and read tokens; reinstalls the host files and timers
node scripts/probe.ts alert-test staging   # sends `MyKey staging: test_alert` through the Worker's sink and logs it
node scripts/host.ts staging status     # the private status view (runbook operator-status.md)
```

- Heartbeat on a host: `systemctl status mykey-heartbeat.timer`; one beat by hand: `sudo systemctl start mykey-heartbeat.service`. The URL and token are in `/etc/mykey/secrets/heartbeat/curl.conf` (root only); never print it.
- The host may reach the probe's addresses only through the egress set `probe`. A new or changed address needs `sudo /opt/mykey/hosts/firewall/mykey-egress.sh refresh`; a resolver that cached "no such name" before the domain existed needs `sudo resolvectl flush-caches` first (seen on production in Run 2.6).
- The Worker's state is in the D1 database `mykey-probe` (tables `heartbeat`, `host_state`, `alert_log`).

## Drills

`tests/staging/alerts.staging.test.ts` (Run 6.4) drills every condition, one test each, with `-t <condition>`; its lines are in `docs/evidence/session-6/alerts.md`. Drill hooks live in `/etc/mykey/checks/` and exist only while a drill runs. `tests/staging/probe.staging.test.ts` runs the Session 2 drills: a staging blackout (`mykey-egress.sh blackout 480`: a timer that ends it is armed first; the drop starts 5 s later and includes the VPN; a reboot also ends it), a stopped `edge` container with a scheduled restart, and a sink that fails. Never run a blackout on production.

## Who watches the Worker

`.github/workflows/probe-watch.yml` runs every 15 minutes and reads `GET /v1/state/staging`. It sends one Telegram message, `MyKey probe: …(watcher)`, when the probe has not evaluated for 10 minutes or does not answer, and the run turns red (GitHub mails the owner).

- **Secrets:** repository secrets `PROBE_READ_TOKEN`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Set them from stdin; a value never appears on a command line:

  ```sh
  tr -d '\r\n' < ~/.mykey/secrets/probe/read-token | gh secret set PROBE_READ_TOKEN
  tr -d '\r\n' < ~/.mykey/secrets/alerts/telegram-bot-token | gh secret set TELEGRAM_BOT_TOKEN
  tr -d '\r\n' < ~/.mykey/secrets/alerts/telegram-chat-id | gh secret set TELEGRAM_CHAT_ID
  ```

- **Run by hand:** `gh workflow run probe-watch`.
- **A deploy that changes the crons** takes effect minutes late, both ways (Run 6.4: a removed cron ran 5½ minutes on, a restored one started 4 to 8 minutes late). `probe.ts deploy --no-cron` stops the evaluation; only use it for a drill, and expect the watcher to speak.
- **Locally:** `node scripts/probe-watch.ts` with the three values in its environment.
- **Limits:**
  - a scheduled run can start late;
  - GitHub pauses schedules after 60 days without activity in the repository;
  - the workflow runs only from the default branch.
