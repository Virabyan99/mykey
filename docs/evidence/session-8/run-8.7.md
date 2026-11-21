# Run 8.7 — Full acceptance run and evidence manifest

_20–21 Nov 2026. Plan: `docs/plans/session-8-plan.md`, Run 8.7 (D08-S45), with Run 8.3 Step 2 and Run 8.4 Task B, which run in its pass._

## What was done

**Task A — the manifest's tool** (`3dd265e`, during Run 8.5's wait).

- `scripts/release-manifest.ts` builds `manifest.md` from `proof-map.json`, `results.json` and `candidate.json`. With `--apply` it sets the registry's statuses.
- It refuses, by id:
  - a missing entry or file;
  - a red or absent result;
  - a ci result whose commit differs from the candidate in a product path;
  - an `earlier` item without its evidence, what changed since, or the covering files.
- It has no force. `registry-verify.ts` allows PASS only with `manifest.md` among the evidence.
- `proof-map.json` maps each of the 85 release ids to its files. Gaps were either closed by small tests in Runs 8.6 and 8.7 or written as "not proven" (the ledger's ruling of Task A).

**Task B — the one pass, on `host-v0.8.1`.** Each staging file started in a fresh minute. Committed evidence files of earlier sessions that a file rewrote were restored afterwards.

| Group               | Files and results                                                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A (quiet)           | `api` 12, `identity` 15, `status` 3, `privileges` 1, `secrets` 4, `export` 3, `machine` 1, `cli` 1, `workspace` 1, `archive` 1, `provisioning` 5, `audit` 5, `transport` 10, `token-sweep` 1, `sweep` 10: **15/15 files green** (12:37–13:13 UTC)                                 |
| B (drills)          | `limits` 2/2, `backup` 6/6 green. `reconcile`: red once (13:25), green on repeat (13:36). `credentials`: red twice (13:14, 13:45), see below                                                                                                                                      |
| C (stop or restart) | `deploy` (`host-v0.7.0` → `host-v0.8.1`, back and forward, AC-1.33's rollback) 1/1, `alerts` 16/16 (1 h 28 min), `key-loss` 2/2, `boundary` 12/12 (the reboot; no `mykey-*` unit failed), `api` 12/12 once more. `probe` and `unseal`: red, then green after test repairs (below) |
| Elsewhere           | `test:consumers` 7/7 (14 min); `test:cloud` 14/14; `cli-matrix` `44910370096` green on Linux x64 and arm64, macOS Intel and arm64; full CI `44900136280` (at `9af7051`) and `44910394283` (at `a11669e`), every job green                                                         |
| Secret sweep of CI  | `node scripts/sweep-ci.ts` over both CI logs and the four `cli-report` artifacts: **0 found in 6 files**                                                                                                                                                                          |

**Not run, by ruling:**

- `drill` (P-150);
- `kms-expiry` and `checkpoints/pair-30-day`, which are not due;
- `backup-night`, because the nightly pair of 21–22 Nov had not yet run on the candidate.

**The four red staging files, diagnosed before anything changed:**

1. **`probe`: a stale assertion.** The test still expected `checks_unknown` on production. Its own comment said "the day production gets its OpenBao this is [] again", and production got its OpenBao in Run 8.1. Fixed in `d7e5b08`.
2. **`unseal`: a window too tight.** The test looked for `kms_unreachable` for 290 s inside a 300 s KMS block. The condition opens after three minutes of bad reports, plus up to a minute until the first heartbeat, plus the cron's minute. It opened at 292 s (earlier runs: 255–279 s).
   - Fixed in `d7e5b08`: the block is 420 s and the window 410 s.
   - The rerun opened it at **300 s**, and would have failed the old window again.
3. **`probe` again (rerun): a bound too tight.** The blackout's `health_failing` was delivered at 304 s, against the test's 300 s bound. Doc 06 §12 gives a check every minute and a three-minute grace, and the cron can run a minute late.
   - Earlier runs took 170–290 s.
   - The bound is now 360 s (`eb84e56`). The `alerts` file's own bound is 600 s.
   - The test that followed met a host still dark from the blackout. Staging came back by itself at 17:44:51 UTC with its gate open. `mykey-sweep.service` failed once during the blackout and succeeded at 17:45.
   - The final rerun was green: delivered at 227 s, resolved at 533 s.
4. **`credentials`: the drill of an issuance left unknown was red in both runs.**
   - 20 attempts caught no issuance after its marker.
   - The pause of OpenBao reaches the host over SSH 2.5 to 3.4 s after it is sent, so the five shots aimed at the last landing either finished first (201), were refused `busy`, or were caught before the marker (correctly `503 dependency_unavailable`). The window after the marker is one OpenBao call.
   - The same fault, placed exactly, is proven on CI by `tests/fault/credentials/issuance.test.ts`.
   - The drill is now a file of its own, `credential-drill.staging.test.ts` (`8367205`, unchanged). The journey it shared a file with (issue, inventory, replay, revoke, the token searched on the host) proves AC-1.42 alone, and was green on the candidate at 17:56 UTC.
   - AC-1.18, AC-1.40, AC-1.57 and PO-18 are written NOT PROVEN, with that reason and their other files.

**The final reruns on `host-v0.8.1`:** `credentials` 1/1, `unseal` 10/10 and `probe` 4/4, from 17:56 to 18:40 UTC. Every one of the pass's 33 staging runs is in `results.json`, the red ones included.

**Run 8.4 Task B — the sweep on the candidate.** `sweep.staging.test.ts` ran 10/10 at 13:10 UTC. All 18 surfaces were searched for 25–26 needles: **0 found, every control found** (`run-8.4-sweep.txt`, the candidate's header).

**Run 8.3 Step 2.** `reconcile`, `archive` and `backup` are green on the candidate. `credentials` is as above. The exact placement of the drill's fault is the table's `tests/fault/credentials/issuance.test.ts` (`run-8.3.md`).

**Task C — the claims and the manifest.**

1. **The claims walk** (`claims.md`, 265 rows): 13 corrections, all made.
   - Four were texts of the page: C5 (Help), C11 (the error explanations), C12 (secrets) and C13 (export). They claimed more than the product does, which FR-1.102 forbids, so they made `host-v0.8.1` by P-145 (`9af7051`, `tests/unit/web/claims.test.ts`).
   - The other nine were documents. C1 is also shown on the Help screen, through `known-limits.md`.
2. **The manifest** (`656b260`) passes without force:
   - **PASS 144**, 9 of them `earlier`: AC-1.33, AC-1.43, AC-1.44, PO-9, PO-22, KMS-L1, DB-G1, R2-L1, COST-B1;
   - **NOT YET DUE 7**: AC-1.53, AC-1.54, AC-1.58, AC-1.59, FR-1.98, FR-1.99, FR-1.100;
   - **NOT PROVEN 9**: AC-1.18, AC-1.25, AC-1.26, AC-1.36, AC-1.40, AC-1.52, AC-1.55, AC-1.57, PO-18.
   - 31 FRs stay below PASS because a scenario that names them is not proven, FR-1.101 among them.
   - `--apply` set the registry's statuses, and `check` is green.
3. **A defect of the tool, found by its own test.** When a scenario stopped being PASS, an FR the registry already held as PASS kept that status. `release-manifest.test` went red against the applied registry. The tool now writes such an FR as `OPEN`.
4. **`registry.test`** asserted "claims no PASS". It now asserts that every PASS carries the manifest, and that a PASS without it is refused.

## Commits

| Commit    | What                                                                  |
| --------- | --------------------------------------------------------------------- |
| `3dd265e` | the manifest's tool                                                   |
| `a0cfc70` | root `.md` files are allowed changes for a ci result                  |
| `9af7051` | the page's texts claim no more than the product does; the claims walk |
| `a11669e` | `host-v0.8.1` is the candidate                                        |
| `d7e5b08` | `probe` and `unseal` repaired as tests                                |
| `8367205` | the credential drill is a file of its own                             |
| `eb84e56` | the blackout's bound is the probe's worst case                        |
| `656b260` | the release manifest; the tool's FR defect; `registry.test`; D-63     |

## Deviations and decisions

- **`host-v0.8.1`** was needed for the page's texts (the claims walk). Group A on `host-v0.8.0` had been green 13/13, as a pre-check.
- **Root `.md` files** are allowed changes for a ci result: README and CLAUDE.md build nothing.
- **Three staging tests were stale or too tight.** Each was repaired as a test, with its reason in the commit and the test, and each passed on the candidate afterwards.
- **The drill.** It was not tried a third time: the owner asked for speed, and 20 attempts had found its aim wrong, not its luck. It was given its own file so that AC-1.42 stands on the journey. Its four ids are NOT PROVEN, and the re-aim goes to Session 9.

## Open issues

- **The credential drill's aim (Session 9).** The pause has to land after the dispatch marker. One way is a pause triggered on the host, by the API's own marker, instead of over SSH.
- The `NOT PROVEN` items of the manifest, each with its reason (Gate R, section 4).
