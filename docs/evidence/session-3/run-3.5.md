# Run 3.5 — Sessions and fresh verification

**Result: DONE on 12 Nov 2026.** One validity decision on database time with both limits, an activity signal that only a real action sends, session list and revocation, an atomic product-owned password change, fresh-TOTP on the sensitive starts, and clean-up of sessions and spent factor rows.

FR-1.05 SPIKE_PASS — product code, real stores: sessions end at 12 h absolute and after 30 min without an activity signal (both sides of each limit tested, rows aged on database time), polling does not extend them, the signal moves idle and never absolute.
FR-1.06 SPIKE_PASS — product code, real stores: the user lists their sessions (no token), revokes one (another user's id is the same 404 as an absent one) or all; sign-out, a disabled account and a raised epoch end a session for the next request; the password change ends every other session atomically.
FR-1.77 SPIKE_PASS — product code, real stores: export, credential issuance (on stub handlers), password change and recovery-code regeneration require a TOTP verification of this session in the last 600 s.
AC-1.04 SPIKE_PASS — product code, real stores: `sessions.test.ts` (12), `password.test.ts` (7).
AC-1.35 SPIKE_PASS — product code, real stores: `fresh.test.ts` (6). Export and issuance were proven on stub handlers; Runs 4.9 and 5.1 prove them again on the real handlers.

## What was done

- `packages/auth/src/sessions.ts`: `resolveSession` (signature check of the cookie, one SQL statement, deletion of expired rows), `touchActivity`, `sessionExpiries`, `listSessions`, `revokeSession`, `cleanUpSessions`, `nativeSessionResponse` (the one call of Better Auth's `getSession`).
- Everything that judged a session now uses it: `authenticateHuman`, `requireMfaComplete` (now on `SessionDeps`), the factor routes, `get-session`; `currentSession` is gone.
- `session.activity` handler (`apps/api/src/routes/session.ts`) and its contract body.
- `packages/auth/src/password.ts`: `changePassword`; routes `POST /v1/auth/change-password` (product-owned), `GET /v1/auth/sessions`, `POST /v1/auth/sessions/revoke`; audit action `auth.password_change`; `NATIVE_ALLOWED` down to four, `PRODUCT_OWNED`.
- Freshness step in `mountRoute` for `human_fresh_totp`.
- Clean-up: `cleanUpSessions` at API start and hourly; `cleanUpFactors` and `ops auth-cleanup`.
- Shutdown hardening: the API pool has a query timeout (`LIMITS.deadlines.requestMs`) and the outbox dispatcher's stop waits at most 5 s (a `health.test.ts` `afterAll` once timed out at 300 s while a pass was stuck on a dead connection).
- `docs/auth-route-contract.md` regenerated (13 served routes); D-29.

## Commits

- `contract: session.activity body`
- `feat(auth): session validity from database time, activity signal`
- `feat(auth): session list and revoke, atomic password change`
- `fix(auth): Session 2 suites follow the product-owned password change; bounded API shutdown`
- `feat(api): fresh-TOTP class, auth clean-up` (this commit, with D-29 and this note)

## Commands and results

| Command                                                                                           | Result                                                      |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `vitest … sessions.test.ts` before the code                                                       | 7 failed (sessions not expiring; the activity route a stub) |
| `vitest … password.test.ts sessions.test.ts` before Task B                                        | 10 failed                                                   |
| `vitest … fresh.test.ts` with the freshness step disabled                                         | 3 failed (the test can fail)                                |
| `vitest --project integration tests/integration/auth tests/integration/api tests/integration/ops` | 21 files, 188 passed                                        |
| `pnpm test`                                                                                       | 743 passed                                                  |
| `pnpm run check`                                                                                  | exit 0                                                      |

## Deviations and decisions

- **`resolveSession` checks the cookie's signature itself** rather than calling Better Auth's `getSession`, so the whole decision is the product's; `get-session` relays Better Auth's answer only for a session `resolveSession` admits.
- **The password-change throttle subject is the user's e-mail**, the same as sign-in's, so failures of both add up.
- **Two Session 2 suites changed** (`storage.test.ts`, `dump.test.ts`): they exercised Better Auth's native password change, which this run replaces; the first commit of Task B went in before they were updated and the next commit fixed them.
- **The clean-up test grants `maintenance` the two `DELETE` rights itself**: they come with migration `0006` in Run 3.6, as the plan says.

## Open issues

- The reset challenge session (phase `enrollment` on a `recovery_pending` account) is added to `resolveSession` in Run 3.6.
- `ops auth-cleanup` needs a timer (Run 6.9).
