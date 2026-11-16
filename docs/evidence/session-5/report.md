# Session 5 report — Machine access, CLI and API reference

**Date:** 15–16 November 2026 · **Branch:** `session-5` · **Plan:** `docs/plans/session-5-plan.md`

## Result

**PASS WITH ISSUES.** All ten runs are done.

**The CLI is proven on two of four platforms.** Linux x64 and arm64 ran the whole CLI suite from the released files. Both macOS runners failed on the test suite's own certificates, not on the CLI. The fix is proven on Linux and under LibreSSL, but it has not run on macOS. A second matrix run needs the owner's answer on Actions minutes (owner-requests item 5). FR-1.51, AC-1.37, PO-8 and AGENT-B1 stay `OPEN`.

What now exists, locally on real stores and on staging through the public name:

- **Machine credentials.** The owner (or an admin) issues a token for one environment and sees it once, in the 201. It is revoked, and reads `revoked` only after OpenBao proved it gone. Unknown outcomes block or close instead of guessing. `ops reconcile-credentials` settles an environment from OpenBao.
- **Archive and reactivate.** Projects and environments are closed first, their credentials revoked and verified, and only then archived. Reactivation brings back no token.
- **Machine access.** `keys` and `resolve` authenticate the bearer with OpenBao itself, read with the presented token, and return one generation's complete set, audited before the body leaves.
- **The CLI.** `secrets keys | run | export` start a process only with the complete, validated set, with no `.env` file. It is released as `cli-v0.1.1` with a tested installer (D-44), and two consumer runbooks are rehearsed against staging.
- **The reference.** `/v1/openapi.json` and a self-contained Scalar page at `/v1/reference` are served to owner and admin. In Chromium the page makes no third-party request. Breaking changes against `baseline-v1.json` fail `contracts:check`.

**Registry:** nothing is `PASS`. Items at `SPIKE_PASS` went from 83 to 112; `OPEN` items went from 108 to 79.

The issues:

- **The fresh review** found one Critical and three Important defects. The Critical and two Importants are fixed, each with a failing test first; one Important is carried to Run 6.3. Nine minors are deferred. Details under Step 7.
- **A regression of my own, found by the gate.** Session 3's auth tests used `GET /v1/reference` as their "a product route answers" probe. Run 5.9 turned that stub into a real page that needs the served organization and the Scalar asset. Run 5.9 ran only the reference tests, so 14 auth tests failed first in the clean clone. The fix is test-only; see Step 1.
- **The staging drill's own assumption.** An issuance left unknown has two documented states, and the drill test assumed only one. The product behaved as designed; the test was corrected (Step 5).
- **The workstation's memory again.** Claude Code stopped two gate jobs at low memory: the first full suite, which ran beside the review agent, and the first consumer rehearsal. Both were run again alone.
- **Production was not updated.** The owner did not answer, so the default (no) holds.

## Step 1 — the full suite

From a clean clone outside OneDrive (`C:/Users/gmpar/mykey-gate/session-5`), commit `742afe1` (the review fixes), each suite alone:

| Command                                                    | Result                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                           | exit 0                                                                           |
| `pnpm run check`                                           | exit 0                                                                           |
| `pnpm test`                                                | 74 files, 956 passed                                                             |
| `pnpm run test:integration --maxWorkers=2`                 | 119 files: 1,192 passed, **14 failed** (4 files, below), 34 min                  |
| `pnpm run test:cli`                                        | 8 files, 53 passed                                                               |
| `pnpm run reference:asset && vitest run --project browser` | 4 passed                                                                         |
| `pnpm run test:cloud`                                      | 4 failed, 4 passed: the R2 fixture guard, on purpose since 15 Nov 2026 09:42 UTC |

The cloud failures, all in `tests/restore/retention/fixture.cloud.test.ts`, are the R2 fixture guard: "overwrite of a locked object is denied", "delete of a locked object is denied", "bulk delete returns HTTP 200 with per-object errors" and "probe lock expires". They are expected until Run 6.6.

**The 14 integration failures are mine (Run 5.9).**

- **Where:** `tests/integration/auth/password.test.ts` (5), `auth/sessions.test.ts` (7), `ops/reset.test.ts` (1) and `auth/factors-http.test.ts` (the control).
- **Cause:** the first three probed "a product route answers" through `GET /v1/reference`, a 204 stub until Run 5.9. It now needs the process organization (503 without one) and the Scalar asset (503 without it). `page.test.ts` copies the asset into `apps/api/assets`, so the answer also depended on file order. That is why the workspace never showed it.
- **Fix (test-only, `45b5c1f`):**
  - The probe is `GET /v1/organizations`. `organizations.list` has no action and no scope, so it passes exactly the session checks.
  - The factors-http API serves its owner's organization, stubs `reference.get` and lists `openapi.get` as handled.
- **Proof** (with `apps/api/assets` moved aside): `tests/integration/auth` and `ops/reset.test.ts`, 24 files, 183 passed.
- **Not run a third time:** the full suite was not run again for that commit (ledgered ruling). It changes four test files only, and the pull request's CI runs the whole suite once.

The review fixes were proven file by file before this run:

- `credentials/reconcile.test.ts` 7/7;
- `lifecycle/archive.test.ts` 11/11;
- export, machine and fault tests: 19 files, 171/171;
- the CLI project 53/53.

## Step 2 — dated items and scans

- **Checkpoint `pairs-lock-session-gate`:** recorded at the start of Run 5.4 (15 Nov 2026 10:50 UTC). Reads only: six `pairs/` objects answered HEAD 200 with their upload ETags, and the lock rules were unchanged.
- **Dated items still ahead:**
  - All KMS certificates expire on **12 Dec 2026** (staging seal 10:50 UTC); checkpoint `kms-cert-expiry` from 12 Dec 2026 09:57 UTC.
  - `.trivyignore.images` expires on **14 Dec 2026**.
- **Scans:** `node scripts/ci-scan.ts dependencies` exit 0; `node scripts/ci-scan.ts images` exit 0, covering the API image `45b5c1f3cc3a` (`sha256:e0925d0e…`) and the provisioner (`sha256:d34be3e7…`).

## Step 3 — the CLI release

The busy-retry fix (Important 1) changed the bundle, so the next version was cut:

- **`cli-v0.1.1`** at `3522ef6`. `SHA256SUMS`:
  - `cd9b4c37c6a5d7a9482938d43b77ab65ae9d85c913b4a9f97e6054bcef7ccd4c  mykey-cli-0.1.1.tgz`
  - `51fc09684fe5b6955efc0a7fe4898ec79a0bd2a80eb6aab26c92dbb025f5d0f1  install.sh`
- **Proof:** downloaded fresh, `sha256sum -c` OK; `node scripts/test-cli.ts --release <download>` passed 8 files, 53 tests, with the installed launcher in the Linux container.
- **The matrix of Run 5.7 does not stand for these bytes.** It tested `cli-v0.1.0` (`2412bb17…`). It was not run again (P-99 default, owner unanswered).
- **Runbooks:** `consumer-local.md` and `consumer-deploy.md` name `cli-v0.1.1`.

## Steps 4–5 — staging

**Deploy**, 16 Nov 2026 06:35–06:42 UTC:

- `push`;
- `image api` (`45b5c1f3cc3a`, `sha256:e0925d0e…`);
- `image provisioner` (`sha256:d34be3e7…`);
- `db-init` (applied nothing: `0013`–`0014` were applied in Runs 5.2 and 5.4);
- `up`.

The self-check logged `runtimeLogin: ok` and `issuerLogin: ok`, with no restarts. The gate stayed open (epoch 200); `reviewOpen: 0`, `operationsUnresolved: 0`, the provisioner healthy. Later commits change only the CLI's version and documents, nothing either image holds.

**The staging suite**, one file at a time, this session's files last (06:43–08:30 UTC):

| File                                | Result                                                               |
| ----------------------------------- | -------------------------------------------------------------------- |
| api, boundary, export, identity     | 12, 12, 3, 14 passed                                                 |
| key-loss, pair, probe, provisioning | 2, 12, 4, 5 passed                                                   |
| reconcile, secrets, transport       | 1, 4, 10 passed                                                      |
| unseal                              | 8 passed, **2 failed**; both passed when re-run alone (below)        |
| credentials                         | 1 passed, **1 failed** (the drill, a test defect); 2/2 after the fix |
| machine, archive, cli               | 1, 1, 1 passed                                                       |
| token-sweep (new)                   | 1 passed                                                             |

`kms-expiry` stays out until its checkpoint.

**The unseal failures.** Both are Session 2's tests of the OVHcloud KMS and code this session did not touch:

- "KMS away while running": the probe had not opened `kms_unreachable` within 290 s.
- "rights are what was granted": `okms kmip locate` with the seal certificate exited 1.

Both passed when re-run alone. They are listed as flakes.

**The drill (FR-1.43).** OpenBao is paused to leave an issuance unknown.

- **What it caught:** this time the pause landed after OpenBao had made the token (the accessor was recorded). So the credential went `revoking`: P-87's second branch, closed to machines, which blocks no issuance. The test expected `409` for the next issuance, which only the first branch (`needs_review`) gives.
- **The fix (test-only):** the drill finds the caught credential in the inventory, records its state, and checks the block only for `needs_review`.
- **Re-run:** 2/2 and the same branch again:
  - Telegram alert delivered at **08:36:26 UTC**;
  - `quiesce` → `reconcile-credentials --executors-excluded yes` → "revocations-completed 1";
  - `resume`;
  - alert cleared at **08:37:38 UTC**.
- Run 5.2's drill (15 Nov) caught the first branch: alert at 09:18:27, cleared at 09:19:44.

**The token sweep** (`tests/staging/token-sweep.staging.test.ts` → `token-sweep.txt`):

- **What was searched:** three tokens issued on staging (two resolved, one also listed keys, one never used; all revoked) and one run-time canary resolved by them.
- **Where:** the API's and the provisioner's log, a `pg_dump`, PostgreSQL's log, OpenBao's audit device and Traefik's access log.
- **Result:** 0 found, every control found.
- The other staging files searched their own tokens in the API log, a `pg_dump` and the access log: 0 each. Tokens are stored nowhere, so only the process holding a token can search for it (ledgered ruling).

**The machine journey from a clean machine** (`pnpm run test:consumers`, both runbooks, `cli-v0.1.1`): 2 files, 7 passed, in 16.4 min.

- **The local journeys:** Next.js and FastAPI each ran all 11 blocks. Issue, supply, `secrets run` of the fixture, rotation, after a restore, then revoke and denied. The wrapper's refusals were each 78 with nothing started. The history and argument-list controls were found, and the token was not.
- **The deploy journeys:** Next.js and FastAPI each ran all 9 blocks. `docker inspect` shows the token file's path only; the inspect, arguments, history, image and image-history controls were found.
- **The test's own tokens:** 10 tokens, found 0 times in the working tree and 0 times in the captured output.
- **The project was archived afterwards** (200).
- **The first run** was stopped by Claude Code at low memory near its end; its local FastAPI journey had failed. That result was lost with the stop. The re-run, alone after Docker Desktop restarted, passed everything.

The evidence files of earlier runs that the staging runs rewrite were restored before committing.

## Step 6 — production

Not updated, by default: `owner-requests.md` holds no answer to item 3. Production still runs Session 4's API with migrations up to `0012` and no gate file.

## Step 7 — the fresh-context review

One reviewer read `git diff main...session-5` with the plan, Doc 10 §4.1 and the plan's nine questions. Its findings and what became of them:

| Finding                                                                                                   | Grade     | Outcome                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reconcile-credentials` under exclusion settled an issuance whose own token was found and not proven gone | Critical  | **Fixed** (`742afe1`): such a row stays `needs_review`, listed `unproven`. `reconcile.test.ts` "…its revocation is unproven…" RED (settled 1) → GREEN                                  |
| Concurrent `secrets run` (or one during an import) can fail at once with `503 busy`                       | Important | **Fixed** (`742afe1`): machine reads are asked again after 250, 500, 1,000 and 2,000 ms. `tests/cli/run.test.ts` "503 busy is asked again…" RED (exit 75) → GREEN                      |
| A machine read admitted before an archive's admission could answer after it                               | Important | **Fixed** (`742afe1`): the admission recheck runs again in the commit transaction of every complete read (export too). `archive.test.ts` "…does not answer after it" RED (200) → GREEN |
| One OpenBao call per unauthenticated machine request, with no limit                                       | Important | **Carried to Run 6.3**, which owns every rate limit                                                                                                                                    |

The plan's nine questions, in short:

- **No path found** for questions 2, 3, 5 and 8:
  - no token is delivered before its record commits, or twice;
  - no second create is sent;
  - no machine route reads as `runtime`;
  - the CLI never acts before validation, follows a redirect, runs unverified or sends the bearer early.
- **Question 1 (where a token can reach):** one residual, documented in `consumer-local.md`. The token stays in the CLI's own initial environment while the child runs, so a process of the same user can read it through `/proc/$PPID/environ` or `ps eww`.
- **Questions 4 and 7 (`revoked` without proof; an archive finishing while a token works):** yes, through Critical 1. Also a read window, Important 2. Both are fixed.
- **Question 6 (what a dead, foreign or malformed token can change):**
  - an unauthenticated caller costs one OpenBao lookup each (Important 3);
  - a recognised token can add `access.denied` rows, no more than a live token's `machine.resolve` rows;
  - a live token can starve its environment's writes through `keys`, which takes the environment lock.

  The last two wait for Run 6.3's limits.

- **Question 9 (what the tests do not prove):**
  - macOS;
  - `consumer-deploy` on a real Linux server (WSL was used, Ruling 138), and `consumer-local` on macOS;
  - the reference beyond one Chromium capture outside CI (DNS prefetch and navigation are invisible to it; a Scalar upgrade is unguarded in CI);
  - the archive tick's wiring in `server.ts`, seen only on staging;
  - the compat check's two gaps (minors);
  - FR-1.43's found-but-unproven case, now covered by the gate's fault row.

**Deferred minors**, each with its owner run:

- `operation-sweep.ts`: one `driveArchive` throw ends the rest of that tick's archives and drops the sweep's log line; wrap each in try/catch (Run 6.9, with the host timers).
- `routes/lifecycle.ts`: a `driveArchive` throw inside the request answers 503 without the operation id; a replay recovers it (Session 7, with the archive confirmation).
- `issue.ts`: the known accessor is not stored on a `needs_review` row after an unknown outcome (Run 6.x recovery, with `reconcile-credentials` after restore).
- `archive.ts`: one 60 s issuer session per environment may expire on a large environment, which heals at the next tick (Run 6.3, with the issuance limits).
- `guard.ts`: refuse `--tls-keylog` and `SSLKEYLOGFILE` (Run 8.x, the security review).
- `contracts-compat.ts`: a removed response status and a field that loses `required` are not reported as breaks (Session 7, which consumes the contract).
- The FR-1.48 registry note promised macOS. **Fixed** at the gate (`da0dd88`).
- The CLI's environ: a token-file option read by the CLI itself would keep the token out of every process's environment (after Stage 1, with a standalone executable).
- `routes/credentials.ts`: a 201 that fails output validation would leave an active credential never delivered, answered 503 without the operation id (Run 8.x).

**Rulings the reviewer disagreed with:**

- **46** (archive admission without the advisory lock): the read window is closed by the recheck fix above.
- **32** (`unproven` exits 3 like `needs_exclusion`): the exit stays; the settlement was the defect, fixed.
- **118** (Node `SHASUMS256.txt` over TLS without its GPG signature): stands for now. Checking the signature against the Node release keys at pin time is carried to Run 8.x (supply chain).
- **121** (uninstall removes an empty `~/.local/bin` that existed before): carried to the next CLI release.
- **129** (no second matrix run): stands, and this report says "two of four" first.
- **55** (an unclear verification is recorded as a final rejection): stands under M-6. The `Idempotency-Key` description says a rejected request is retried with a new key.

## Step 8 — the fix pass

- **`742afe1`** (`fix: gate review …`): Critical 1, Important 1 and Important 2, each RED then GREEN as above; `pnpm run check` exit 0.
- **`45b5c1f`**: the probes of the Session 3 tests (Step 1).
- **`3522ef6`**: `cli-v0.1.1`.
- **`da0dd88`**: the drill's two branches, the token sweep, the FR-1.48 note.
- **Re-run:** Step 1's suite at `742afe1` (the fixes); the touched files after `45b5c1f`; the staging suite on the deployed fixes.

## Step 9 — registry

Each run set its own statuses with its run note. At the gate only FR-1.48's note changed; `pnpm run evidence:build` and `pnpm run check` exit 0.

- **This session's items at `SPIKE_PASS`:** FR-1.17, 1.18, 1.39–1.50, 1.52–1.54, 1.79, 1.85; AC-1.11, 1.19–1.22, 1.40, 1.42; PO-2, PO-10, PO-18, PO-20.
- **`OPEN`**, with `cli-matrix.md`: FR-1.51, AC-1.37, PO-8, AGENT-B1 (macOS not proven).
- **Totals:** 112 `SPIKE_PASS`, 79 `OPEN`, nothing `PASS`.

## The fault table (Run 5.2, `fault-table.md`)

- **Cases:** the response lost at each boundary of issuance and revocation, through two API processes (one really killed) and the TLS relay. 11 of 11, three passes in a row.
- **The invariant:** every case ends with the catalog matching OpenBao. Every machine token OpenBao holds is the accessor of an `active`, unexpired row, and every such row's token exists.
- **Mutations:** two mutations each failed their rows.
- **Archive:** a kill at any of its three points is finished by another process's tick. 50 rounds of issuance against archive leave no usable token. 20 rounds of environment create against project archive never leave an environment under an archived project (Run 5.3).
- **The gate added** the unproven-token case of `reconcile-credentials` (`tests/integration/credentials/reconcile.test.ts`).

## Native scope (`native-scope.md`)

A product-issued token used directly against OpenBao 2.7.2 reads and lists only its own environment's path. Every other call is denied, each with a root control: writes, deletes, other environments and projects, token creation, identity, and `renew-self`, which leaves the expiry where it was.

- **One finding, unchanged:** `lookup-self` answers in another namespace with the token's own record.
- **The FR-1.45 residual:** the token can read older versions of its own environment's secrets (`kv/data/<own>/…?version=1` answers 200). KV v2's read capability carries version history. The product never returns them, but a leaked token does reach them.

## The CLI matrix (Run 5.7, `cli-matrix.md`, D-44)

- **The first choice failed:** a Node single executable is "Stability: 1.1 - Active development", and macOS x64 is unsupported. So the fallback was taken: the bundle on the pinned Node 24.22.2 with an installer.
- **One matrix run** (43734935509, `cli-v0.1.0`), about 64 billed minutes:
  - linux-x64 49/49 and linux-arm64 49/49;
  - darwin-x64 and darwin-arm64 16/49 each. All 33 failures were the suite's test certificates under LibreSSL; the installer and launcher worked on all four.
- **The fix** is proven under LibreSSL in a container and on Linux. A second run waits for the owner.

## The capture (Run 5.9, `reference-capture.json`, D-45)

In Chromium 156 (Playwright 1.64.1), `/v1/reference` under its own policy:

- makes exactly one request, the document itself;
- attempts no third-party request and causes zero policy violations;
- makes no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon` call.

Scalar was therefore kept. Mutations that switch on the client buttons, or fonts and telemetry, each fail the capture.

## Measurements

| What                                           | Where                | Result                                       |
| ---------------------------------------------- | -------------------- | -------------------------------------------- |
| One issuance                                   | staging, public name | 697 ms (Run 5.4)                             |
| One resolve of ten values                      | staging, public name | 287 ms (Run 5.4)                             |
| One resolve of 1,000 values of 8 KiB           | local stack          | 5.63 s (deadline 60 s)                       |
| Archive of an environment with two credentials | staging, public name | 878 ms to `archived`, both revoked (Run 5.4) |
| A `secrets run` against the CLI test server    | Linux container      | the CLI project, 53 tests, about 2 min       |

The plan asked for an archive with three credentials. Run 5.4 measured two (deviation).

## Decisions

- **D-40:** the machine credential lifecycle. Issuance and revocation with markers, the sweep, `reconcile-credentials`.
- **D-41:** archive and reactivate. Close first, revoke and verify, then archived. One guarded transition function (migration `0014`).
- **D-42:** machine requests. The bearer is checked by OpenBao itself, reads use the presented token, and the complete set is audited before release.
- **D-43:** the CLI. Thin, complete set or nothing, no shell, signals and status passed through.
- **D-44:** how the CLI is distributed. The bundle on the pinned Node with an installer; a single executable is not stable yet.
- **D-45:** the API reference. One self-contained page, hashed scripts, no request execution, no third party.

## Deviations from the plan

Every deviation is a ruling in its run note; these are the ones that change what was proven:

- **Two of four CLI targets** (Run 5.7): no second matrix run without the owner's answer.
- **`consumer-deploy.md` was rehearsed on WSL Ubuntu**, not on a separate Linux server (Run 5.8, Ruling 138).
- **M-2** (Run 5.9): an `unchanged` import entry whose key moved is that entry's conflict and the import ends `partial`. FR-1.36 reports per key; the plan's text said the import "stops".
- **At the gate:**
  - the commit-time recheck covers every complete read, not only machine reads;
  - the staging images were built at `45b5c1f`, not the pull request's head (same image contents);
  - no third full integration run for a test-only commit;
  - the token sweep covers its own tokens;
  - the archive measurement has two credentials, not three.

## Actions minutes this session

- PR #11 (the plan, docs only): about 2 minutes.
- The CLI matrix (one dispatch): about 64 billed minutes, macOS counted ten times.
- The gate pull request's one CI run: a full run, about 50 minutes by Session 4's measure. The pull request's checks hold the figure; it is not written back here, because each push costs another run.
- Pushes to `session-5` without a pull request ran nothing.

## Open issues (with owner runs)

- **macOS** for the CLI (FR-1.51, AC-1.37, PO-8, AGENT-B1): a second matrix dispatch, about 64 minutes, needs the owner's answer.
- **Rate limits:** unauthenticated machine requests (review Important 3), 60 a minute per credential, and the issuance limits are Run 6.3's.
- **The deferred minors** above, each with its run.
- **The owner's decisions still open:** Actions minutes (items 1 and 5) and production (item 3).
- **Flakes:** two `unseal` staging tests (KMS-side timing) are watched.

## What Sessions 6 and 7 must know

- **Audit (Session 6's views and export)** must show:
  - **the new actions:**
    - `credential.issue` and `credential.revoke` (outcomes `intent`, `success`, `failure`, `unknown`);
    - `machine.resolve` and `machine.keys`;
    - `project.archive`, `project.reactivate`, `environment.archive`, `environment.reactivate`;
    - `operator.reconcile_credentials` (counts only);
    - `system.operation_stuck` and `system.drift_detected` for credential work;
    - `access.denied`;
  - **the actors:** a machine actor (`kind: machine`, the credential id), and `operator` and `system` actors.
- **Limits are Run 6.3's:** 60 requests a minute per credential, the issuance limits, and a limit on unauthenticated machine requests. Today each such request costs one OpenBao lookup.
- **After a restore, every environment needs `ops reconcile-credentials`** before its tokens are trusted. The catalog and the namespace come from two stores of one pair. Run 6.x's recovery runbook must call it.
- **No host timer yet.** `ops reconcile-credentials`, the credential sweep and the archive tick have no host timer outside the API (Run 6.9). Only the API's 30 s sweep drives them.
- **Session 7's workspace gets:**
  - `credentialView`, with the one-time token in the 201 and nowhere else;
  - `credential_not_replayable`, which it must explain to the owner;
  - the archive confirmation, which must name affected scopes and unfinished issuance (FR-1.17) from `credentials.list` and `operations.list`;
  - the reference at `/v1/reference` to link to.
- **The browser project and Playwright** (Chromium revision 1248) exist. `pnpm exec playwright install chromium` is needed once per workstation, and CI does not run the project.
- **Scope valves (Doc 10 §8.2):** neither was used.
  - Valve 2 (CLI platforms cut to Linux x64 and macOS arm64) was not pulled: all four targets stay in scope, and macOS waits for the second matrix run.
  - Valve 4 (archive and reactivate removed) was not needed: both exist and are proven.
  - Separately, the CLI took D-44's fallback: the bundle on the pinned Node, not a single executable.
- **An unknown issuance has two states.** `needs_review` (no token proven) blocks the next issuance. `revoking` (OpenBao made the token, its withdrawal is unproven) is closed to machines and blocks nothing. Both raise `operations_unresolved` until the operator settles them.
- **Dated items:** KMS certificates on 12 Dec 2026 (checkpoint `kms-cert-expiry` from 09:57 UTC), `.trivyignore.images` on 14 Dec 2026, and the R2 fixture guard until Run 6.6.
