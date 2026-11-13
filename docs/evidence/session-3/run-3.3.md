# Run 3.3 — Throttling

**Result: DONE on 12 Nov 2026.** Password and factor attempts are throttled per source and per account, with counters in PostgreSQL on database time, and the limits hold across two API processes on one database.

FR-1.07 SPIKE_PASS — product code, real stores: 5 attempts a minute per source and phase, 5 failures in 15–30 minutes lock the account for 15 minutes, refused before any credential is checked, alike for known and unknown accounts, across two API processes.
AC-1.05 SPIKE_PASS — product code, real stores: `throttle.test.ts` (11) and `throttle-two-process.test.ts` (3, five runs in a row).

## What was done

- `packages/db/src/repos/rate-limits.ts`: `bumpCounter` (one `INSERT … ON CONFLICT DO UPDATE … RETURNING`, window from `date_bin(now())`), `sumCounters`, `lockSecondsLeft`, `insertLock`, `deleteCounters`, `sweepCounters`.
- `packages/auth/src/throttle.ts`: `throttleDigest`, `createThrottle` (`admit`, `recordFailure`, `clearAccount` for Run 3.6), the `Throttle` interface now required by the auth routes.
- `apps/api/src/pipeline/source.ts`: `requestSource` (P-47); the auth routes' source uses it.
- Routes: `password` phase on sign-in; `factor` phase on `/totp/activate`, `/totp/verify`, `/recovery/verify`; 429 with `Retry-After` and audit `auth.throttled`; 503 when the counter fails. Audit action `auth.throttled` added.
- `apps/api/src/throttle-sweep.ts`: the counter clean-up every ten minutes; `startServer` builds the throttle and the sweep, so the production entry can start again; `tests/integration/api/health.test.ts` is back on `startServer` (ledgered in Run 3.2).
- Harness: `tests/harness/api-worker.ts` + `api-process.ts` (a real second API process on the same database and key directory), `requestTo`, `enrollOwner`, `sessionCookieOf`.
- `docs/auth-route-contract.md` regenerated (429 and 503 on the four throttled routes); D-28.

## Commits

- `feat(auth): rate counters with keyed digests, trusted request source`
- `feat(auth): throttling of password and factor attempts`
- `test(auth): throttling holds across two API processes` (this commit, with D-28 and this note)

## Commands and results

| Command                                                                                           | Result                                                                                  |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `vitest --project unit tests/unit/auth/throttle.test.ts tests/unit/api/source.test.ts`            | 17 passed (fixed HMAC vectors computed with Python's `hmac`)                            |
| `vitest --project integration tests/integration/auth/throttle.test.ts`                            | 11 passed                                                                               |
| `vitest --project integration tests/integration/auth tests/integration/api tests/integration/ops` | 142 passed                                                                              |
| `pnpm test`                                                                                       | 741 passed                                                                              |
| `vitest … throttle-two-process.test.ts`, with an always-allow throttle in the children            | 3 failed (the test can fail)                                                            |
| `vitest … throttle-two-process.test.ts`, five runs                                                | run 1: 3 passed · run 2: 3 passed · run 3: 3 passed · run 4: 3 passed · run 5: 3 passed |
| `pnpm run check`                                                                                  | exit 0                                                                                  |

## Deviations and decisions

- **Every sign-in failure counts** as a password-phase failure of the submitted e-mail (also a refused account state or a moved epoch); factor failures other than `wrong_state` count for the session's user.
- **`auth.throttled` carries no user id**, so the audit trail of a refusal does not reveal whether the account exists.
- **Test hygiene:** the Session 2 auth fixture gives each request a fresh source and `sign-in.test.ts` sends each sign-in from its own forwarded source, so those suites are not cut by the per-source limit they do not test.
- **Task B's route tests were written before the wiring but not run red** against unwired routes; Task C's test was run red with an always-allow throttle.

## Open issues

- None for this run. The general limits (300/120/60 a minute) are Run 6.3.
