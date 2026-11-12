# Run 3.4 — TOTP and recovery codes

**Result: DONE on 12 Nov 2026.** No product route answers a session that has not completed the second factor; the factor routes run on the pipeline with throttling and an audit row per attempt; step-up and fresh-TOTP regeneration exist; one-use steps and codes hold across two API processes.

FR-1.02 SPIKE_PASS — product code, real stores: every human route answers `401 mfa_incomplete` to a password-only or enrollment-phase session and `401 unauthenticated` without a valid cookie, with no stub reached; an `mfa_complete` session reaches every stub.
FR-1.03 SPIKE_PASS — product code, real stores: ten recovery codes shown once and stored as verifiers; a TOTP step and a recovery code redeem once, also in 20-round races across two API processes and across an API and a PostgreSQL restart.
AC-1.02 SPIKE_PASS — product code, real stores: `factors-http.test.ts` (15), `factors-restart.test.ts` (1), `factors-race.test.ts` (3, 20 rounds each).
PO-15 SPIKE_PASS — product code, real stores: no trusted device, no remember-device field, no route that switches the factor off (`/totp/disable`, `/two-factor/disable` → 404).

## What was done

- **Authentication step** (`apps/api/src/pipeline/authn.ts`): routes of class `human` and `human_fresh_totp` call `authenticateHuman` after the body is parsed and before strict validation; the principal (`userId`, `sessionId`, `fresh`) reaches the handler.
- **Stubs** (`AppDeps.test.stubs`, harness `startTestApi({ stubs: true })`, `api.reached`): a route without a handler answers 204 after every pipeline check and records its id. `server.ts` never sets it.
- **Factor module** (`packages/auth/src/factors/elevate.ts`): session expiry and the 10-minute challenge decided on database time (an expired challenge session is deleted); `totp_verified_at` and `last_user_activity_at` written with `now()`; an audit row per attempt (`auth.totp_enroll`, `auth.totp_activate`, `auth.mfa_complete` with `{ method }`, `auth.step_up`, `auth.recovery_regenerate`) inside the transaction on success and beside it on failure, with the reason and never the code; `stepUpWithTotp`; regeneration requires `hasFreshTotp` (`packages/auth/src/fresh.ts`), otherwise `not_fresh` → `403 fresh_verification_required`.
- **Routes**: `POST /v1/auth/totp/step-up`; the `factor` throttle on activate, verify, recovery verify and step-up; the TOTP clock comes from `AuthRouteEnv.now`, which only the harness sets (`x-test-now`).
- **Harness**: `TestApi.restart()` (new app and listener on the same database and keys), the test clock, the child API process with the test clock.
- `docs/auth-route-contract.md` regenerated (11 served routes).

## Commits

- `feat(api): human routes require a completed second factor; feat(auth): factor routes with audit, throttle, step-up and fresh regeneration`
- `test(auth): one-use steps and codes across two API processes` (this commit, with this note)

## Commands and results

| Command                                                                                           | Result                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `vitest --project integration tests/integration/auth/factors-http.test.ts` (before the code)      | 12 failed (RED, seen in the full run) |
| `vitest … factors-http.test.ts factors-restart.test.ts`                                           | 16 passed                             |
| `vitest … factors-race.test.ts`                                                                   | 3 passed (20 rounds each, first run)  |
| `vitest --project integration tests/integration/auth`                                             | 12 files, 70 passed                   |
| `vitest --project integration tests/integration/auth tests/integration/api tests/integration/ops` | 161 passed                            |
| `pnpm test`                                                                                       | 741 passed                            |
| `pnpm run check`                                                                                  | exit 0                                |

## Deviations and decisions

- **Database time in the factor module**: the Session 2 code compared session expiry and the challenge age with the API's clock (and with the injected `now` of tests). They are SQL comparisons now; only the TOTP step uses the API's clock. Two Session 2 assertions changed with it: `totp_verified_at` is the database's time, and the dump suite regenerates codes from its TOTP session (a recovery-code session is not fresh).
- **Run 3.1's "routes without a handler answer 404"** now sends an `mfa_complete` cookie to human routes, as the plan says; the pipeline's status table includes the 401 of a product route without a session.
- **Step-up answers `200 {"fresh":true}`**; enrollment and regeneration are not throttled; a refused state or a stale session is not counted as a factor failure.
- **Restart and race cases have their own files** (`factors-restart.test.ts` with its own stack, `factors-race.test.ts` with two child processes) rather than living in `factors-http.test.ts`.
- **Task A and Task B share one commit**: the authentication step, the stubs, the clock and the audit touch the same files.
- **The race test was not run red**: one use rests on the unique keys of `auth.totp_step_used` and the conditional update of `auth.recovery_code`, proven red at function level in Session 2 (`race.test.ts`).

## Open issues

- `resolveSession` (one validity decision with both limits) replaces `currentSession` + the account check in Run 3.5.
