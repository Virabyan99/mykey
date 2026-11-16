# D-49 — Limits, concurrency and disk pressure

**Date:** 2026-11-16

**Status:** DECIDED in Run 6.3 (P-113, P-114, P-115). Evidence:

- `docs/evidence/session-6/run-6.3.md`;
- `tests/integration/limits/*.test.ts`;
- `tests/unit/api/{rate,inflight,capacity}.test.ts`, `tests/unit/contracts/pools.test.ts`, `tests/unit/hosts/capacity.test.ts`;
- `tests/fault/audit/exhaustion.test.ts`, `tests/staging/limits.staging.test.ts`.

## Decision

### Rate limits (P-113)

Rate limits are pipeline steps on the counters of D-28 (`app.rate_limit`). Windows are 60 seconds, cut on database time, so every API process counts into the same rows. A row holds an HMAC of (scope, subject) under the `rate-limit` key ring, never an address, a session id or a token.

| Scope             | Limit a minute | Subject                   | Where                                                                                                             |
| ----------------- | -------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `rl:source`       | 300            | the request source (P-47) | first, after the gate; before anything of the request is read                                                     |
| `rl:session`      | 120            | the session id            | after authentication; not on credential revocation and the archives                                               |
| `rl:credential`   | 60             | the credential id         | after machine authentication                                                                                      |
| `rl:reveal`       | 30             | the person                | after authorization, `secrets.reveal`                                                                             |
| `rl:import`       | 5              | the person                | after authorization, `import.preview`, `apply` and `resume` together                                              |
| `rl:export`       | 5              | the person                | after authorization, `export.create`                                                                              |
| `rl:issue`        | 5              | the person                | after authorization, `credentials.issue`                                                                          |
| `rl:machine-miss` | 30             | the request source        | a token nobody can attribute, counted after the lookup that failed; at 30 the source is refused before the lookup |

- **A refusal** is `429 rate_limited` with `retry-after`, the seconds left of the window, and a log line `rate_limited { scope }`. No audit row is written.
- **A counter that cannot be written or read** is `503 dependency_unavailable`. No path skips a step. A source refusal answers with `connection: close`, and its body stays unread.
- **Two values are new** in `LIMITS.rate`: `machineMissesPerSourcePerMinute` and `credentialIssuePerMinute`. They are marked "not in Doc 06 §11".
- **The class limits count per person, not per session.** A person cannot reset them by signing in again.
- **The price of the miss rule:** a source that sends 30 unknown tokens in a minute is refused, valid credentials from that source included, until the window ends. Behind one NAT this is a shared fate; the runbook says so.
- **The auth module's own throttle (D-28) is unchanged.** Its routes pass the source step and no session step.
- **Tests:** every test API runs a real limiter on its database. Suites that are not about limits use limits so wide that they never refuse; the limit suites use the product's.

### Concurrency (P-114)

- **In-flight gate.** At most 64 requests run in one process. It is the first step after the request id. The 65th request is `503 busy` with `connection: close`, its body unread; nothing queues.
- **Large routes.** These are `import.preview`, `import.apply`, `import.resume`, `export.create` and `machine.resolve`.
  - Authentication, the session or credential limit and the large slot (2 per process) come **before** the body is read.
  - A refusal before the body drains it (read and dropped, never kept, up to 4 MiB), so the peer gets the answer and not a reset.
  - The handlers take no slot of their own.
- **Timeouts.** A request must arrive whole within `LIMITS.deadlines.requestMs` (30 s), its headers within 10 s. Node checks every second, so a silent peer frees its slots on time.
- **Pools.** One API process opens at most `LIMITS.db.apiPool` (20) connections: its pool, its lock pool of 8, and the health check's one. The provisioner opens `LIMITS.db.provisionerPool`, and every ops command `LIMITS.db.opsPool`. Two API processes, the provisioner, one ops container per job and the superuser reserve add up to 57 of the 100 the host's PostgreSQL allows.
- **One request at a time per credential.** `machine.keys` and `machine.resolve` take a two-key advisory lock (`mykey.one-at-a-time`, the credential id) on the read's lock connection before the environment's lock, without waiting. A second request of that credential is `503 busy` at once, in any process.
  - The lock is held for the session on that connection and released before the connection goes back, not at the end of a transaction. The read's connection holds no transaction across the read.
- **The fairness rule (measured, then added).** Without it, one credential resolving 1,000 × 8 KiB back to back made one write in four fail three attempts 1 s apart. The reader took the environment's lock again about 0.4 s after releasing it, before the writer's next attempt.
  - Now a complete read leaves a **read cool-down of 1.5 s** (`mykey.read-cooldown`, the environment's key) when it releases the environment's lock. The next complete read of that environment waits it out; writers do not.
  - 1.5 s is longer than the 1 s between a person's attempts, and shorter than the 2 s a read waits for a lock.
  - The answer is not delayed: the cool-down ends on a timer that holds the read's lock connection until then.
  - Measured locally in three runs: every write within three attempts; the worst took three, 6.4 s.
- **The archive's issuer session.** One session is reused for as many environments as fit in its first 45 s; it lives 60 s. A project of five environments is archived with one login.

### Disk pressure (P-115)

- **The host writes a record; the API reads it.** The API cannot see another container's volume. `status.sh`, run every minute by the heartbeat timer, measures five filesystems:
  - the PostgreSQL data;
  - the OpenBao data and the OpenBao audit volume;
  - the Docker root;
  - the directory of rotated OpenBao audit files (Run 6.2's open issue: a rotation holds the file twice).

  It writes `/etc/mykey/gate/capacity.json` through a temporary file and `mv` in the same directory, world-readable (sizes only): `{ version: 1, observedAt, state, volumes }`. It writes only as root, and only when every volume was measured.

- **`low`** is a volume with any of:
  - free bytes under 15 % of its size;
  - free bytes under `minFreeBytes + auditReserveBytes` (4 GiB);
  - free inodes under 10 %.

  The thresholds are `LIMITS.disk`. `status.sh` holds copies that a unit test keeps equal.

- **The API reads the record afresh for every expanding mutation:**
  - `low` → `507 capacity_exceeded { limit: "disk" }`;
  - a record that is missing, unreadable, invalid or older than 180 s → `503 dependency_unavailable`.

  The check comes after authorization and after a replay, and before any state is read for the change. Nothing is written and OpenBao is not asked.

- **Every mutation is in exactly one set** (`EXPANDING_ROUTES`, `REDUCING_ROUTES` in `@mykey/contracts`); a unit test fails for an idempotent route or a writing auth path in neither.
  - **Expanding:** project and environment create, rename and reactivate; every secret write (delete too: it adds a version); the three import routes; credential issuance; the reset completion; the auth module's password change, TOTP enrolment and activation, and recovery-code regeneration. The auth module's paths are checked in the middleware.
  - **Continuing:** the archives and credential revocation, and sign-in with its factors, sign-out and session revocation. Without them nobody could reach the reducing routes. Reads continue.
- **Real exhaustion needs no record.** With PostgreSQL's disk really full, a reveal and a machine resolve answer 503 with no value, and no audit row claims their success (`tests/fault/audit/exhaustion.test.ts`).
- **`capacity_exceeded`** joins the error lists of the nine expanding routes that lacked it (commit `contract: …`).

### Tests

- **Test APIs write a record** into their gate directory and renew it every 30 s, as the host's heartbeat does; `setCapacity()` sets it to `ok`, `low`, `missing`, `stale` or `invalid`.
- **The plan's `deps.test.capacityMaxAgeMs` was not needed.** The renewed record never goes stale, and the child API processes read the same file with the product's 180 s.

## Alternatives rejected

- **The class limits per session.** A new sign-in would reset them.
- **An in-process counter.** Two API processes would each allow the limit, and a restart would reset it.
- **The API measuring disk itself.** It cannot see the other containers' volumes, and a mount of every volume into the API would widen what it can read.
- **Treating a missing capacity record as `ok`.** A host whose measurement broke would silently lose the protection.
- **Fairness by a longer writer wait.** `advisoryLockMs` (2 s) is a number of Doc 06 §11, and a writer waiting longer holds a request slot longer.
- **Counting malformed machine headers as misses.** They cost OpenBao nothing, and counting them would let a broken client lock out its own source sooner.
