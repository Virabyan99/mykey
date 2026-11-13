# D-28 — Throttling of password and factor attempts

**Date:** 2026-11-12

**Status:** DECIDED in the Session 3 plan (P-47, P-48), recorded by the executing agent in Run 3.3. Evidence: `tests/unit/auth/throttle.test.ts`, `tests/unit/api/source.test.ts`, `tests/integration/auth/{throttle,throttle-two-process}.test.ts`, `docs/evidence/session-3/run-3.3.md`.

## Decision

- **Counters in PostgreSQL** (`app.rate_limit`), never in a process: two API processes count into the same rows. A row's key is `HMAC-SHA-256(rate-limit key, scope ‖ 0x00 ‖ subject)` (32 bytes); no row holds an address, an e-mail or a user id (a table dump of a test holds none of them). Windows are cut with `date_bin` on the database's `now()`.
- **Scopes:** `src:<phase>` (per source, 60-second windows), `fail:<phase>` (per account, 900-second windows), `lock:<phase>` (a lock; `window_start` is when it began). Phases: `password`, `factor` (TOTP activation and verification and recovery codes together), `reset` (Run 3.6).
- **Admission, in this order:** a lock of the account younger than 900 s refuses (`retryAfterSeconds` = what is left), and is not counted against the source; then the source's counter is bumped and more than 5 attempts in its minute refuse. Successes count against the source.
- **Failures:** a failed credential bumps `fail:<phase>`; when the current and the previous 15-minute window together reach 5, a lock row is written and the account's `fail` rows are deleted. Two adjacent fixed windows see between 15 and 30 minutes of history, so the lock can only come earlier than a sliding window would give it, never later. A success does not clear failures.
- **Subjects:** for `password` the e-mail as submitted, trimmed and lower-cased — whether or not such a user exists — so known and unknown accounts behave alike (status, body, headers and `Retry-After` equal in a six-attempt script); for `factor` the session's user id; the source is the request source of P-47.
- **Request source (P-47):** when the TCP peer is the configured edge (`MYKEY_TRUSTED_PROXY`, 10.78.1.2 on the hosts) and `X-Forwarded-For` holds exactly one valid address (no port, no list, at most 64 characters), that address; otherwise the peer (an IPv4-mapped IPv6 peer in its IPv4 form). Nothing else reads a forwarded header for a decision.
- **On a route:** `admit` first; refused → `429 rate_limited` with `Retry-After` and an `auth.throttled` audit row (`{ phase }`, no user id), and nothing else happens — no user lookup, no hash, no native call. `admit` throws → `503 dependency_unavailable`, likewise. Then the credential step; a failure is recorded, then answered; if the failure cannot be recorded, the answer is `503 dependency_unavailable`. Every sign-in failure (wrong password, unknown e-mail, refused account state, moved epoch) counts.
- **Required:** `AuthRouteEnv.throttle` is required; the auth routes refuse to mount without it, and the production entry builds it (`createThrottle` with the `rate-limit` ring). The `allowUnthrottled` escape of Run 3.2 is gone.
- **Clean-up:** the API deletes counter rows older than one hour every ten minutes, at most 1,000 a pass (`api_runtime` holds `DELETE` on `rate_limit`).
- **Not here:** the general per-source, per-session and per-credential limits of Doc 06 §11 (300, 120 and 60 a minute) are Run 6.3, on the same `bumpCounter`.
