# Run 2.3 — Better Auth secure-storage spike

**Result: DONE on 11 Nov 2026.** On better-auth 1.7.19 and PostgreSQL 18.6 (local stack), Better Auth serves password sign-in and sessions behind an explicit allowlist of five native routes, stores only keyed verifiers of session tokens, and leaves the second factor to a product-owned module whose every step is one transaction. No usable session token, TOTP seed, recovery code or password was found in a `pg_dump` of the database or in the PostgreSQL log. The G-AUTH verdict is GO (D-19); the route contract is `docs/auth-route-contract.md`.

PO-15 SPIKE_PASS — protected sessions and adapter storage proven on 1.7.19 (local stack): the stored session value is the keyed verifier of the cookie's token and is refused as a cookie even when signed with the cookie secret; the wrapper covers the four token paths of the version and fails closed on any other; lookup-key rotation keeps old sessions until the old key is removed; the dump and the log hold none of the collected secrets (`storage.test.ts`, `dump.test.ts`). Run 3.4 closes it on the integrated product.

PO-5 SPIKE_PASS — bootstrap-only auth proven on 1.7.19 (local stack): sign-up is refused over HTTP and in-process, an account is created through the operator path (`password.hash` plus the `user`, `account` and `account_state` rows), and every native route other than the five allowed answers 404 and writes nothing, with or without a session (`routes.test.ts`). Run 3.2 closes it on the integrated product.

PO-6 stays OPEN: the reset and the full MFA flow are Runs 3.5 and 3.6; this run contributes the factor module and its tests.

## What was done

- **Task A — closed routes.** `packages/auth`: `createAuth` (no sign-up, reset, social provider, plugin or telemetry; origin and CSRF checks set on explicitly), `routes.ts` (five allowed native routes, 27 denied by name, strict bodies, error envelope, no token in any body), the wrapped adapter and the verifier (they came forward from Task C, R36), key files per ring. Migration `0003_auth_base.sql` and `packages/db/src/schema/auth.ts`; the privileges matrix covers the eight new tables; the tenancy fixture creates its member user first.
- **Task B — stock plugin.** `stock-plugin.test.ts` on its own fresh database: all three weaknesses present on 1.7.19.
- **Task C — protected sessions.** `storage.test.ts`: stored value, signed-verifier refusal (with its control), sign-out, password change, revoke-all, key rotation, the recording layer, fail-closed operations, client-supplied factor fields.
- **Task D — factors.** `factors/seed.ts`, `recovery.ts`, `totp.ts`, `elevate.ts`; five factor routes. `factors.test.ts`, `race.test.ts` (two child processes, `race-worker.ts`), `dump.test.ts`; harness `pgDump` and `postgresLog`; the dev PostgreSQL logs no parameters, as the hosts do.
- **Task E — contract and verdict.** `scripts/auth-route-contract.ts` writes `docs/auth-route-contract.md` from the code (route inventory, request schemas as JSON Schema, cookie settings); `pnpm run auth:contract:check` is part of `pnpm run check`. D-19.

## Commits

- abe5f9a feat(auth): Better Auth behind an explicit route allowlist
- e5d22ad test(auth): the stock two-factor plugin fails three contract rules
- defb5c7 test(auth): session tokens stored as keyed verifiers
- 1fead0d feat(auth): product-owned TOTP and recovery codes with one-use steps
- this commit: docs(auth): route contract and G-AUTH verdict

## Commands and results

| Command                                                                                                   | Exit    | Proof line                                                                  |
| --------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------- |
| `pnpm exec vitest run --project unit tests/unit/auth` (verifier, seed, recovery before the code)          | 1       | `sessionVerifier is not a function`, `encryptSeed is not a function` (RED)  |
| `pnpm exec vitest run --project unit tests/unit/auth`                                                     | 0       | 16/16                                                                       |
| `pnpm exec vitest run --project integration tests/integration/database` with table-level UPDATE in `auth` | 1       | `column privileges equal the matrix`: identity columns updatable (RED, R37) |
| `pnpm exec vitest run --project integration tests/integration/database`                                   | 0       | 107/107                                                                     |
| `routes.test.ts` with Better Auth's catch-all handler mounted (mutation, reverted)                        | 1       | 3 failed: denied routes, plugin paths, doubled slashes                      |
| `storage.test.ts`, lookups with the current key only (mutation, reverted)                                 | 1       | `survive a rotation of the lookup key` failed                               |
| `factors.test.ts` without the used-step insert (mutation, reverted)                                       | 1       | `refuses the same code a second time` failed                                |
| `race.test.ts` without the account lock and with look-then-insert (mutation, reverted)                    | 1       | round 0: `[{"ok":true},{"ok":true}]: expected 2 to be 1`                    |
| `pnpm exec vitest run --project integration tests/integration/auth/race.test.ts`, three times             | 0, 0, 0 | 3/3 each (53 s, 51 s, 51 s); 50 rounds per scenario                         |
| `pnpm exec vitest run --project integration tests/integration/auth`                                       | 0       | 30/30 (routes 8, stock-plugin 3, storage 7, factors 7, race 3, dump 2)      |
| `node scripts/auth-route-contract.ts --check` before the file existed                                     | 1       | `docs/auth-route-contract.md is out of date`                                |
| `pnpm test`                                                                                               | 0       | 566/566                                                                     |
| `pnpm run check`                                                                                          | 0       | —                                                                           |

## Deviations and decisions

- **R36** the wrapper and the verifier landed with Task A: the new `session` table refuses anything but a verifier, so Better Auth cannot run without them.
- **R37** `api_runtime` updates schema `auth` column by column, like schema `app`; `maintenance` reads `auth` only; a check keeps the OAuth token columns empty and `provider_id` `credential`.
- **R38, R41** `mountAuthRoutes(app, auth, factors?)`: the plan's signature plus an optional `{ pool, keys }` that mounts the factor routes; the routes under `/v1/auth` are closed by the same call. The `trustDevice` case moved from Task A to Task D with the factor routes.
- **R39** Better Auth's errors are relayed as the contract envelope (401 `unauthenticated`, 403 `action_denied`, 404 `not_found`, 429 `rate_limited`, 5xx `dependency_unavailable`, other 4xx `malformed_request`).
- **R40** the "wrapper sees every token path" flow covers sign-in, get-session, change-password, revoke-sessions and sign-out; elevation writes its rows through `elevate.ts`, whose output is covered by the dump test and the session table's check.
- **R42** a missing session is `expired`; a wrong, replayed or expired code all answer `401 unauthenticated`; a wrong account or session state is `409 state_conflict`.
- **R43** a new session takes `auth_epoch` 0; elevation requires it to equal the account's.
- **R44** the dump test's failing statement is a division by zero with a raw token as its parameter: its message does not echo the value, so it tests parameter logging, which is off.
- **Observed: password change downgrades the session** (D-19): with `revokeOtherSessions` the caller gets a new `password_verified` session. Pinned in `storage.test.ts`.
- **Added beyond the plan:** `offlineAuth()` (an instance that never touches its database, for the route inventory and the contract script), `pgDump` and `postgresLog` in the harness, two logging settings in the dev PostgreSQL configuration, and the root workspace's dependency on `@mykey/auth` for the contract script.
- The registry is not edited in this run (ruling R6).

## Open issues

- Sign-in does not check `account_state` yet (Run 3.4).
- Change-password with `revokeOtherSessions` loses the factor (Runs 3.4/3.5 decide).
- Recovery and step tables grow without clean-up; a retention job is not part of Session 2.
- `pnpm audit`: one moderate esbuild advisory reached through better-auth's peer dependency on drizzle-kit (development server only).

Verdict: GO
