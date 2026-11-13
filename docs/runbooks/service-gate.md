# Service gate

The API on a host serves requests only while its **gate record** says `open` and names that host. The record is a small root-owned file, read by the API for every request. Decision: D-26 (P-43). Run 3.1.

## Where it is

| Item                 | Place                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Record on the host   | `/etc/mykey/gate/gate.json`, `root:root`, mode `0644`                                                 |
| In the API container | `/run/mykey/gate/gate.json`, the directory mounted read-only                                          |
| Host identity        | `MYKEY_HOST_INSTANCE_ID` in `/etc/mykey/host.env`, written once by `host.ts <host> up`, never changed |

Record v1 (strict, at most 4,096 bytes):

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
MSYS_NO_PATHCONV=1 node scripts/host.ts staging gate status   # prints the record, or "no gate record (closed)"
MSYS_NO_PATHCONV=1 node scripts/host.ts staging gate open     # writes a new record, epoch + 1
MSYS_NO_PATHCONV=1 node scripts/host.ts staging gate close
```

`open` and `close` write `gate.json.tmp` beside the record, fsync it, rename it over the record and fsync the directory: the API reads either the old or the new record, never half of one. The next request after the command sees the change; no restart is involved. `host.ts <host> status` reports `"gate": "open" | "closed" | "absent" | "invalid"`.

## Every deploy starts closed

`host.ts up` creates `/etc/mykey/gate/` but never writes a record. A host that has never been opened, or whose record was removed, answers:

- `GET /health` → `503 {"status":"down"}`; the API log has `{"event":"health_down","cause":"gate","code":"missing"}`. **The probe alerts** after its grace period: during a deploy window this alert is expected.
- every other request, matched or not → `503` with error code `quarantined` and `Cache-Control: no-store`; the log has `{"event":"gate_closed","cause":"…"}`.

After a deploy is verified (`host.ts <host> status`, migrations applied), open the gate. Production stays closed until a session opens it with the owner's word.

## What closed looks like from outside, and why

The log line `gate_closed` names the cause:

| Cause        | Meaning                                                                            | Fix                                     |
| ------------ | ---------------------------------------------------------------------------------- | --------------------------------------- |
| `missing`    | no record                                                                          | `gate open` (after checking the deploy) |
| `closed`     | the record says closed                                                             | `gate open` when intended               |
| `host`       | the record names another host instance (copied from elsewhere, or a restored disk) | check why, then `gate open` on the host |
| `version`    | a record version this API does not know (v2 arrives in Run 6.7)                    | deploy the matching API, or rewrite     |
| `invalid`    | not a regular file, a symbolic link, over 4,096 bytes, bad JSON or fields          | `gate open` rewrites it                 |
| `unreadable` | the API's user cannot read the file (mode or owner changed)                        | `chmod 0644`, owner `root:root`         |
