# D-50 — Alerts, readiness and the operator status view

**Date:** 2026-11-16

**Status:** DECIDED in Run 6.4 (P-116, P-117; M-3, M-4; D-22's open points). Evidence:

- `docs/evidence/session-6/run-6.4.md`, `docs/evidence/session-6/alerts.md`;
- `tests/unit/probe/{evaluate,evaluate-v2,heartbeat,format,watch}.test.ts`, `tests/unit/ops/status-view.test.ts`, `tests/unit/hosts/checks.test.ts`;
- `tests/integration/health/{readiness,unresolved}.test.ts`;
- `tests/staging/{alerts,status}.staging.test.ts`.

## Decision

### Readiness

`GET /health` is down when any of these fails:

- `SELECT 1` as the runtime role;
- OpenBao's `sys/health`, where the host has OpenBao;
- **an audit row:** one fixed row inserted into `audit.event` as the runtime role and rolled back. It leaves no row;
- **an audited OpenBao call:** the runtime identity reads the metadata of a path no environment can hold (`p/0…/e/0…/HEALTH_PROBE`). The 404 is an audited answer, and OpenBao refuses the request when its audit device cannot write. `lookup-self` is not usable: inline AppRole holds no token, and OpenBao answers 403.

The last two are reused for 15 s. The body stays exactly `{"status":"up"}` or `{"status":"down"}`, with the same headers either way. The cause (`audit_unwritable`, `openbao_audit`) is in the API's log only.

### Heartbeat version 2

`{ v: 2, bootId, observedAt, checks }` holds twelve checks:

- **From before:** `sealed`, `kmsReachable`, `reviewOpen`, `operationsUnresolved`.
- **New:** `firewallLoaded`, `diskLow`, `auditFailing`, `captureSince`, `backup`, `certificates`, `credentialExpiring`, `unitsFailed`.

`null` is unknown. `captureSince` distinguishes three things: a time (a capture is running), `null` (idle), and absent (unknown).

**Deploy order:** the Worker first, then the hosts. The Worker reads the three old key sets and version 2 strictly, so neither order stops the heartbeats.

### Conditions

There are fifteen. A reading of a condition is bad, good or **unknown**:

- **Unknown is not healthy (M-4).** It never opens a condition and never resolves one; an open condition stays open and keeps its reminders.
- **`checks_unknown`** opens when a check of a version 2 heartbeat stays unknown for longer than the reported grace (180 s). The old shapes cannot report the new checks and never open it.
- **A stale heartbeat freezes every reported condition.** `heartbeat_missing` says what is known.

| Condition                              | Bad when                                                                                                                                                                         | Grace |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `heartbeat_missing`, `health_failing`  | as in D-22                                                                                                                                                                       | 180 s |
| `openbao_sealed`, `kms_unreachable`    | as in D-22                                                                                                                                                                       | 180 s |
| `disk_low`                             | the capacity record (D-49) says low                                                                                                                                              | 180 s |
| `audit_failing`                        | the API's last `health_down` named audit, the audit directory takes no byte, an archive unit failed, or the oldest closed day not archived and verified ended more than 48 h ago | 180 s |
| `firewall_unloaded`                    | table `inet mykey` is not loaded                                                                                                                                                 | 180 s |
| `unit_failed`                          | a `mykey-*` unit is failed                                                                                                                                                       | 180 s |
| `review_open`, `operations_unresolved` | a count above 0                                                                                                                                                                  | none  |
| `credential_expiring`                  | an `active` credential within 7 days of its expiry                                                                                                                               | none  |
| `certificate_expiring`                 | a certificate within its threshold (below)                                                                                                                                       | none  |
| `capture_frozen`                       | a capture running for more than 600 s                                                                                                                                            | none  |
| `backup_stale`                         | backups are expected, and the newest eligible capture is older than 93,600 s or absent                                                                                           | none  |
| `checks_unknown`                       | a check unknown for longer than 180 s                                                                                                                                            | —     |

- **Graces:** the states that can flap wait 180 s. Thresholds that are already a time open at once.
- **Certificate threshold (P-116):** 30 days for a certificate that lives longer than 60 days, and a third of its lifetime otherwise. A console KMS certificate lives 30 days: under "≤ 30 days" it would be in alarm from its first hour. The threshold therefore opens at 10 days left. The deviation is forced by the provider.
- **`inService: false`** silences `health_failing` and `backup_stale` only.
- **`operations_unresolved` (M-3)** counts a provisioning operation (`environment.provision`, `organization.provision`) only once it is older than the job queue's 600 s.
- **A `resolved` message that could not be delivered** is asked for again at the next evaluation, until it is delivered or the condition opens again (D-22's open point).
- **The message text** names host, condition, kind and time only: no certificate, path, address or token.

### The operator status view

`node scripts/host.ts <host> status [--json]` runs over the VPN. It prints one line per check of the host's report and of the probe's state, each with its observation time:

- a line observed more than 180 s ago, or not observed, is `unknown`;
- no line holds a secret path, a token or an address.

The API has no diagnostic route and gets none: the owner's session gets 404 for `/status`, `/v1/status`, `/v1/operator/status`, `/metrics`, `/debug`, `/dashboard/`, `/api/rawdata` and `/v1/health/details`. The proxy has no dashboard port.

### On demand and who watches the Worker

- **On demand:** `POST /v1/test-alert/<host>` (read token) sends `MyKey <host>: test_alert` and logs its row. `GET /v1/state/<host>` gains `evaluatedAt`, which is `host_state.updated_at`: written by every evaluation and by nothing else, so no D1 migration.
- **The watcher:** `.github/workflows/probe-watch.yml` runs every 15 minutes with `permissions: {}`, on the pinned Node with no install step. It reads the state route and sends one Telegram message when `evaluatedAt` is older than 10 minutes or the route does not answer. A red run is a second signal, since GitHub mails the owner. Its three values are repository secrets.
- **Stated limits:**
  - GitHub may start a scheduled run late, so the worst-case notice is about 25 minutes plus GitHub's delay;
  - schedules pause after 60 days without activity in the repository;
  - schedules run only from the default branch.

### Drill hooks

`/etc/mykey/checks/` exists only while a drill runs:

- `firewall-unloaded`: the ruleset is never flushed in a drill;
- `certificates.extra.json`: no certificate is forged;
- `backup-newest.override`: staging holds a recent pair.

`status.sh` reads each hook beside the real reading, which unit tests cover.

### KMS certificate lifetime

`okms x509 sign --validity` signs a CSR with a domain key acting as our own CA. It does not issue the KMS's access certificates. Those come from the OKMS service, and its console offers 30 days only. Thirty days stays the lifetime, and the threshold above follows it.

## Alternatives rejected

- **Treating `null` as healthy (the Session 2–4 rule).** A broken check would clear a real alert (M-4).
- **"≤ 30 days" for every certificate.** It is always open for the KMS certificate, and an alert that is always open is no alert.
- **A diagnostic route in the API.** It would be a surface on the public name; the view runs over the VPN instead.
- **A second Worker watching the first.** It shares the failure domain (account, platform, deploy). A scheduled workflow is the one independent party the agents can set up.
- **`lookup-self` as the audited OpenBao call.** Inline AppRole has no token to look up.
