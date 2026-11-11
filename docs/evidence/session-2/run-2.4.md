# Run 2.4 — Late-write and exclusion spike

**Result: DONE on 11 Nov 2026.** On OpenBao 2.7.2 and PostgreSQL 18.6 (local stack), a throw-away executor that writes one secret per operation (Doc 06 §6.2) was killed with SIGKILL at each of its four boundaries, raced twenty times against itself, delayed on the wire in both directions, and taken through the maintenance procedure of Doc 06 §6.4 with OpenBao stopped, paused and killed. No scenario produced a duplicate write or a false `rejected`, and nothing arrived after a restart. On 2.7.2's default listener settings no request landed more than about 10 seconds after its connection began. The G-EFFECT verdict is GO (D-20).

PO-16 SPIKE_PASS — delayed effects, replay and exclusion proven on OpenBao 2.7.2 (local stack, real process death, real sockets): one write per environment at a time, a dispatched operation never reported `rejected` while a request may still arrive, reconciliation by the operation id inside the stored envelope, a replay answered from the row without a backend request, and a restart that makes the backend state final (`tests/fault/effects/*.test.ts`). Run 8.3 closes it on the release configuration.

## What was done

- **Client (carried from Run 2.1, R8).** `unknown/unclear_answer` for a change that gets a 5xx other than 503 or an unreadable 2xx; tests through a TLS stub and through a relay that breaks the connection after the request left (the write was applied) or holds it past the deadline.
- **Harness.** `tests/harness/tls-relay.ts`: a TCP relay that reads TLS record boundaries without decrypting, with `delayRequests`, `delayRequestTail`, `delayResponses`, `clear`, and `drop` / `hold` modes (R46). `pauseService`, `killService`, `serviceRunning` in `stack.ts`; `prepareDatabase` accepts a suite's own stack.
- **Spike** (`packages/operations/src/spike/`, exported as `@mykey/operations/spike`, marked throw-away): `executor.ts` (replay lookup, advisory lock, intent with effect slot, dispatch marker, one `kvWrite`, read-back, finalize guarded by the executor's boot id), `reconcile.ts` (as `maintenance` with an operator token), `runner.ts` (the executor as a child process).
- **Tests** (`tests/fault/effects/`): `boundaries` (relay check and the four boundaries), `exclusion` (twenty racing executors, two environments, slot uniqueness, boot id), `late-write` (delayed answer, late landing, no premature `rejected`, the two observed bounds), `maintenance` (own stack: restart ends a held request, a paused-then-killed server, a write already inside OpenBao). Every scenario ends with the three checks: no duplicate (audited `kv/data` requests per operation), no false failure, an index that tells the truth or says `needs_review`. The organization, project and environment rows of the OpenBao fixture are inserted by the suite's fixture (R2).
- **D-20.**

## Commits

- f56189a fix(openbao): an unclear answer to a change is unknown, not invalid
- 3fecb37 style(tests): lint and format of the client answer tests
- this commit: test(operations): late-write and exclusion spike with real process death and network delay (early PO-16)

## Commands and results

| Command                                                                                                             | Exit    | Proof line                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run --project integration tests/integration/openbao/client-answers.test.ts` before R8             | 1       | `expected { kind: 'invalid' } to deeply equal { kind: 'unknown' }` (unreadable 2xx, 500)                        |
| same, after R8                                                                                                      | 0       | 6/6                                                                                                             |
| `pnpm exec vitest run --project integration tests/integration/openbao`                                              | 0       | 42/42                                                                                                           |
| `pnpm exec vitest run --project integration tests/fault/effects`, three times in a row                              | 0, 0, 0 | 16/16 each (177 s, 179 s, 180 s)                                                                                |
| `tests/fault/effects/maintenance.test.ts`, first run                                                                | 1       | `backend metadata: invalid`: the operator client kept OpenBao's old port after the restart (harness fixed, R48) |
| `boundaries.test.ts` with the reconciler rejecting an undispatched operation without exclusion (mutation, reverted) | 1       | `after the intent: … rejected only once executors are excluded` failed                                          |
| held-request probe (throw-away): request released after 3 / 8 / 9.5 / 11 / 15 / 25 / 32 s                           | —       | landed after 3.2 / 8.2 / 9.7 s; the others never; connection closed by OpenBao at 10.1 s                        |
| held-body probe (throw-away): 60 kB write, body released after 5 / 20 / 28 / 35 / 50 s                              | —       | landed after 5 s; the others never; connection closed at 10.2 s                                                 |
| `late-write.test.ts -t "large write"` (added after the three runs)                                                  | 0       | 1/1                                                                                                             |
| `pnpm run check`                                                                                                    | 0       | —                                                                                                               |

## Deviations and decisions

- **R46 — a TLS-aware relay instead of Toxiproxy.** Toxiproxy's latency toxic delays every chunk, the TLS handshake included: with an answer delay longer than the client's deadline the handshake never finished and the request never reached OpenBao, so the plan's "delayed answer" scenario could not happen, and "request held after the connection is established" could not be expressed. The relay is test code in the test process; no Toxiproxy image is pinned and the Compose file has no `fault` profile. The suites that do not restart OpenBao run on the shared stack.
- **R47 — the late-write hold is 8 s, not 12 s.** OpenBao 2.7.2 closes a connection whose request has not fully arrived about 10 s after the handshake, so a request held 12 s never lands. The late-write scenarios use 8 s (it lands at about 8.2 s, after the client and a second executor have given up waiting), and two tests pin the bound with 15 s holds of the whole request and of a large body.
- **R48 — the operator client is created per use** in the fault fixture, because OpenBao comes back on another published port after a restart.
- **The maintenance "restart ends a held request" case** holds the request 8 s (inside the bound) so that the restart, not the server's timeout, is what ends it; the executor child is killed 2 s after dispatch and OpenBao is stopped before the 8 s are up.
- **The paused-server case** sends the write while OpenBao is paused: the kernel accepts the TCP connection, the TLS handshake cannot complete, so no request reaches OpenBao before it is killed.
- **Reconciled rejections** carry `error_code = state_conflict`; the index row returns to the expected version, or is removed when the expected version was 0.
- **No real 500 on the data path.** Run 2.1's 500 "transaction commit failed" came from concurrent `kv/config` writes; concurrent data writes, soft deletes and undeletes never answered 500 here, so R8's 5xx branch is tested with the stub only.
- **`default_max_request_duration` not exercised**: KV writes are processed in milliseconds. D-20 recommends explicit listener timeouts and `"15s"` for Run 2.7.
- The registry is not edited in this run (ruling R6).

## Open issues

- The reconciler writes no audit event: `maintenance` has no `INSERT` on `audit.event` (Run 4.5 decides which identity records reconciliation).
- Effects without an operation marker inside OpenBao (soft delete, undelete, issuance, revocation, provisioning, archive) are not covered here (Runs 4.6, 5.2, 5.3, 3.8).
- The spike opens one PostgreSQL pool per write for the advisory lock; Run 4.2 replaces it.

Verdict: GO
