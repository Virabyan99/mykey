# Service gate

The API on a host serves requests only while its **gate record** says `open` and names that host, its backend incarnation and its release. The record is a small root-owned file, read by the API for every request. Decisions: D-26 (v1, Run 3.1) and D-54 (v2, Run 6.7).

## Where it is

| Item                 | Place                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Record on the host   | `/etc/mykey/gate/gate.json`, `root:root`, mode `0644`                                                                                                            |
| In the API container | `/run/mykey/gate/gate.json`, the directory mounted read-only                                                                                                     |
| Host identity        | `MYKEY_HOST_INSTANCE_ID` in `/etc/mykey/host.env`, written by `host.ts <host> up`; a restore writes a new one                                                    |
| Backend incarnation  | `MYKEY_BACKEND_INCARNATION` in `host.env`, `app.service_control.backend_incarnation`, and `mykey-meta/incarnation` in each organization's OpenBao namespace (v2) |
| Release              | `MYKEY_BUILD`, baked into the image                                                                                                                              |

Record v2 (Run 6.7, D-54; strict, at most 4,096 bytes):

```json
{
  "version": 2,
  "state": "open",
  "gateEpoch": 4,
  "hostInstanceId": "<uuid>",
  "backendIncarnation": "<uuid>",
  "origin": { "kind": "fresh_install", "id": "<uuid>" },
  "releaseBuild": "45b5c1f3cc3a",
  "reportSha256": "<64 hex>",
  "phase": "serving",
  "writtenAt": "2026-11-18T10:20:30.000Z"
}
```

`open` + `serving` with host, incarnation and build equal admits every route. `closed` + `verifying` with the three equal lets the **verification listener** (`10.78.2.3:8444`, reached with `host.ts <host> tunnel verify`) serve reads, sign-in and reveal while the public listener stays quarantined. A v1 record is `none` to a v2 API.

Record v1 (until a host's first v2 deploy; `deploy` converts it, `deploy.md`):

```json
{
  "version": 1,
  "state": "open",
  "gateEpoch": 3,
  "hostInstanceId": "<uuid>",
  "writtenAt": "2026-11-12T16:10:00.000Z"
}
```

## Commands

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts staging gate status                      # prints the record, or "no gate record (closed)"
MSYS_NO_PATHCONV=1 node scripts/host.ts staging gate open --report <report.json> # v2: opens with a deploy report, epoch + 1
MSYS_NO_PATHCONV=1 node scripts/host.ts staging gate close [--verifying]         # --verifying lets the verification listener serve
MSYS_NO_PATHCONV=1 node scripts/host.ts staging gate open                        # v1 only: a host.env without MYKEY_BACKEND_INCARNATION
```

`gate open --report` takes a **deploy report only** (`deploy-report.json`); a restore report is refused and opens only through `host.ts <host> restore-verify … --open`. It refuses a report older than 30 minutes, of another host, incarnation or build, or with a required check missing, `failed` or `unknown`; it then runs the four store checks of the report again itself (the schema revision the report saw, OpenBao readable, the incarnation in three places, the control row idle), and a check that is not `ok` now refuses (Run 8.0, P-147). `restore-verify --open` re-checks the restore's own four (sessions, accessors, the control row, the incarnation). It appends `operator.gate_open` before writing and writes nothing when the audit fails. `gate close` writes first and audits when PostgreSQL answers. After a restore, `host.ts <host> restore-verify … --open` does the opening (`restore.md`).

`open` and `close` write `gate.json.tmp` beside the record, fsync it, rename it over the record and fsync the directory: the API reads either the old or the new record, never half of one. The next request after the command sees the change; no restart is involved. `host.ts <host> status` reports `"gate": "open" | "closed" | "absent" | "invalid"`.

## Every deploy starts closed

`host.ts up` creates `/etc/mykey/gate/` but never writes a record. A host that has never been opened, or whose record was removed, answers:

- `GET /health` → `503 {"status":"down"}`; the API log has `{"event":"health_down","cause":"gate","code":"missing"}`. **The probe alerts** after its grace period: during a deploy window this alert is expected.
- every other request, matched or not → `503` with error code `quarantined` and `Cache-Control: no-store`; the log has `{"event":"gate_closed","cause":"…"}`.

Since Run 6.9 a deploy is `host.ts <host> deploy --release <dir>` (`deploy.md`, D-57): it closes the gate itself (v2: `verifying`), migrates, starts, runs the owner's journey through the verification listener, writes the deploy report and opens with it. A deploy that stops leaves the gate closed. Production stays closed (`--stay-closed`) until a session opens it with the owner's word.

## What closed looks like from outside, and why

The log line `gate_closed` names the cause:

| Cause         | Meaning                                                                                                             | Fix                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `missing`     | no record                                                                                                           | `gate open` (after checking the deploy)      |
| `closed`      | the record says closed                                                                                              | `gate open` when intended                    |
| `host`        | the record names another host instance (copied from elsewhere, or a restored disk)                                  | check why, then `gate open` on the host      |
| `incarnation` | the record's or the database's incarnation is not the process's (a restored database not taken through the restore) | `restore.md`; never edit `host.env` to match |
| `build`       | the record was opened for another release                                                                           | a report for this release, then `gate open`  |
| `version`     | a v1 record read by a v2 API                                                                                        | `gate close`, a report, `gate open`          |
| `invalid`     | not a regular file, a symbolic link, over 4,096 bytes, bad JSON or fields                                           | `gate open` rewrites it                      |
| `unreadable`  | the API's user cannot read the file (mode or owner changed)                                                         | `chmod 0644`, owner `root:root`              |
