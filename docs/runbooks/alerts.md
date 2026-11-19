# Alerts — one section per condition

The probe (`probe.md`, D-22, D-50) opens and resolves these fifteen conditions and sends each change to the owner's Telegram chat as `MyKey <host>: <condition> opened|resolved`. Every condition was seen to fire and resolve on staging (`docs/evidence/session-6/alerts.md`). `tests/unit/runbooks/alerts.test.ts` keeps this file equal to the probe's `CONDITIONS`.

Two rules hold for every section:

- **Unknown is never healthy.** An open condition stays open while its check is unknown (`checks_unknown`).
- **When in doubt, close the gate.** `host.ts <host> gate close` stops every change and keeps reads off. Open it again only through a report (`service-gate.md`).

`<host>` is `staging` or `prod`. Every command runs from the workstation with the VPN up; in Git Bash, prefix `MSYS_NO_PATHCONV=1`.

## heartbeat_missing

### Means

No heartbeat from the host for more than 3 minutes. The host is down or cut off, or its heartbeat timer stopped.

### Check

```sh
ping -c 3 10.77.2.1                                   # staging's VPN address (production: 10.77.1.1)
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status
node scripts/probe.ts state <host>                    # the probe's last heartbeat
```

If SSH does not answer, use the break-glass path of `network.md`.

### Fix

- Timer stopped: `sudo systemctl enable --now mykey-heartbeat.timer` on the host.
- Egress to the probe blocked: `mykey-egress.sh counts` (set `probe`), then `refresh`.
- Host down: reboot it from the OVHcloud console; after a reboot check `sealed` and the gate. If `sealed` reads `unknown`, OpenBao's container did not start: `node scripts/host.ts <host> up` starts it (Session 7 gate).

### Confirm

`MyKey <host>: heartbeat_missing resolved` arrives, and `node scripts/probe.ts state <host>` shows a `lastHeartbeatAt` under a minute old.

## health_failing

### Means

`/health` has not answered `200 {"status":"up"}` for 3 minutes, seen from outside. A closed gate is `down` on purpose (silent while the host is `inService: false`).

### Check

```sh
curl -s https://<hostname>/health
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # containers, gate, sealed
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> gate status
```

On the host: `docker logs --tail 50 mykey-api-1` and `mykey-edge-1`. A `startup_refused` line names the missing setting (for example `MYKEY_BUILD` or `MYKEY_BACKEND_INCARNATION`).

### Fix

- A container stopped: `host.ts <host> up`.
- The gate closed by a deploy or a restore: finish it (`deploy.md`, `restore.md`).
- OpenBao sealed: `openbao_sealed` below.
- The certificate expired at the edge: `network.md` (public certificate).

### Confirm

`health_failing resolved`; `curl -s https://<hostname>/health` answers `{"status":"up"}`.

## openbao_sealed

### Means

The host reported OpenBao sealed for 3 minutes. Every secret read and write answers 503.

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # sealed, sealType, kmsReachable
```

### Fix

The KMS seal unseals at start: restart OpenBao on the host (`sudo docker restart mykey-openbao-1`). If it stays sealed, the KMS is unreachable or the certificate was refused. Continue with `kms_unreachable` and `kms-and-unseal.md`. Never use the recovery key to unseal; it does not unseal a KMS seal.

### Confirm

`openbao_sealed resolved`; `status` shows `sealed false`.

## kms_unreachable

### Means

The host reported the KMS unreachable for 3 minutes. A running OpenBao keeps serving; a restart would wait and stay sealed.

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # kmsReachable
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> kms staging-seal-2 -- kmip locate --details
```

On the host: `sudo /opt/mykey/hosts/firewall/mykey-egress.sh counts` (set `kms`).

### Fix

- **Egress set empty:** `mykey-egress.sh refresh`.
- **Certificate expired or revoked:** replace it (`kms-and-unseal.md`).
- **OVHcloud KMS down:** wait. **Do not restart OpenBao** meanwhile.

### Confirm

`kms_unreachable resolved`; `status` shows `kmsReachable true`.

## review_open

### Means

The last heartbeat counted an organization, project or environment in `needs_review`. It opens at once (no grace).

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # reviewOpen
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops verify-organization --organization <id>
```

### Fix

The reconciliation of `provisioning.md`: what review means for each object, and the command that settles it. A policy that differs after a release is reconciled as `deploy.md` says.

### Confirm

`review_open resolved`; `status` shows `reviewOpen 0`.

## operations_unresolved

### Means

An unresolved secret operation: `uncertain` and not closed, or stale. It opens at once.

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # operationsUnresolved
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops operations --organization <id>
```

### Fix

`reconciliation.md`: each unresolved operation is settled from the backend's evidence with `ops reconcile-operation --operation <id>`.

### Confirm

`operations_unresolved resolved`; `status` shows `operationsUnresolved 0`.

## disk_low

### Means

A volume is under its threshold for 3 minutes: free bytes under 15 % or 4 GiB, or free inodes under 10 %. Expanding changes already answer `507 capacity_exceeded`.

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # checks.diskLow
```

On the host: `sudo jq . /etc/mykey/gate/capacity.json` names the volume.

### Fix

`limits.md` (disk): rotate and archive the OpenBao audit file, prune unused images (`docker image prune`), never delete a volume. Close the gate if the database volume is the one that is low.

### Confirm

`disk_low resolved`; `capacity.json` shows `"state": "ok"`.

## audit_failing

### Means

The API's last `health_down` named audit, OpenBao's audit directory takes no byte, an archive unit failed, or the archive is more than 48 h behind.

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # checks.auditFailing
```

On the host: `systemctl status mykey-audit-archive.service mykey-bao-audit-rotate.service`.

### Fix

`audit.md`: run the failed unit by hand, read its journal, settle the segment that stopped it. While OpenBao cannot write its audit, it refuses requests: free the disk first.

### Confirm

`audit_failing resolved`; the unit's last run succeeded.

## capture_frozen

### Means

A backup capture has run for more than 600 s. Writes answer `busy` meanwhile.

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # checks.captureSince
```

On the host: `journalctl -u mykey-backup -n 50`.

### Fix

`backup.md` (a capture that stops): let `mykey-capture-recover` end it, or end it by hand as that runbook says. Never leave the control row in `draining`.

### Confirm

`capture_frozen resolved`; `status` shows no `captureSince`.

## backup_stale

### Means

Backups are expected (`MYKEY_BACKUP_EXPECTED=yes`) and the newest eligible pair is older than 26 h, or there is none. It is silent on a host not in service.

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # checks.backup
```

On the host: `journalctl -u mykey-backup -n 80`.

### Fix

`backup.md`: the last capture's error names its step. Run `systemctl start mykey-backup` once the cause is fixed.

### Confirm

`backup_stale resolved`; the newest pair is `eligible`.

## certificate_expiring

### Means

A certificate is within its threshold: 30 days, or a third of the life of a certificate that lives 60 days or less (a 30-day KMS certificate: 10 days). The message names no certificate.

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # checks.certificates
```

### Fix

- **KMS certificate:** replace it (`kms-and-unseal.md`, "Replace a certificate"). The owner issues it from a new CSR.
- **Edge certificate:** see `network.md` (public certificate).

### Confirm

`certificate_expiring resolved`; `checks.certificates` lists nothing within its threshold.

## credential_expiring

### Means

An active machine credential expires within 7 days. It opens at once.

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # checks.credentialExpiring
```

### Fix

Issue a new credential for the consumer, deliver it, and revoke the old one (`machine-credentials.md`). A test's short credential is revoked by the test that made it.

### Confirm

`credential_expiring resolved`; `checks.credentialExpiring` is 0.

## firewall_unloaded

### Means

Table `inet mykey` has not been loaded for 3 minutes. The host is open to more than it should be.

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # firewall
```

On the host: `sudo nft list table inet mykey`.

### Fix

`network.md`: `host.ts <host> apply firewall`, then `confirm` from a new connection. Never reboot with a revert pending.

### Confirm

`firewall_unloaded resolved`; `status` shows `firewall loaded`.

## unit_failed

### Means

A `mykey-*` systemd unit failed, for 3 minutes.

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # checks.unitsFailed names the units
```

On the host: `systemctl status <unit>`, `journalctl -u <unit> -n 50`.

### Fix

The unit's runbook: `backup.md`, `audit.md`, `limits.md`, `probe.md` (heartbeat), `reconciliation.md` (sweep). After the fix, `systemctl reset-failed <unit>` and run it once with `systemctl start`.

### Confirm

`unit_failed resolved`; `checks.unitsFailed` is empty.

## checks_unknown

### Means

A check of the heartbeat has been unknown for more than 3 minutes. Unknown is never healthy: any condition that check feeds stays open.

### Check

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> status          # the "unknown" line names the check
```

On the host: `sudo /opt/mykey/hosts/checks/status.sh | jq .checks`.

### Fix

Make the check readable again: the tool it calls (`openssl`, `jq`, `docker`), the file it reads, or OpenBao's listener (`sealed: null` while OpenBao waits for the KMS at start: see `kms_unreachable`).

### Confirm

`checks_unknown resolved`; `status` has no `unknown` line.
