# Run 6.3 — Limits and overload

**Result: DONE locally on 16 Nov 2026.** `tests/staging/limits.staging.test.ts` is committed and **not yet run**: it needs the API of this run on staging, which Run 6.4's deploy brings (plan, Task C step 4). Decision: D-49 (limits, concurrency and disk pressure).

## What was done

- **Rate limits (Task A, P-113).** These are pipeline steps on the counters of D-28.
  - **Limits a minute:** source 300, session 120, credential 60, reveal 30, the three import routes together 5, export 5, issuance 5, machine misses per source 30.
  - **Where:** the source step is the first after the gate, before anything of the request is read, and covers the auth module and unmatched paths. The class limits count per person.
  - **Answers:** `429 rate_limited` with `retry-after`, and a log line `rate_limited { scope }`; a counter that cannot be written is `503 dependency_unavailable`.
  - **New values:** two, in `LIMITS.rate`.
- **Concurrency (Task B, P-114):**
  - an in-flight gate of 64 per process;
  - the large routes authenticate, apply their session or credential limit and take their slot before the body, and a refusal before the body drains it;
  - `requestTimeout` 30 s and `headersTimeout` 10 s, checked every second;
  - pools from `LIMITS.db`;
  - one machine read at a time per credential;
  - an archive reuses one issuer session for 45 s;
  - after measuring starvation, a fairness rule: a 1.5 s read cool-down.
- **Disk pressure (Task C, P-115):**
  - **The record:** the schema, the thresholds and the two sets of mutations are in `@mykey/contracts`. `capacity_exceeded` joins nine route error lists, and `disk` joins the limits its details may name.
  - **Reading it:** `readCapacity` is in `@mykey/operations`. The API checks every expanding mutation, and the middleware checks the auth module's expanding paths.
  - **Writing it:** `status.sh` measures five filesystems and writes `/etc/mykey/gate/capacity.json`.
- **Harness:**
  - **Limits:** every test API runs a real limiter on its database, with wide limits unless a suite asks for the product's (`rateLimits: "product"`).
  - **Capacity:** every test gate directory holds a capacity record renewed every 30 s (`setCapacity()`; `keepCapacityOk()` for suites with their own gate file).
  - **Idle locks:** `idleAdvisoryLocks` waits out read cool-downs before it counts.

## Commits

- `fb0fe8b` feat(api): rate limits per source, session, credential and action
- `4cbdb68` feat(api): an in-flight gate, large slots before the body, pools from the limits
- `5444b9a` contract: capacity_exceeded on every expanding route, limit "disk"
- `00c2170` feat(api): disk pressure refuses growth and keeps reduction
- this note, D-49, `limits.md`, the registry

## Commands and results

- **Unit:** `pnpm test` gives 1,012 passed after Task B. Task C adds `tests/unit/api/capacity.test.ts` (10) and `tests/unit/hosts/capacity.test.ts` (3).
- **Integration, new suites** (each also run with its code mutated, and failing as it should):

  | Suite                                  | Result          | Mutation                                                                                        |
  | -------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
  | `limits/rate.test.ts`                  | 12/12           | `hit` never refuses: 10 fail                                                                    |
  | `limits/machine.test.ts`               | 6/6             | without the miss pre-check: 2 fail; without the per-credential lock: the concurrency test fails |
  | `limits/large.test.ts`                 | 4/4             |                                                                                                 |
  | `limits/issuer-session.test.ts`        | 1/1             | reuse of 0 ms: fails                                                                            |
  | `limits/starvation.test.ts`            | 1/1, three runs |                                                                                                 |
  | `limits/capacity.test.ts`              | 8/8             | a capacity step that never refuses: 5 fail                                                      |
  | `tests/fault/audit/exhaustion.test.ts` | 3/3             |                                                                                                 |

- **Existing groups rerun after each task:**
  - **After Task A:** api, machine, auth and authz, 256 tests. Eleven failures, all of the new order:
    - `origin.test.ts` counted the source counter as a change;
    - `concealment.test.ts` counted its statement;
    - `health.test.ts` ran on a database without tables;
    - `pipeline.test.ts`: an oversized chunked body got a reset (below).

    Fixed and rerun: 56/56 and 22/22.

  - **After Task B:** read, secrets, machine, export, imports, lifecycle and credentials, 289 tests. 39 failures, all the harness check for advisory locks of idle connections meeting the read cool-down. Fixed (the check waits out cool-downs, at most 3 s); rerun 45/45.
  - **After Task C:** secrets, imports, resources, lifecycle, credentials, auth and audit, 479 tests.
    - Two auth race suites start their own API processes with their own gate file and no capacity record. They now keep one.
    - The 400 KiB source-limit case can see the reset before the 429 under load; it now proves the answer from the server's request line.

    Rerun 18/18.
- **Starvation** (P-114's measurement; 999 × 8 KiB plus the target; one credential resolving back to back for 20 s; a write every second):

  |                                 | Reads            | Writes | Within three attempts | Worst write                                   |
  | ------------------------------- | ---------------- | ------ | --------------------- | --------------------------------------------- |
  | without a rule                  | 4, at most 5.6 s | 4      | **3**                 | 4 attempts' worth: `busy, busy, busy` (8.4 s) |
  | with the 1.5 s cool-down, run 1 | 4, at most 7.2 s | 3      | 3                     | `busy, busy, ok` (6.4 s)                      |
  | run 2                           | 4, at most 7.0 s | 4      | 4                     | `busy, busy, ok` (6.4 s)                      |
  | run 3                           | 4, at most 7.0 s | 4      | 4                     | `busy, busy, ok` (6.4 s)                      |

  The last run is in `run-6.3-starvation.json`.

- **Staging:** `host.ts staging push` ran. `status.sh` run by hand wrote `/etc/mykey/gate/capacity.json`: `state: ok`, volumes `bao-audit`, `bao-rotated`, `docker`, `openbao`, `postgres`, mode 0644. The staging API (`d13dc5749854`) does not read it yet.
- `pnpm run check` is green.

### Registry

FR-1.60 SPIKE_PASS — rate limits are pipeline steps for source, session, credential, the reveal, import, export and issuance classes, and attributable machine misses. A refusal is 429 with retry-after; a counter that cannot be written is 503 and never a bypass. The limits hold across two processes, and the source limit is checked before the body (`tests/integration/limits/{rate,machine}.test.ts`).

FR-1.61 and AC-1.24 stay `OPEN` until `limits.staging.test.ts` has run after Run 6.4's deploy. They are proven locally (`limits/{capacity,large}.test.ts`, `tests/fault/audit/exhaustion.test.ts`).

## Deviations and decisions

- **Test limits.** Test APIs run the real limiter with wide limits by default. The older suites exceed 120 requests a session and 30 reveals a minute by design; the limit suites, and staging, use the product's.
- **The class limits count per person**, not per session, so a new sign-in does not reset them.
- **The source step is middleware** after the gate and not on `GET /health`. It covers the auth module and unmatched paths, and its refusal closes the connection.
- **A malformed machine header is not a miss.** It costs no lookup; only refusals after a lookup count.
- **A finding about OpenBao:** it writes no audit entry for a `lookup-self` with a token it never issued. The miss test counts requests at the fixture's TLS relay instead (two records a lookup).
- **Oversized bodies are drained.** An oversized chunked body is now drained like a declared one (up to 4 MiB, never kept) before the 400. The source step's await exposed a race where the reader's cancel reset the socket before the answer.
- **A large route refused before its body drains it** (P-114, "drained as today").
- **The per-credential lock is held for the session on the read's lock connection** and released before the connection goes back. The plan says transaction-level; the read holds no transaction across its work. The exclusion is the same.
- **The health connection now counts in `LIMITS.db.apiPool`:** API pool 11 + lock pool 8 + health 1. Every ops command uses `LIMITS.db.opsPool`.
- **The fairness rule:** a 1.5 s read cool-down after each complete read (a two-key advisory lock held on a timer). The plan's pass line failed without a rule (one write in four).
- **A fifth volume, `bao-rotated`,** is measured: Run 6.2's open issue (a rotation holds the audit file twice). The staging test expects five volumes.
- **No `deps.test.capacityMaxAgeMs`.** Test records are renewed every 30 s, so every process reads them with the product's 180 s.
- **The classification of the auth module's paths.**
  - Expanding: the password change, TOTP enrolment and activation, and recovery-code regeneration.
  - Continuing: sign-in and its factors, sign-out, and session revocation; a person must be able to reach the reducing routes.
- **Two numbers live in `status.sh`:** the shell holds copies of the `LIMITS.disk` thresholds, kept equal by `tests/unit/hosts/capacity.test.ts`. The plan's rule is "no other file hard-codes these numbers"; a shell on the host cannot import them.
- **The integration test of an unknown record uses `invalid`, not `unreadable`.** A permission error cannot be made on the Windows workstation; `unreadable` is proven in the unit test.
- **The exhaustion test fills the disk in SQL**, not with `dd`: an unlogged filler table, then the last pages of `audit.event` and `app.rate_limit`. With `dd` alone, rows still fit in allocated pages and the reads succeed; with a container restart, the tmpfs would be lost.

## Open issues

- **`limits.staging.test.ts`** runs after Run 6.4's deploy. Deploy order on a host: `push` first, so that `status.sh` writes the record before an API of this run starts. Without the record, every expanding mutation is 503.
- **The starvation margin is thin.** The worst write used all three attempts. A slower host (staging reads 7 MB in up to 23.5 s) cannot meet the pass line with any cool-down: a single read outlasts a writer's three attempts. The runbook says writes answer `busy` and are safe to repeat.
- **Production** reads no capacity record until its API is updated (Run 6.9).
- **Dated items:** the KMS certificates expire on 12 Dec 2026; `.trivyignore.images` expires on 14 Dec 2026; `test:cloud`'s fixture guard is red until Run 6.6.
