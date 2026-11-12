# Run 3.6 — Operator reset and recovery

**Result: DONE on 12 Nov 2026.** The operator resets a lost password or a lost second factor; the owner completes it through one contract route; an expired link leaves the account blocked; only one completion of a link ever succeeds, also across two API processes; no token reaches a log.

FR-1.04 SPIKE_PASS — product code, real stores: only `ops reset-account` (maintenance) issues a link; completion for both kinds; every failure the same 401; an expired link leaves the account `recovery_pending`; one redemption across two processes.
AC-1.03 SPIKE_PASS — product code, real stores: `tests/integration/ops/reset.test.ts` (9), `tests/integration/auth/reset.test.ts` (10), `tests/integration/auth/reset-race.test.ts` (3, 20 rounds for each race of one link).
PO-6 SPIKE_PASS — product code, real stores: no route starts a reset or creates an account; the token is stored as a verifier only, carried in the link's fragment, and found in no log, dump or audit row.

## What was done

- **Migration `0006_reset`** (drizzle-generated, grants hand-written): table `auth.reset_token`, column `auth.session.reset_token_id`; `api_runtime` reads and consumes, `maintenance` issues and supersedes; `maintenance` also gets the two `DELETE` rights of Run 3.5's factor clean-up. Matrix and inventory updated.
- **Initiation** (`packages/auth/src/operator/reset.ts`): `initiateReset`, `resetLink`, `RESET_POINTS`; the verifier in `packages/auth/src/reset/verifier.ts` (outside the operator entry point, since the API uses it too). Command `ops reset-account` (link to a 0600 file; path and expiry printed).
- **Completion** (`packages/auth/src/reset/complete.ts`, handler `apps/api/src/routes/reset.ts` on the contract route `auth.reset.complete`): both kinds, the `reset` and `factor` throttles, audit `auth.reset_complete` / `auth.reset_failed`.
- **Challenge session**: `resolveSession` admits it while the account is `recovery_pending` and the link lives; it serves enroll, activate and sign-out only; activation ends it and makes the account active.
- The password rule moved into `@mykey/contracts` (`checkPassword`) for the request schema; the API pipeline gained response headers for a handler, headers on an `ApiError` (Retry-After), the harness clock in `ApiContext.now`, and the trusted request source in `ApiContext.source`.
- `cleanUpSessions` also clears the verifiers of expired links.
- Throttle tests that count inside one window now wait for a fresh 60-second window (`tests/harness/windows.ts`).
- Docs: D-30, `operator-accounts.md` (reset, both kinds, what the owner sees).

## Commits

- `feat(ops): operator-initiated reset` (+ a style fix)
- `contract: auth.reset.complete body`
- `feat(auth): reset completion for password and MFA loss`
- `test(auth): single redemption across two API processes` (this commit, with D-30, the runbook and this note)

## Commands and results

| Command                                                                                           | Result                                                                                        |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `vitest --project integration tests/integration/ops`                                              | 26 passed (reset 9, output with `reset-account`)                                              |
| `vitest … tests/integration/auth/reset.test.ts` before the completion code                        | 10 failed (RED)                                                                               |
| `vitest … reset.test.ts` after                                                                    | 10 passed                                                                                     |
| `vitest … reset-race.test.ts`                                                                     | 3 passed (first run)                                                                          |
| the same without `FOR UPDATE` on the token and account rows                                       | 2 failed: the mfa race redeemed twice (`[200, 200]`), the initiation race broke its invariant |
| `vitest --project integration tests/integration/auth tests/integration/api tests/integration/ops` | 23 files, 207 passed                                                                          |
| `pnpm test`                                                                                       | 744 passed                                                                                    |
| `pnpm run check`                                                                                  | exit 0                                                                                        |

## Deviations and decisions

- Migration number `0006` (not `0005`): Run 3.2 added `0005_operator_only_accounts`.
- The password rule lives in `@mykey/contracts` now; `@mykey/auth` re-exports it.
- The `mfa` completion retires the active and any pending enrollment and consumes every open recovery code of the user.
- `get-session` answers 401 to a reset challenge (the plan lists it among "every other auth route").
- **Open flake:** `tests/integration/api/health.test.ts`'s `afterAll` timed out (300 s) twice under the parallel run of the auth, API and ops folders; an instrumented re-run under the same load passed, with every API shutdown step in milliseconds and the stack's `docker compose down` at 4.5 s. Not reproduced; watched at the gate.
- The Task A tests were written before the code but first run after it (they could not import the missing functions).

## Open issues

- The reset page (Run 7.x) must read the fragment, clear it from the address bar and send no referrer.
