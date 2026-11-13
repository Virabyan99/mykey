# Run 3.2 — Owner bootstrap and password sign-in

**Result: DONE on 12 Nov 2026.** An owner exists only through the operator's bootstrap; sign-in is bound to the account's state and epochs and runs on the API's pipeline; no path of the integrated app creates a user. The staging owner was created through the tunnel. Nothing was deployed (P-60: the image with auth routes goes to staging in Run 3.8, after throttling).

FR-1.01 SPIKE_PASS — product code, real stores; staging: the owner is created only by `ops bootstrap-owner` (maintenance), an interrupted and repeated bootstrap yields exactly one owner, every sign-up path answers the generic 404, `api_runtime` cannot create an account.
AC-1.01 SPIKE_PASS — product code, real stores; staging: bootstrap idempotent (same e-mail `already_present`, another e-mail refused), killed after each of its 7 statements and repeated → one owner; repeated on staging → `already_present`, row counts unchanged.
PO-5 SPIKE_PASS — product code, real stores; staging: no public route creates an account (route listing, denied native routes with and without a session, in-process `signUpEmail` refused, migration `0005`).

## What was done

- **Key rings** (`packages/auth/src/keys.ts`): eight rings, key ids by number (`k10` after `k9`, M15), a bad `.key` file name is an error naming it, `generateKeyFiles` creates only missing rings, `ephemeralKeys` for throw-away instances.
- **`apps/ops`**: `runOps` (usage exit 64, secret-named flags refused for every command), `writeSecretFile` (0600 under 0700 in `~/.mykey/out`), `readSecretLine`, command `bootstrap-owner`. The remote code moved to `apps/ops/src/remote` (`@mykey/ops/remote`, closes M17); `scripts/host.ts`, `probe.ts`, `require-staging-env.ts` import it from there; the harness re-exports it.
- **`@mykey/auth/operator`**: `bootstrapOwner`, `BOOTSTRAP_POINTS`, `checkPassword` (P-46; also exported from the root). Better Auth gets `minPasswordLength: 12`, `maxPasswordLength: 1024` and the Strict cookie attributes (P-39).
- **Migration `0005_operator_only_accounts`**: `api_runtime` loses `INSERT` on `auth.user` and `auth.account` (finding of Run 3.1's note).
- **Sign-in** (`packages/auth/src/sign-in.ts`): state and epoch check in one transaction with the session binding and the audit row; the dummy-hash path for an unknown e-mail; any failure after the native call deletes its session. `authenticated_at` and `last_user_activity_at` now come from the database's `now()`.
- **Auth routes on the pipeline**: `AuthRouteEnv` (the API's envelope, request id, body reader with the auth limit, audit), `relayNative` parses only JSON (closes M16), `servedAuthRoutes`, the throttle requirement; `createApp` mounts them after the contract routes; `server.ts` loads the keys from `MYKEY_AUTH_RINGS_DIR` (and cannot start without throttling until Run 3.3).
- **Harness**: `startTestApi` builds Better Auth with fresh keys (`api.auth`, `api.keys`); `seedOwner` uses `bootstrapOwner` as `maintenance`.
- **Hosts**: `host.ts <host> keys init`, `host.ts <host> ops <command…>`, `keyInstallCommand`; Compose mounts `/etc/mykey/secrets/api-keys` read-only at `/run/mykey/keys` (pushed in Run 3.8).
- Docs: `docs/runbooks/operator-accounts.md`, D-27, entries in `credential-custody.md` and `custody-map.md`, regenerated `docs/auth-route-contract.md`.

## Staging owner

| Item               | Value                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| E-mail (synthetic) | `owner@mykey-staging.invalid`                                         |
| User id            | `4f26d786-42f6-43d5-9180-1ceccabd502e`                                |
| Organization id    | `e2350312-420b-4fde-84c5-d582a008080b`                                |
| Organization state | `provisioning` (Run 3.8 provisions it)                                |
| Password           | `~/.mykey/secrets/hosts/staging/owner-password` (0600, never printed) |

## Commits

- `refactor(ops): operator tool frame, key rings by number, remote code out of the test harness`
- `feat(ops): idempotent owner bootstrap`
- `feat(auth): sign-in bound to account state and epochs, auth routes on the pipeline`
- this commit: `feat(hosts): key rings and operator commands on staging; docs: operator accounts runbook, D-27`

## Commands and results

| Command                                                                                           | Result                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                                                                       | 717 passed (later 721 with the host tests below)                                                                          |
| `vitest --project integration tests/integration/ops`                                              | 16 passed (bootstrap 14 incl. the kill at each of 7 points and two races; output 2)                                       |
| `vitest --project integration tests/integration/auth tests/integration/api tests/integration/ops` | 131 passed                                                                                                                |
| `vitest --project integration tests/integration/database`                                         | passed (matrix with migration `0005`)                                                                                     |
| `pnpm run check`                                                                                  | exit 0                                                                                                                    |
| `host.ts staging keys init`                                                                       | eight `k1` files created on the workstation and installed on the host (names only printed)                                |
| `host.ts staging ops bootstrap-owner --email owner@mykey-staging.invalid < owner-password`        | `created user 4f26d786-… organization e2350312-…`, exit 0                                                                 |
| `vitest --project staging tests/staging/api.staging.test.ts -t "staging owner and keys"`          | 2 passed: repeated bootstrap → `already_present`, counts unchanged; eight keys `1000:1000 600`, directory `1000:1000 700` |

## Deviations and decisions

- **Migration `0005_operator_only_accounts`** (not in the plan): the plan's test "`api_runtime` cannot run the bootstrap" was false under the Session 2 grants. Later migration numbers shift by one.
- **`authenticated_at` from the database**: `api_runtime` may not update `authenticated_at` (Session 2 matrix), so the API-clock defaults of Better Auth were removed and PostgreSQL's `now()` fills it at insert; the sign-in transaction sets `last_user_activity_at = now()`.
- **`signInWithPassword` writes its own audit rows** and returns the user id and reason beyond the plan's type, for that audit.
- **The M16 case is tested on `relayNative`** with a stub `Response`, not by replacing Better Auth's handler inside the app.
- **Auth bodies go through the pipeline's reader**; an absent body on a POST counts as `{}` (sign-out, enroll), a body on a GET is refused. `requireMfaComplete` now answers an error code (its Session 2 test adapted).
- **`tests/integration/api/health.test.ts` builds the app with `createApp` + `listen`**: the production entry cannot start without throttling until Run 3.3; it goes back to `startServer` then.
- **Staging test fixes**: uid 1000 is called `ubuntu` on the host (numeric `stat` now); staging holds eight synthetic organizations from Session 2 spikes, so the check counts owners and bootstrap rows, not organizations.

## Open issues

- The sign-in checks through the public name are Run 3.8 Task D (no deploy in this run).
- The key directory has no off-host copy yet: the owner should copy `~/.mykey/secrets/hosts/staging/auth-keys/` to the password manager (listed in `credential-custody.md`).
