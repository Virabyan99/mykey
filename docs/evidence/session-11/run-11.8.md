# Run 11.8 — The freeze, the review, `host-v0.10.0` and `cli-v0.2.0` on staging

**Date:** 26 Nov 2026. **Branch:** `session-11`. Spec §6; D-80 to D-83.

## Result

Staging serves `host-v0.10.0` (source `5e13f421a4e6`), gate open. Every staging file the plan names is green on it: the two new files, the deploy, and 22 files of the no-regression pass with the credential drill and the probe's file. The published `cli-v0.1.2` works against it as before. **One thing is not green: `pnpm run test:consumers`,** which ran out of memory on the workstation (below).

## Task A — the freeze and the review

- The full suite ran by hand at `87d7871`: CI run 45715978673, green.
- One fresh-context review of `472cda42a52c..87d7871` (`review.md`): no Critical, no High, one Medium, seven Low.
  - **Fixed test-first** (`4114239`): M1 (a dead credential is a miss of its source), L1 (a revocation is waited for), L2 for the owner's revocation, L7 (a control for a log search).
  - **Lines of `known-limits.md`:** L3 to L6, and what M1 and L2 leave.
- The claims walk (`claims.md`): 56 claims; one sentence of the project page corrected.
- The full suite again at `5e13f42`, the candidate's source: CI run 45720586150, green (`check`, the scans, `browser`, both integration shards).

## Task B — the two releases

| Release        | Built from                                 | Published (UTC)   | Sums (SHA-256)                                                                                                                                                            |
| -------------- | ------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli-v0.2.0`   | the clean clone at `5e13f42`               | 25 Nov 2026 23:40 | `mykey-cli-0.2.0.tgz` `7abc64493e302de72b290606b156c6e707e4f3271352001680b064871f1629a4`; `install.sh` `c1072998b5b2b728aacb6e9437f7d5f59a2a69804e53f1430bcb37d95d285955` |
| `host-v0.10.0` | the clean clone at `5e13f42`; three images | 25 Nov 2026 23:55 | `release.json` `457ebd63830db668b9ca1c0c6a88b455da5cb25144e8344b1c4555bcaf667b26`; the images' ids are in `candidate.json`                                                |

- `cli-v0.2.0` was tested before it was published: `pnpm run test:cli --release <its directory>`, 10 files, 80 tests.
- `cli-matrix` for `cli-v0.2.0`: CI run 45723155073, green on linux-x64, linux-arm64, darwin-x64 and darwin-arm64.
- `tools/agent-runner` now takes `cli-v0.2.0`.

## Task C — staging

### The deploy

`deploy.staging.test.ts` with `MYKEY_RELEASE_NEW=host-v0.10.0` and `MYKEY_RELEASE_PREVIOUS=host-v0.9.2`: 1 of 1, 597 s. The gate opened at 2026-11-26T00:11:54Z, epoch 18; migration `0019_automation_and_runtime` is applied.

**The rollback was refused, as designed.** `host-v0.9.2` ends at migration `0018`, and the deploy plan refuses a release that ends before the host's last migration (`downgrade: the release ends at 0018_incarnation, the host is at 0019_automation_and_runtime`). The plan expected the old three-step test to pass; that was a defect of the plan. The test now asserts the refusal: exit not 0, the line above, nothing quarantined, the running images and the gate record still the new release's. **From `host-v0.10.0` on, a host goes back only by a restore.**

### The two new files

| File                         | Result | Figures (one run)                                                                                                                                                                                                                                 |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-credential.staging` | 3 of 3 | issue 244 ms, exchange 244 ms, 25 values 364 ms, metadata 311 ms, revoke 197 ms. The fleet: ten servers, the first round 11.4 s, both rounds 19.7 s. 48 values searched on five host surfaces, 0 found, every control found.                      |
| `automation.staging`         | 2 of 2 | one tenant in 19.7 s (25 secrets 15.8 s); the CLI starts a server with 25 values; five denials beside their controls; a revoked server exits 77 and comes back by `reissue` in 2.4 s with 26 values. 14 values searched, 0 found, controls found. |

- **The exchanged token's lifetime read 901 s** by the workstation's clock: `expiresAt` is the host's, and the test allows 5 s of difference.
- **The fleet's 19.7 s is 0.3 s inside the specification's 20 s.** The test's own bound is 60 s. One run is not a bound (`acceptance.md`, S11-8).
- `callerNetwork` reads the caller's address from the edge's log on the host. The address is registered as a secret and is in no evidence file.

### No regression

The published `cli-v0.1.2` (downloaded, sums checked, its bundle unpacked) ran `cli.staging.test.ts` through `MYKEY_CLI_DIST`:

- with a 30-day token: keys, run, export with mode 600, then exit 77 after the revocation, as in Session 5;
- given a runtime credential's client secret: exit 77, nothing started. `cli-v0.2.0` starts with it.

Evidence: `staging-cli-released.json`. The plan's command for this (`test:cli --release` against staging) does not exist in that form: `test:cli` runs against a local server.

The staging files of Session 10's results, one at a time (UTC, 26 Nov):

| File               | Result   | Note                                                                                                                               |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `api`              | 12 of 12 |                                                                                                                                    |
| `identity`         | 15 of 15 |                                                                                                                                    |
| `status`           | 3 of 3   |                                                                                                                                    |
| `privileges`       | 1 of 1   |                                                                                                                                    |
| `secrets`          | 4 of 4   |                                                                                                                                    |
| `export`           | 3 of 3   |                                                                                                                                    |
| `machine`          | 1 of 1   |                                                                                                                                    |
| `cli`              | 2 of 2   | this tree's build (0.2.0); the new second test starts with a runtime credential                                                    |
| `workspace`        | 1 of 1   |                                                                                                                                    |
| `archive`          | 1 of 1   |                                                                                                                                    |
| `provisioning`     | 5 of 5   |                                                                                                                                    |
| `audit`            | 5 of 5   |                                                                                                                                    |
| `transport`        | 10 of 10 | second run. The first was 8 of 10: a stale test (below)                                                                            |
| `token-sweep`      | 1 of 1   | extended: 9 values with the three new shapes, six surfaces, 0 found (`token-sweep.txt`)                                            |
| `sweep`            | 10 of 10 |                                                                                                                                    |
| `credentials`      | 1 of 1   |                                                                                                                                    |
| `reconcile`        | 1 of 1   |                                                                                                                                    |
| `limits`           | 2 of 2   |                                                                                                                                    |
| `backup`           | 6 of 6   |                                                                                                                                    |
| `alerts`           | 16 of 16 | second run, 86 min. The first was 12 of 16: the workstation shut down on low battery (ssh: "Network is unreachable")               |
| `unseal`           | 10 of 10 | the reboot: `/health` 200 after 34 s; KMS away at start: unsealed 36 s after the block ended; the deleted-certificate half not run |
| `boundary`         | 12 of 12 |                                                                                                                                    |
| `credential-drill` | 1 of 1   | caught on attempt 4 of 5 (attempt 1 in Session 10), state `needs_review`, settled by `reconcile-credentials`                       |
| `probe`            | 4 of 4   | last and alone; the blackout's alerts delivered after 178 s and 238 s, both resolved 541 s after the host went dark                |

Not run, as the plan says: `drill`, `redrill`, `key-loss`, `kms-expiry`, the three agent files. Also not run: `backup-night`, `host-sys-call` (Session 10's results do not name them).

### `test:consumers`: red, for the workstation's memory

`pnpm run test:consumers` ended 2 passed, 3 failed, with a worker that could not start (`0xC0000142`). Free memory was 2.3 GB while Docker's VM held 4.2 GB.

- The two local-runbook tests passed (30-day tokens, `cli-v0.2.0`).
- The Next.js deploy rehearsal, **now with a runtime credential**, ran every block of `consumer-deploy.md`, the rotation and the refusal after the revocation, and failed at its last search, where `tar` could not be started. The FastAPI one failed at its first step (`mktemp` could not be started). The third failure counts what the other two left out.
- So valve 3 is neither taken nor closed: the file is red, and a red file proves nothing. It needs one run with memory free.
- Its leftovers (four containers, two images) were removed by hand. The credentials it issued on staging live an hour.

## Stale tests and plan defects, fixed as tests

- **`transport.staging`** expected production's `/health` to answer 503 ("closed"). Production is open since 22 Nov. Both hosts now expect 200; the chain, HSTS and the forwarded-header checks are the same on each.
- **`deploy.staging`:** the refused rollback, above.
- **`consumers/runbook.test.ts`:** the deploy half issues runtime credentials; the local half keeps 30-day tokens.
- **`scripts/sweep-ci.ts`** counts the `mkrc.` and `mkac.` shapes with the tokens (unit test first).

## Findings

- **A line of this session's own was wrong.** `known-limits.md` said no test shows the edge replacing a client's forwarded header. `transport.staging` shows it on both hosts ("ignores forwarded headers sent by the client"). The line and the review's answer to L6 now say so.
- **"`cli-v0.1.2` given a runtime credential exits 77" is now run,** not derived. The line and its claim were changed (`claims.md`: 54 TRUE, 1 CORRECTED, 1 TRUE BY RULE).
- **A background job that Claude Code stops for memory is not stopped.** Twice the wrapper was ended and the pass's script and its test went on. The first time the script went on to `boundary` at the moment `transport` was started again by hand: two staging files ran together for about a minute. Both passed; a failure of either would have been a rerun. After a "stopped" job, look for the script and its children (`Win32_Process`) before starting anything.
- **The credential drill needed four of its five attempts.** D-78 keeps five; one more miss and the file is red on timing alone.

## Commands and results

| Command                                                              | Result                             |
| -------------------------------------------------------------------- | ---------------------------------- |
| `gh workflow run ci --ref session-11` at `87d7871`, and at `5e13f42` | green, green                       |
| `gh workflow run ci … -f jobs=cli-matrix -f cli_release=cli-v0.2.0`  | green, four targets                |
| `deploy.staging.test.ts` (`host-v0.10.0` over `host-v0.9.2`)         | 1 of 1                             |
| the two new staging files                                            | 3 of 3, 2 of 2                     |
| `MYKEY_CLI_DIST=<cli-v0.1.2> … cli.staging.test.ts`                  | 2 of 2                             |
| 24 staging files, one at a time                                      | all green; two on their second run |
| `pnpm run test:consumers`                                            | **2 passed, 3 failed** (memory)    |
| `pnpm run check`                                                     | green                              |
| CI on the draft pull request (#27) after `15400d5`                   | green (`check` and `secret-scan`)  |

## Open issues

- **`test:consumers` must run again** before the gate counts the deploy runbook with a runtime credential.
- **No rollback across migration `0019`:** staging, and later production, go back only by a restore.
- **L3 and L4 of the review** are design questions for the owner: nothing bounds what one automation credential makes but its 120 requests a minute, and `machine.metadata` writes no audit row.
