# Limits

Written in Run 6.3 (P-113 – P-115, D-49). This runbook lists every limit of the API: where it is enforced, what the caller sees, and what the operator sees. The numbers live in `packages/contracts/src/limits.ts` (Doc 06 §11); no other file repeats them.

## Rate limits

Windows are 60 seconds, cut from the epoch on database time, shared by every API process (`app.rate_limit`).

| Limit                                     | A minute | Counted for                                                        | Caller sees                                                                                              | Operator sees                                                            |
| ----------------------------------------- | -------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Requests from one source                  | 300      | the source address (the edge's `X-Forwarded-For` hop only)         | `429 rate_limited`, `retry-after`, `connection: close`; the body is not read                             | log `rate_limited { scope: "rl:source" }`                                |
| Requests of one session                   | 120      | the session; not counted on credential revocation and the archives | `429 rate_limited`, `retry-after`                                                                        | log `rl:session`                                                         |
| Requests of one machine credential        | 60       | the credential                                                     | `429 rate_limited`, `retry-after`                                                                        | log `rl:credential`                                                      |
| Reveals                                   | 30       | the person                                                         | `429`                                                                                                    | log `rl:reveal`                                                          |
| Import preview, apply and resume together | 5        | the person                                                         | `429`                                                                                                    | log `rl:import`                                                          |
| Exports                                   | 5        | the person                                                         | `429`                                                                                                    | log `rl:export`                                                          |
| Credential issuance                       | 5        | the person                                                         | `429`                                                                                                    | log `rl:issue`                                                           |
| Machine tokens nobody can attribute       | 30       | the source address                                                 | the 31st and every later machine request of that source in the window: `429`, with no request to OpenBao | log `rl:machine-miss`; `machine_unauthenticated { cause }` for each miss |
| Sign-in attempts, failures, locks         | as D-28  | source and account                                                 | `429` or the delayed refusal of the auth module                                                          | unchanged since Session 3                                                |

- **The price of the miss rule:** once a source has sent 30 tokens nobody can attribute in a minute, every machine request from that source is refused until the window ends, a valid credential's included. Clients behind one NAT share that fate. The answer says how many seconds remain (`retry-after`).
- **A counter that cannot be written** (the database refuses, is full or is gone) makes every request `503 dependency_unavailable`. No limit is skipped.
- **Clearing a counter by hand** is never needed: a window ends by itself within 60 s. `ops reset-account` clears an account's sign-in locks (runbook `operator-accounts.md`).

## Runtime and automation credentials (Session 11, D-83)

These are not in Doc 06 §11. The numbers are `LIMITS.runtimeCredential`, `LIMITS.automationCredential` and two entries of `LIMITS.rate`.

| Limit                                      | Value                                                                             | Caller sees                               |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------- |
| A runtime credential's lifetime            | at most 365 days, which is the default                                            | `422 validation_failed` for a longer one  |
| The token one exchange gives               | 15 minutes, never renewed                                                         | the token's `expiresAt`                   |
| An automation credential's lifetime        | 1 hour to 365 days, 7 days by default                                             | `422 validation_failed` outside the range |
| Source networks a credential is bound to   | at most 8; an automation credential at least 1                                    | `422 validation_failed`                   |
| Exchanges of one runtime credential        | 10 a minute                                                                       | `429 rate_limited`, `retry-after`         |
| Requests of one automation credential      | 120 a minute                                                                      | `429 rate_limited`, `retry-after`         |
| Secrets nobody can attribute (either kind) | 30 a minute per source, shared with the row "Machine tokens nobody can attribute" | `429`                                     |

- Both kinds are marked "expiring soon" 7 days before their expiry, as a 30-day token is.
- **The exchange's limits are enforced since Run 11.3:** 10 exchanges a minute for each runtime credential, and the miss rule for a client secret nobody can attribute. A bearer that is not of the client secret's shape costs no read and is not counted.
- **The automation credential's limit is enforced from Run 11.5.** Until then every route of that class answers `404`.

## Concurrency

| Limit                                                                           | Where                                                                     | Caller sees                                              | Operator sees                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 64 requests in flight per API process                                           | first step after the request id                                           | `503 busy`, `connection: close`                          | the request log line, status 503                                                 |
| 2 large requests per process (`import.*`, `export.create`, `machine.resolve`)   | after authentication and the session or credential limit, before the body | `503 busy`; the body is drained                          | status 503                                                                       |
| One `machine.keys` or `machine.resolve` at a time per credential, every process | the read's lock connection, before the environment's lock                 | `503 busy` at once                                       | status 503                                                                       |
| A request must arrive whole within 30 s, its headers within 10 s                | Node's server                                                             | the connection is closed (`408`)                         | nothing                                                                          |
| A writer waits 2 s for an environment's lock                                    | the secret and import writes                                              | `503 busy`                                               | status 503                                                                       |
| Read cool-down 1.5 s after each complete read of an environment                 | the next complete read of it waits it out; writers do not                 | a slower back-to-back read                               | nothing                                                                          |
| PostgreSQL connections: an API process 20, the provisioner 6, an ops command 4  | the pools                                                                 | `503 dependency_unavailable` when a pool times out (2 s) | `tests/unit/contracts/pools.test.ts` keeps the sum under `max_connections` (100) |

**Instances started together.** The cool-down and the two large slots admit about two complete reads of one environment every 1.6 s; the others get `503 busy` at once and ask again. The CLI asks ten times over 13.75 s from `0.2.0` (five times over 3.75 s before), which starts ten instances of one environment, the slowest after about 10 s (D-83, measured in Run 11.3).

A back-to-back reader of one large environment can still make a person's write wait: the measured worst case is three attempts 1 s apart (6.4 s locally). A write that answers `busy` is safe to send again with the same `Idempotency-Key`.

## Disk pressure

`status.sh` writes `/etc/mykey/gate/capacity.json` every minute (heartbeat timer). The record names five volumes:

- `postgres`, `openbao` and `bao-audit` (the Docker volumes);
- `docker` (the Docker root);
- `bao-rotated` (`/var/lib/mykey/bao-audit/rotated`).

A volume is low when it has any of: free bytes under 15 % of its size, free bytes under 4 GiB, or free inodes under 10 %.

| Record                                           | Expanding mutations                       | Revocation, archive, sign-in, sign-out | Reads  |
| ------------------------------------------------ | ----------------------------------------- | -------------------------------------- | ------ |
| `ok`, at most 180 s old                          | served                                    | served                                 | served |
| `low`                                            | `507 capacity_exceeded { limit: "disk" }` | served                                 | served |
| missing, unreadable, invalid or older than 180 s | `503 dependency_unavailable`              | served                                 | served |

- **Expanding mutations:**
  - project and environment create, rename and reactivate;
  - every secret write;
  - the imports;
  - credential issuance;
  - reset completion;
  - password change, TOTP enrolment and activation, recovery-code regeneration.
- **What the operator does when `low`:**
  - read the record: `sudo jq . /etc/mykey/gate/capacity.json`;
  - free space on the named volume. A rotated OpenBao file that never shipped sits in `/var/lib/mykey/bao-audit/rotated` (runbook `audit.md`); Docker images that are no longer used take room under the Docker root (`docker image prune` in a maintenance window).

  The next minute's record lifts the refusal by itself.

- **When the record is not renewed** (the heartbeat timer stopped, `jq` or `df` broke): `systemctl status mykey-heartbeat.timer`. Run 6.4 raises `disk_low` and a stale record as alerts.
- **Real exhaustion without a record:** the audit insert fails, and reads and writes answer `503`. No value leaves without its audit row.
