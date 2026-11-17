# Audit trail

Written in Run 6.1 (P-105 – P-110, D-46); archive and retention in Run 6.2 (P-112, D-48). What MyKey records, who may read it, how it leaves the host, and what an audit outage looks like.

## Two trails

- **The product's trail:** the table `audit.event` in PostgreSQL. One row per security action, written by `appendAudit` (`packages/audit`) in the transaction of the change it records. No row, no action: a row that cannot be written stops the action and the answer is `503 audit_unavailable` (Doc 10 §4.1 rule 8). No row holds a secret value, a token, a password, a code, a link or a path; every action has a strict schema of ids, enums, counts and short patterned strings (`packages/audit/src/events.ts`).
- **OpenBao's trail:** its file audit device (`/openbao/audit/audit.log` in the container). Every request to OpenBao is recorded there with HMAC'd secrets. When the device cannot write, OpenBao refuses the request: a reveal, an export and a machine resolve then answer `503` and no value leaves (`tests/fault/audit/device.test.ts`).

## Scopes (P-106)

Every action has one scope in `AUDIT_SCOPE`, and `appendAudit` refuses an event whose organization does not fit it.

| Scope     | Written                 | Served to                                                                                                                                          |
| --------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant`  | with the organization   | owners and admins of that organization                                                                                                             |
| `account` | without an organization | owners and admins of every organization the row's **subject user** (the actor when it is a user, else the target when it is a user) belongs to now |
| `global`  | without an organization | nobody through the API; the operator reads it with `psql`                                                                                          |

- `access.denied` is `tenant` when the caller is a member of the organization it asked for; a request against an organization the caller does not belong to names none (the hidden 404 must not attribute it) and is then the caller's own account row.
- A row with an anonymous actor and no user target (a failed sign-in for an unknown address) belongs to nobody and is never served.
- Global: the infrastructure — the gate, backups, restores, the audit archive and purge, deployments, `operator.operations_expire`, `operator.auth_cleanup`, `auth.throttled`.

## Reading it

- **Owners and admins:** `GET /v1/organizations/:org/audit` (filters `from`, `to` — RFC 3339, default the last 30 days, at most 92 days apart — `action`, `outcome`, `actorKind`, `actorId`, `projectId`, `environmentId`, `operationId`, `requestId`) and `GET /v1/organizations/:org/activity` (the product's actions with each operation's state now and the current name of its target). Both are keyset pages under an anchor: the first page fixes database time, and rows that arrive later are not in that listing. A cursor is bound to its filters (another filter is `409 listing_changed`); a cursor that does not verify is `400 malformed_request`. A stored row whose details fail its schema is served with `details: {}` and logged `output_invalid` with its id.
- **The operator, global rows included:** as `maintenance` through the tunnel, for example
  `MSYS_NO_PATHCONV=1 node scripts/host.ts staging maint 10 -- psql -c "SELECT occurred_at, action, outcome FROM audit.event WHERE organization_id IS NULL ORDER BY occurred_at DESC LIMIT 50"`.
  `maintenance` may read and insert audit rows; deletion is for retention only (Run 6.2). The runtime roles may not update, delete or truncate the table (`tests/integration/audit/diagnostics.test.ts`).

## What is recorded

Requests refused before a principal is known (401, malformed requests, origin, quarantine, rate limits) are log lines, not rows (FR-1.81); only `auth.throttled` and `access.denied` are rows. Reads of metadata (lists, history, operation status, the reference, the activity signal) write nothing. The list below is generated from `AUDIT_COVERAGE` (`packages/audit/src/coverage.ts`) by `pnpm run audit:coverage`; a unit test fails when it differs.

<!-- coverage:start -->

### Routes of the route table

- `health.get`: nothing — public and unauthenticated; refusals here are log lines only (FR-1.81)
- `version.get`: nothing — public and unauthenticated; refusals here are log lines only (FR-1.81)
- `organizations.list`: nothing — a read of metadata; FR-1.56 does not list it and a row per read buries the trail
- `projects.list`: nothing — a read of metadata; FR-1.56 does not list it and a row per read buries the trail
- `projects.create`: `project.create`, `access.denied`
- `projects.rename`: `project.rename`, `access.denied`
- `projects.archive`: `project.archive`, `access.denied`
- `projects.reactivate`: `project.reactivate`, `access.denied`
- `environments.list`: nothing — a read of metadata; FR-1.56 does not list it and a row per read buries the trail
- `environments.create`: `environment.create`, `access.denied`
- `environments.rename`: `environment.rename`, `access.denied`
- `environments.archive`: `environment.archive`, `access.denied`
- `environments.reactivate`: `environment.reactivate`, `access.denied`
- `secrets.list`: `access.denied`
- `secrets.history`: `access.denied`
- `secrets.reveal`: `secret.reveal`, `system.drift_detected`, `access.denied`
- `secrets.create`: `secret.create`, `system.drift_detected`, `access.denied`
- `secrets.update`: `secret.update`, `system.drift_detected`, `access.denied`
- `secrets.delete`: `secret.delete`, `system.drift_detected`, `access.denied`
- `secrets.undelete`: `secret.undelete`, `system.drift_detected`, `access.denied`
- `secrets.restore`: `secret.restore`, `system.drift_detected`, `access.denied`
- `import.preview`: `import.preview`, `access.denied`
- `import.apply`: `import.apply`, `secret.create`, `secret.update`, `access.denied`
- `import.resume`: `import.resume`, `secret.create`, `secret.update`, `access.denied`
- `export.create`: `secret.export`, `system.drift_detected`, `access.denied`
- `credentials.list`: `access.denied`
- `credentials.issue`: `credential.issue`, `system.drift_detected`, `access.denied`
- `credentials.revoke`: `credential.revoke`, `access.denied`
- `operations.get`: `access.denied`
- `operations.list`: `access.denied`
- `audit.list`: `access.denied`
- `activity.list`: `access.denied`
- `overview.get`: `access.denied`
- `credentials.summary`: `access.denied`
- `metrics.get`: `access.denied`
- `session.activity`: nothing — the activity signal of a session; it changes no authority
- `auth.reset.complete`: `auth.reset_complete`, `auth.reset_failed`, `auth.throttled`
- `reference.get`: nothing — serves the API reference; documentation, not a product action
- `openapi.get`: nothing — serves the API reference; documentation, not a product action
- `machine.keys`: `machine.keys`, `system.drift_detected`, `access.denied`
- `machine.resolve`: `machine.resolve`, `system.drift_detected`, `access.denied`

### Paths of the auth module

- `POST /v1/auth/sign-in/email`: `auth.sign_in`, `auth.throttled`
- `POST /v1/auth/sign-out`: `auth.sign_out`
- `GET /v1/auth/get-session`: nothing — reads the caller's own session; it changes nothing
- `POST /v1/auth/revoke-sessions`: `auth.session_revoke`
- `POST /v1/auth/change-password`: `auth.password_change`, `auth.throttled`
- `GET /v1/auth/sessions`: nothing — lists the caller's own sessions; it changes nothing
- `POST /v1/auth/sessions/revoke`: `auth.session_revoke`
- `POST /v1/auth/totp/enroll`: `auth.totp_enroll`, `auth.throttled`
- `POST /v1/auth/totp/activate`: `auth.totp_activate`, `auth.throttled`
- `POST /v1/auth/totp/verify`: `auth.mfa_complete`, `auth.throttled`
- `POST /v1/auth/totp/step-up`: `auth.step_up`, `auth.throttled`
- `POST /v1/auth/recovery/verify`: `auth.mfa_complete`, `auth.throttled`
- `POST /v1/auth/recovery/regenerate`: `auth.recovery_regenerate`, `auth.throttled`

### Operator commands and host tooling

- `bootstrap-owner`: `operator.bootstrap`
- `auth-cleanup`: `operator.auth_cleanup`
- `reset-account`: `operator.reset_initiate`
- `provision-organization`: `operator.organization_provision`
- `verify-organization`: nothing — compares the organization with OpenBao and prints it; reads only
- `operations-expire`: `operator.operations_expire`
- `operations`: nothing — lists an organization's unresolved operations; reads only
- `reconcile-operation`: `operator.reconcile_operation`
- `reconcile-environment`: `operator.reconcile_environment`
- `reconcile-credentials`: `operator.reconcile_credentials`
- `audit-archive`: `system.audit_archive`, `system.audit_purge`
- `capture`: `system.backup_capture`, `system.backup_invalidated`
- `pair`: `system.backup_eligible`, `system.backup_invalidated`, `system.backup_cleanup`
- `restore-invalidate`: `operator.restore_begin`, `operator.restore_invalidate`
- `restore-verify`: `operator.restore_verify`
- `sweep`: `system.operation_stuck`
- `deploy-verify`: `operator.deploy`
- `restore`: nothing — drives restore-invalidate; audits through it
- `verify-journey`: nothing — HTTP requests to the listener; each is audited by its route
- `host gate`: `operator.gate_open`, `operator.gate_close`
- `host deploy`: `operator.deploy`

### Timers of the API and the provisioner

- `api/operation-sweep`: `system.operation_stuck`, `secret.create`, `project.archive`, `environment.archive`
- `api/outbox-dispatcher`: nothing — hands committed jobs to the queue; the job audits its effect
- `api/throttle-sweep`: nothing — removes expired sessions and old rate counters; neither changes authority
- `api/health`: nothing — a deadline on one health probe; not a recurring job
- `provisioner/worker`: `system.environment_provision`, `system.drift_detected`

<!-- coverage:end -->

## Archive and retention (Run 6.2, D-48)

- **Every night on each host:** `mykey-bao-audit-rotate.timer` (01:15 UTC) rotates OpenBao's file, and `mykey-audit-archive.timer` (01:30 UTC) runs `ops-run.sh audit-archive -- audit-archive` in the ops image. Both catch up after a boot (`Persistent=true`). Status: `systemctl status mykey-audit-archive.service`; the journal holds counts only.
- **What lands in R2** (bucket `mykey-audit-archive`, under `<host>/`):
  - `app/<yyyy>/<mm>/segment-<sequence>.ndjson.gz` with its `.manifest.json`, one per closed UTC day, plus a supplementary segment for rows committed late;
  - `openbao/…/segment-<sequence>.log.gz`, one per rotated file.

  The lock rules are `prod/` 365 days, `staging/` 30 days and `probe/` 600 s.

- **The chain:** `SELECT sequence, stream, from_at, row_count, verified_at, purged_at FROM audit.archive_segment ORDER BY sequence DESC LIMIT 20;` as `maintenance`. `verified_at` is set only after the object and its manifest were read back and compared.
- **A failed run** (exit 1) leaves what it did. Read the reason in `journalctl -u mykey-audit-archive.service`:
  - `chain is broken`: a row of `audit.archive_segment` was changed by hand. Compare it with its manifest in R2 and repair the row; never delete an object.
  - `reads back differently`: R2 or the network changed bytes. Run the job again; a segment that cannot be rebuilt as recorded stops it again, and the operator decides.
  - `fewer rows than archived`: rows left `audit.event` outside the purge. This is an incident.
  - A rotated file that is never shipped stays in `/var/lib/mykey/bao-audit/rotated/`. Nothing is deleted before it is verified.
- **Retention:** the job calls `audit.purge_archived(now − 365 days)`. Only whole days whose segments are all verified, and whose row count equals the archived rows, are removed. Each call writes `system.audit_purge { rows, intervals }`. Nobody can `DELETE`, `UPDATE` or `TRUNCATE` `audit.event` directly; the function is the only way.
- **By hand, once:** on the host, `sudo systemctl start mykey-bao-audit-rotate.service` and then `sudo systemctl start mykey-audit-archive.service` (each returns when its run has ended).
- **Install on a host:**
  - `host.ts <host> image ops <tar>`;
  - `host.ts <host> ops-secrets`;
  - `host.ts <host> r2-install audit-archive`;
  - `host.ts <host> push`;
  - `host.ts <host> timers`.

## What an outage looks like

- **PostgreSQL cannot take the row** (disk full, the table locked, a grant missing): the action answers `503 audit_unavailable` and has not happened. A sign-out keeps the session; a reveal sends no value. Find the cause in the PostgreSQL log; nothing needs replaying.
- **OpenBao's device cannot write** (its volume full): every request to OpenBao fails, so reads of values, issuance, revocation and every write answer `503` (`dependency_unavailable`, or `backend_sealed` when sealed). A machine request is not answered `401`: a token is called dead only when OpenBao says so with a 4xx. Free the volume; the same requests succeed without a restart.
- From Run 6.4 `/health` is down when either probe fails, and the probe raises `audit_failing`.

## Logs

The API writes one JSON line per entry of a closed list. Before a line is written, keys with a denied name are redacted and every string must fit its field's format (an id, a time, an enum, a route pattern, a class name, addresses); anything else is written as `[invalid]` (`apps/api/src/log.ts`, P-109). The request id is the API's own; an incoming `x-request-id` is neither used nor logged.
