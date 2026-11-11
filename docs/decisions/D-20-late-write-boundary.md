# D-20 — Late-write boundary

**Date:** 2026-11-11

**Status:** DECIDED by the executing agent in Run 2.4, on measurements against OpenBao 2.7.2 and PostgreSQL 18.6 (local stack, real sockets, real process death). Evidence: `tests/fault/effects/*.test.ts`, `tests/integration/openbao/client-answers.test.ts`, `docs/evidence/session-2/run-2.4.md`.

**Verdict (G-EFFECT): GO.** No scenario produced a duplicate write or a false `rejected`, and the restart tests showed nothing arriving after a restart. The per-environment boundary holds; the Doc 10 §8.1 fallback (any uncertain effect closes the whole service) is not taken.

## Decision

- **One effect per environment.** An effect slot `env:<environment_id>` is taken in the same transaction as the operation's intent, under the environment's advisory lock, and refused while another operation holds it (`409 state_conflict`). It is released only when the backend has answered definitely (success, check-and-set mismatch, denial, sealed) or when reconciliation settles the operation. An uncertain operation keeps its slot. Twenty executors racing on one secret: one write reaches OpenBao, nineteen are refused with `version_conflict` or `state_conflict`.
- **A committed dispatch marker counts as possibly sent.** From the moment `dispatched_at` is committed, no later absence of evidence makes the operation `rejected` while an executor that could still send it exists.
- **Reconciliation** settles an operation as `succeeded` only when the backend holds a version whose envelope carries the operation id, and as `rejected` only when every executor is excluded, no version carries it and the current version is still the expected one; otherwise it stays `uncertain`. It never changes a terminal operation and always writes a fresh state tag.
- **Exclusion means process death, and a restart when a request may be on its way.** "Executors excluded" is established by killing the executor process; once a request may have left it (any dispatched operation whose fate the backend does not show), OpenBao is also restarted, because nothing else ends a request still on the wire. A heartbeat that stops never lets another worker take over.
- **The client never calls a possibly-applied change a failure** (ruling R8): for a write, soft delete, undelete, token issuance or revocation, a 5xx other than 503 or a 2xx whose body cannot be read is `unknown/unclear_answer`, like a timeout or a connection lost after the handshake.

## Measured on OpenBao 2.7.2

| What                                                                                           | Observed                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A request held on the wire after the TLS handshake, released after 3 / 8 / 9.5 s               | lands, at +3.2 / +8.2 / +9.7 s                                                                                                         |
| The same, held 11 / 15 / 25 / 32 s                                                             | never lands; OpenBao closes the connection at **10.1 s** and the client sees `unknown/connection_lost`                                 |
| A 60 kB write whose headers arrive at once and whose body is held 5 s                          | lands                                                                                                                                  |
| The same, body held 20 / 28 / 35 / 50 s                                                        | never lands; the connection is closed at **10.2 s**                                                                                    |
| An answer delayed 8 s, client deadline 5 s                                                     | the client reports `uncertain`; the write was already applied; reconciliation finds it                                                 |
| Executor killed, OpenBao stopped and started while a request was held (8 s hold)               | nothing lands (polled 30 s); `rejected` after exclusion                                                                                |
| OpenBao paused, the write sent (connection accepted by the kernel), OpenBao killed and started | nothing lands (polled 30 s); `rejected`                                                                                                |
| A write already processed, its answer held; OpenBao stopped and started                        | the version is there; `succeeded`; the count stays the same for 30 s                                                                   |
| Thirty concurrent writes of one new key; ten concurrent soft deletes or undeletes              | one write applied, 29 `cas_mismatch`; deletes and undeletes all answer 200; no 500 on the data path (Run 2.1's 500 was on `kv/config`) |

So on 2.7.2 with its default listener settings, **no request lands more than about 10 seconds after its connection began**, and **none lands after a restart**. A connection that breaks after the request left can still have been applied (`client-answers.test.ts` shows such a write in the backend).

## `default_max_request_duration`

Not exercised: a KV write is processed in milliseconds once it has arrived, so the 90 s default (source reading) never came into play; what bounds lateness is the listener's read timeouts. For the staging and production configuration of Run 2.7: set `default_max_request_duration = "15s"` and the listener's `http_read_header_timeout = "10s"` and `http_read_timeout = "30s"` explicitly, so the bound measured here does not depend on defaults. This is defence in depth; the restart remains the only proof that nothing is in flight.

## Not exercised by this spike

Soft delete, undelete, token issuance, token revocation, provisioning and archive have no operation marker inside OpenBao: reconciliation cannot look for an envelope. They are proven in Runs 4.6 (soft delete, undelete), 5.2 (issuance), 5.3 (revocation) and 3.8 (provisioning, archive).

## Findings for later runs

- **Who records a reconciliation (Run 4.5).** The reconciler runs as `maintenance`, which has no `INSERT` on `audit.event`; this spike's reconciliation writes no audit event.
- **The fault harness.** Fault injection uses a TLS-aware TCP relay in the test process (`tests/harness/tls-relay.ts`, ruling R46) instead of Toxiproxy: Toxiproxy's latency applies to every chunk including the TLS handshake, so "answer delayed past the deadline" never delivered the request and "request held after the connection is established" could not be expressed. Real sockets and real process death stay (P-27).

## Cost if wrong

If a request could land later than measured, an operation reconciled as `rejected` could gain a version afterwards. The maintenance procedure guards against that by restarting OpenBao before any `rejected` (the restart tests), and the 10 s bound is only defence in depth; Run 8.3 re-measures on the release configuration.
