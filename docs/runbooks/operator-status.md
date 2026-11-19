# Operator status

Written in Run 6.4 (P-117, D-50, FR-1.95, AC-1.49). The private status view of a host: what the host itself measures (`status.sh`) and what the off-host probe sees, each check with the time it was observed. It runs over the VPN; the API has no diagnostic route.

## The command

```sh
node scripts/host.ts staging status          # one line per check
node scripts/host.ts staging status --json   # { status, probe, lines } for scripts
```

Each line reads `state  check  value  (observed <UTC time>)`. The state is one of:

- **`ok`**: observed in the last 180 s, and healthy;
- **`bad`**: observed in the last 180 s, and not healthy;
- **`unknown`**: not observed, or observed more than 180 s ago. **Unknown is never healthy.** Find out why before anything else.

## Every line

| Check                                | Value                                                                                                                                        | Bad when                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `host`, `bootId`, `time`             | which host, which boot, when `status.sh` ran                                                                                                 | —                                                                    |
| `clockOffsetMs`                      | host clock against the workstation (includes about half the SSH set-up)                                                                      | —                                                                    |
| `clockSynced`, `chronyOffsetMs`      | chrony's own view                                                                                                                            | not synchronised                                                     |
| `containers`                         | running and stopped containers                                                                                                               | one is restarting, dead or paused (stopped one-shot jobs are normal) |
| `sealed`, `sealType`                 | OpenBao's own answer                                                                                                                         | sealed                                                               |
| `kmsReachable`                       | a TLS handshake to the KMS with the seal certificate, independent of OpenBao                                                                 | unreachable                                                          |
| `pendingRevert`                      | firewall or SSH changes waiting for `confirm`                                                                                                | any                                                                  |
| `firewall`                           | table `inet mykey` and its address sets                                                                                                      | not loaded                                                           |
| `sshListen`                          | how many SSH listeners (addresses are not printed)                                                                                           | —                                                                    |
| `gate`                               | the service gate record                                                                                                                      | not `open`                                                           |
| `reviewOpen`, `operationsUnresolved` | counts (runbooks `provisioning.md`, `reconciliation.md`)                                                                                     | above 0                                                              |
| `provisioner`                        | the container's health                                                                                                                       | unhealthy                                                            |
| `checks.*`                           | the twelve checks the heartbeat sends (D-50)                                                                                                 | below                                                                |
| `checks.diskLow`                     | from the capacity record (runbook `limits.md`)                                                                                               | low                                                                  |
| `checks.auditFailing`                | the API's last `health_down` named audit, the audit directory takes no byte, an archive unit failed, or the archive is more than 48 h behind | failing                                                              |
| `checks.captureSince`                | `idle`, or since when a capture runs                                                                                                         | running more than 600 s                                              |
| `checks.backup`                      | expected or not, the newest eligible capture                                                                                                 | expected and older than 26 h, or none                                |
| `checks.certificates`                | each certificate and its expiry: public, internal PKI, KMS client                                                                            | one within its threshold (30 days, or a third of a short life)       |
| `checks.credentialExpiring`          | active credentials within 7 days of expiry                                                                                                   | above 0                                                              |
| `checks.unitsFailed`                 | failed `mykey-*` units                                                                                                                       | any                                                                  |
| `probe.evaluatedAt`                  | when the Worker last evaluated the host                                                                                                      | more than 180 s ago: `unknown`                                       |
| `probe.heartbeat`                    | when the Worker last received a heartbeat                                                                                                    | more than 180 s ago                                                  |
| `probe.open`                         | the conditions open now                                                                                                                      | any                                                                  |

## What to do first

- **A host line is `unknown`:** `status.sh` ran more than 180 s ago or could not measure. Run the command again. If it stays, SSH to the host and run `sudo /opt/mykey/hosts/checks/status.sh | jq .checks`: a `null` names the check that cannot be read.
- **A `probe.*` line is `unknown`:** the Worker does not answer or has not evaluated. Check `node scripts/probe.ts state <host>` and the `probe-watch` workflow (runbook `probe.md`).
- **A `bad` line:** the runbook its alert names (runbook `probe.md`, "What an alert means").
- **Never** paste the `--json` output into an issue or a chat without reading it: it holds container ids, host names and dates, nothing secret, but it is the host's inventory.
