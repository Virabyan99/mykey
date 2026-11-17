# D-54 — Gate record v2: bound to host, incarnation, release and a report

**Date:** 2026-11-18

**Status:** DECIDED in Run 6.7 (P-122, P-123; Doc 06 §14; FR-1.67, FR-1.68; replaces the v1 record of D-26). Evidence:

- `docs/evidence/session-6/run-6.7.md`;
- `tests/unit/gate/v2.test.ts`, `tests/integration/restore/{gate,listener}.test.ts`;
- `tests/integration/restore/full.test.ts` (a report, then a change, then `gate open` refused by its own re-check).

## Decision

### The record

```json
{
  "version": 2,
  "state": "open",
  "gateEpoch": 4,
  "hostInstanceId": "<uuid>",
  "backendIncarnation": "<uuid>",
  "origin": { "kind": "restore", "pairId": "<uuid>" },
  "releaseBuild": "45b5c1f3cc3a",
  "reportSha256": "<64 hex>",
  "phase": "serving",
  "writtenAt": "2026-11-18T10:20:30.000Z"
}
```

`origin` is `{ "kind": "fresh_install", "id": <host instance id> }` for a host that was never restored. `reportSha256` is the hash of the verification report that opened it, null on a close.

### What it admits

`readGate(path, expect)` compares the record with what the process is: `MYKEY_HOST_INSTANCE_ID` and `MYKEY_BACKEND_INCARNATION` from `host.env`, `MYKEY_BUILD` from the image.

| Record                                   | Admits         | Cause when not `all`                          |
| ---------------------------------------- | -------------- | --------------------------------------------- |
| `open` + `serving`, all three equal      | `all`          | —                                             |
| `closed` + `verifying`, all three equal  | `verification` | `closed`                                      |
| `closed` + `serving`                     | `none`         | `closed`                                      |
| another host, incarnation or build       | `none`         | `host`, `incarnation`, `build`                |
| a v1 record, absent, unreadable, invalid | `none`         | `version`, `missing`, `unreadable`, `invalid` |

`verification` is served only by the second listener (`MYKEY_VERIFY_LISTEN`, `10.78.2.3:8444` on a host, reached through `host.ts <host> tunnel verify`): every GET, all of `/v1/auth/*` and `secrets.reveal`. Machine routes and every other write answer `quarantined`. The public listener serves nothing but a failing `/health`.

### The incarnation lives in three places

`app.service_control.backend_incarnation` (migration `0018`, written by `maintenance` only), `host.env`, and a KV v2 mount `mykey-meta` with key `incarnation` in each organization's OpenBao namespace (`sys/` is not writable; the root namespace is not the provisioner's). The API compares the database's value with its own at every gate read (reused 5 s): unreadable is cause `unreadable`, never `all`. The provisioner compares its namespace's copy and defers jobs and sweeps with cause `incarnation`.

A restored database carries the old incarnation until the restore gives it a new one; a host not taken through the restore cannot open on it.

### Opening

`mayOpen(report, expect, kind, now)` refuses a report older than 30 minutes or from the future, of another host, incarnation or build, or with a required check missing, `failed` or `unknown` (`REQUIRED_CHECKS.restore` | `.deploy`). `openGate` then runs the cheap checks again itself (`sessions_none`, `machine_accessors_none`, `control_row_idle`, `incarnation_three_places`) and refuses if one is no longer `ok`. It appends `operator.gate_open` before it writes the file; when the audit fails, nothing is written. `closeGate` writes first and audits when it can: closing never waits for PostgreSQL.

### Conversion

A host whose `host.env` has no `MYKEY_BACKEND_INCARNATION` still runs a v1 release: `host.ts gate` keeps the v1 path for it until its first v2 deploy (Run 6.9), which converts it with `gate close`, a report, `gate open`.

## Why

A v1 record named only the host. A restored disk, a copied record or a release that was never verified could all serve. Binding the record to the backend's incarnation and the build, and opening only on a fresh, complete report, makes "open" a statement that someone verified this exact product on this exact data.

## Costs

- Every gate read touches PostgreSQL once per 5 s per process.
- `gate open` needs PostgreSQL and the audit; an outage keeps a closed host closed.
- An import whose gate closes mid-way parks its remaining entries (`not_attempted`) for a resume.
