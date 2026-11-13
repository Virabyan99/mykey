# Probe runbook

The off-host probe is the Cloudflare Worker `mykey-probe` at `https://mykey-probe.nomikey.com` (D-22). Every minute it fetches `https://<host>/health` of both servers, and both servers send it a heartbeat every minute. Alerts go to the owner's Telegram chat.

## What an alert means

Every message reads `MyKey <host>: <condition> <opened|reminder|resolved> (since <UTC time>)`. An open condition is repeated every hour (`reminder`) and announced once when it ends (`resolved`).

| Condition           | Meaning                                                                                                                                                                                                       | First look                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `heartbeat_missing` | No heartbeat from the host for more than 3 minutes. The host is down, cut off, or its heartbeat timer stopped.                                                                                                | `ping 10.77.x.1`; `node scripts/host.ts <host> status`; if SSH does not answer: `docs/runbooks/network.md`, break-glass. |
| `health_failing`    | `/health` has not answered `200 {"status":"up"}` for 3 minutes, from outside.                                                                                                                                 | `curl -s https://<hostname>/health`; `status` → containers; `docker logs mykey-edge-1` / `mykey-api-1` on the host.      |
| `openbao_sealed`    | The host reported OpenBao sealed for 3 minutes (from Run 2.7 on).                                                                                                                                             | `status` → `sealed`, `sealType`; the unseal procedure of Run 2.7.                                                        |
| `kms_unreachable`   | The host reported the KMS unreachable for 3 minutes (from Run 2.7 on). OpenBao may still be serving.                                                                                                          | `status` → `kmsReachable`; `mykey-egress.sh counts` → set `kms`.                                                         |
| `review_open`       | The last heartbeat counted an organization, project or environment in `needs_review` (Run 3.8; no grace). It opens at once and resolves when the count is back to 0; `null` (not readable) is not this alert. | `status` → `reviewOpen`, `provisioner`; `docs/runbooks/provisioning.md` (what review means, how to reconcile).           |

## Planned work

There is no silence switch. An alert that opens during planned work is expected; it resolves when the work is finished. Keep planned outages short.

## Operating the probe

```sh
node scripts/probe.ts state staging     # the probe's view: last heartbeat, open conditions, last 20 alerts
node scripts/probe.ts deploy            # after a change in workers/probe/
node scripts/probe.ts secrets           # new heartbeat and read tokens; reinstalls the host files and timers
```

- Heartbeat on a host: `systemctl status mykey-heartbeat.timer`; one beat by hand: `sudo systemctl start mykey-heartbeat.service`. The URL and token are in `/etc/mykey/secrets/heartbeat/curl.conf` (root only); never print it.
- The host may reach the probe's addresses only through the egress set `probe`. A new or changed address needs `sudo /opt/mykey/hosts/firewall/mykey-egress.sh refresh`; a resolver that cached "no such name" before the domain existed needs `sudo resolvectl flush-caches` first (seen on production in Run 2.6).
- The Worker's state is in the D1 database `mykey-probe` (tables `heartbeat`, `host_state`, `alert_log`).

## Drills

`tests/staging/probe.staging.test.ts` runs them: a staging blackout (`mykey-egress.sh blackout 480`: a timer that ends it is armed first; the drop starts 5 s later and includes the VPN; a reboot also ends it), a stopped `edge` container with a scheduled restart, and a sink that fails. Never run a blackout on production.

## Known gap

Nobody notices when the Worker itself stops (D-22, Run 6.4).
