# Run 8.2 — The second organization attacks

_20 Nov 2026. Plan: `docs/plans/session-8-plan.md`, Run 8.2 (P-151, D08-S43)._

## What was done

A new fixture, `tests/integration/isolation/fixture.ts`, builds two organizations on one stack.

- **Side A** is the credentials fixture's organization, served by the in-process API that holds A's runtime identity.
- **Side B** is provisioned by `provisionTestOrganization`. Its environment is made by the product's own provisioner, running as a child process against its own gate file. B is served by a second API process (`startApiProcess`) on the same database, keys and OpenBao, holding B's runtime identity.
- **Each side has:** a project, an environment, a secret, an import preview, a machine credential and its token, an operation, and an owner session.

Six attack files under `tests/integration/isolation/` (shared comparison in `answers.ts`):

| File                  | What it attacks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Tests |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `foreign-ids.test.ts` | Every human route of `ROUTES` with path ids. It is asked four ways: by B's owner with A's ids and by A's owner with B's ids, each on A's API and on B's API. Every answer is compared with the same request using random ids: status, sorted header names, body (request id replaced) and length. B's ids of the right kind are tried under A's own path. A's machine token is tried on B's project. The test has a control for the comparison.                                                                                                           | 4     |
| `selectors.test.ts`   | Every route of `ROUTES` (but the reset flow) with `namespace`, `path`, `role`, `policy`, `organizationId` and `environmentId` naming B's real values. These go as query keys, as body keys and as headers (`x-vault-namespace`, `x-vault-token` with B's machine token, `x-organization-id`). Afterwards B's rows in every `app` table are unchanged (count and digest), no answer names a B id, no route logs an unlisted error, and OpenBao's audit device holds no request in B's namespace. A control shows that the same search sees B's own reveal. | 2     |
| `cursors.test.ts`     | The seven cursor-paged list routes, each with: every other route's cursor, B's cursor of the same route, and its own cursor under another filter. Plus a check that the list of routes in the test is the list in `ROUTES`.                                                                                                                                                                                                                                                                                                                               | 2     |
| `aggregates.test.ts`  | A's overview, credentials summary, metrics, activity and audit are read before and after B gains a project, a secret, a credential, an `uncertain` operation and five reveals. They are equal but for the observation time, and hold no id, name or request id of B.                                                                                                                                                                                                                                                                                      | 1     |
| `timing.test.ts`      | 100 interleaved pairs, in random order, of hidden against absent: a project read, a reveal, an operation status, and a sign-in with a known address against an unknown one.                                                                                                                                                                                                                                                                                                                                                                               | 2     |
| `backend.test.ts`     | OpenBao directly: A's three AppRole pairs in B's namespace and in the root namespace, and A's machine token on 14 KV, token and sys paths of B's namespace. PostgreSQL directly: as `api_runtime`, an UPDATE of every `organization_id`, `project_id` and `environment_id` column of schema `app` (the list comes from the catalog), plus a control.                                                                                                                                                                                                      | 3     |

Additions to existing files:

- **`tests/integration/auth/routes.test.ts`:** every refused native route under nine spellings answers the contract's 404 and creates no row. The spellings are upper case (path and prefix), percent-encoding of a letter and of the slash, `;x` and `;` suffixes, `/x/..`, `/x/%2E%2E` and `/v1/x/../auth`.
- **`tests/staging/identity.staging.test.ts`:** a new test, "every refused native route answers 404 on staging", over `NATIVE_DENIED` through the public name.
- **`tests/staging/privileges.staging.test.ts`** (new): "the privileges in staging's database equal the matrix" (`matrixProblems` over `stagingDatabase`). It reads the catalog only.

### Findings

**One finding, fixed here (under ten lines, as the plan allows): `health.get` could log `unlisted_error`.**

- **The defect:** `health.get` lists no error codes, because it always answers its own body. Yet the pipeline still read its query string and body. A `GET /health?namespace=…`, or a GET with a body, was refused `400 malformed_request`, and the API logged `unlisted_error` for `health.get`.
- **How it was found:** the selectors test (query and body placements) hit it twice. The harness's close check failed with "the API logged unlisted_error for: health.get, health.get".
- **The fix:** `apps/api/src/pipeline/route.ts` reads neither for `health.get`.
- **The test:** the selectors test now also asserts that no `unlisted_error` was logged. It was RED with both entries, then RED with the body entry alone after the query half of the fix, then GREEN.

Two observations, neither a finding:

- **`auth/token/lookup-self`:** sent with A's machine token and B's namespace header, OpenBao answers 200. It describes the caller's own token: `namespace_path` is A's, and the answer holds no id of B. The test now asserts exactly that, instead of 403.
- **A's machine token on B's API:** B's API serves only B's catalog, so it answers `401` for B's project and for an absent project alike. A's API answers `404` for both. The answers are the same on each API, which is what the test requires.

**Cursor answers per route** (the test names them):

- Another route's cursor, or B's cursor of the same route, is `400 malformed_request` on all seven routes.
- Its own cursor under another filter:
  - `secrets.list` and `operations.list` answer `400 malformed_request`, because they sign the filter into the cursor. Their `409 listing_changed` means a write between two pages.
  - `audit.list` and `activity.list` answer `409 listing_changed` (`audit.md`).
  - `projects.list`, `environments.list` and `credentials.list` have no filter.

**Timing medians** (100 pairs each, workstation, local stack):

| Request                                         | Hidden   | Absent   |
| ----------------------------------------------- | -------- | -------- |
| project read                                    | 28.3 ms  | 28.0 ms  |
| reveal                                          | 30.1 ms  | 30.5 ms  |
| operation status                                | 28.3 ms  | 25.2 ms  |
| sign-in (known/unknown address, wrong password) | 125.2 ms | 120.3 ms |

FR-1.13 SPIKE_PASS — A's AppRole pairs log in nowhere but A's namespace; A's machine token gets 403 on every KV, token and sys path of B's namespace; api_runtime cannot change an identity column of schema app; staging's grants equal the matrix (`tests/integration/isolation/backend.test.ts`, `tests/staging/privileges.staging.test.ts`).

AC-1.07 SPIKE_PASS — guessed and real foreign ids answer as ids nobody has on every human route and both APIs; forged selectors change nothing of B and reach nothing in B's namespace; cursors, aggregates and timing reveal nothing of B (`tests/integration/isolation/foreign-ids.test.ts`, `selectors.test.ts`, `cursors.test.ts`, `aggregates.test.ts`, `timing.test.ts`, `tests/integration/auth/routes.test.ts`, `tests/staging/identity.staging.test.ts`).

## Commits

- `test(isolation): the second organization attacks through every route and both stores` (this run's code, the `health.get` fix, the run note and the registry).

## Commands and results

- `pnpm exec vitest run --project integration --reporter=verbose tests/integration/isolation tests/integration/api/health.test.ts tests/integration/api/pipeline.test.ts --maxWorkers=2`: 8 files, 46 tests passed.
- `pnpm exec vitest run --project integration tests/integration/auth/routes.test.ts`: 9 passed.
- `pnpm run test:staging tests/staging/privileges.staging.test.ts`: 1 passed (staging on `host-v0.7.0`).
- `pnpm run test:staging tests/staging/identity.staging.test.ts -t "every refused native route"`: 1 passed, 14 skipped. Only the new test was run, so the file's resets and sign-ins were not repeated before the freeze. The whole file runs at the one pass.
- `pnpm run evidence:build`: 191 items.
- `pnpm run check`: green.
- CI of the earlier pushes (Run 8.0 Task C and its note): green, 2m08s and 2m17s.

## Deviations and decisions

- **The plan's selectors test names "during all of it OpenBao's audit device shows no request in B's namespace"** as a test of its own. It is an assertion at the end of the selectors test instead, because it searches the audit lines that test's requests wrote. The control is its own test.
- **The plan says "no id, name or request id of B is in any of them"** as a second aggregates test. It is the second half of the one aggregates test, because it reads the same "after" bodies.
- **`auth.reset.complete` is left out of the selectors sweep.** It needs a reset session; `identity` and the reset tests cover it.
- **The `health.get` fix is made here, not in Run 8.6:** it is under ten lines.
- **Staging's identity file was run with a name filter,** for the reason given under Commands and results.

## Open issues

- None from this run. The full integration suite and the full staging files run at the one pass (Run 8.3).
