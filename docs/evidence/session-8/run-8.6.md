# Run 8.6 — Fix and re-prove

_20 Nov 2026. Plan: `docs/plans/session-8-plan.md`, Run 8.6._

## What was done

**The list (Step 1).** Run 8.5 found no Critical and no High. Runs 8.2 and 8.4 Task A found nothing to fix. Each of the 15 Mediums was either fixed (its fix took under half an hour) or accepted as a stated limit. The dispositions are in each `review-N-*.md`. In `known-limits.md`, the accepted Mediums are the lines marked "Gate R", and they go into Gate R's report.

**The fixes (Step 2), each test first:**

| finding     | what was wrong                                                                               | fix                                                                                                                                                          | the test that failed first                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-1        | Failures were counted only after the answer, so parallel attempts all passed `admit`         | `admit` counts the attempt against the account in its transaction and checks the lock again; a success gives it back (`settle`)                              | `throttle-two-process.test.ts`: 20 parallel wrong passwords from 20 sources, and 20 parallel wrong codes, on two processes (at most five 401, then 429 on both) |
| R1-2 / R4-1 | After a restore, a `password` reset trusted the pair's authenticator and recovery codes      | `initiateReset` refuses `password` while an active enrolment is older than the last `operator.restore_begin`; `reset-account` says to use `--kind mfa`       | `reset-after-restore.test.ts`; `restore/full.test.ts` (owner and admin; the whole file, 10 tests, passed)                                                       |
| R6-6        | A version 1 heartbeat cleared every unknown check, so it hid `checks_unknown`                | Checks a version 1 beat lacks read unknown since the beat                                                                                                    | `evaluate-v2.test.ts` (two tests)                                                                                                                               |
| R5-1        | The export wrote the target in place, so a kill left a partial file                          | A temporary file beside the target, linked into place after write, fsync and close                                                                           | `export-target.test.ts` (the order, and a race at the target)                                                                                                   |
| R5-2        | `NODE_EXTRA_CA_CERTS` (and `OPENSSL_CONF`) let a machine-wide setting decide the CLI's trust | Refused; the CLI's own authority is `SECRETS_CA_FILE` (D-68, reversing D-43 on this point)                                                                   | `guard.test.ts`, `config.test.ts`; `tests/cli/run.test.ts` (AC-1.37: each refusal starts nothing)                                                               |
| R5-3        | SIGUSR1 opened Node's inspector in the process that holds the token; SIGUSR2 killed the CLI  | The launcher starts Node with `--disable-sigusr1`; SIGUSR2 is passed on. Under that flag Node keeps SIGUSR1 blocked, so it is not passed on (a stated limit) | `install.test.ts` (the launcher's text); `run.test.ts` (no debugger and no exit on SIGUSR1; SIGUSR2 reaches the child once)                                     |
| R5-4        | `getconf` was found through `PATH` and inherited the token's environment                     | `/usr/bin/getconf` with an empty environment                                                                                                                 | `run.test.ts`, "a getconf ahead in PATH is never run" (with a control)                                                                                          |
| R4-12, R6-1 | Wording                                                                                      | `known-limits.md` (capture, `--newest`, and a line for every accepted finding); `network.md`, the `mykey.nft` and `okms.sh` comments                         | —                                                                                                                                                               |

The CLI's four fixes make **CLI 0.1.2** (`apps/cli/package.json`). Its release and proofs (`cli-matrix`, `cli.staging`, `test:consumers`) come with the freeze (P-145). The consumer runbooks switch from `cli-v0.1.1` once the release exists.

**The re-read (Step 3).** A fresh reviewer on the most capable model read `git diff 3dd265e..HEAD` and the ten findings as they were first written, and answered the plan's two questions (`review-fixes.md`).

- Nine findings closed, and R4-12 partly closed.
- The fixes opened no Critical, High or Medium, and eleven Lows.
- Back to Step 2:
  - R4-12 (D-66 row D);
  - F-1: the take-back lost its decrement under concurrency. Confirmed before the fix: 28 of 50 were lost. Fixed by matching the row by key;
  - F-3: `SSL_CERT_*` was refused although it adds no trust to Node;
  - F-4a: a refused hard link was reported as an existing output;
  - F-8, F-10 and F-11: false or incomplete statements.
- The other Lows (F-2, F-4b, F-5, F-6, F-7 and F-9) are known limits.

**The probe Worker** was deployed with the R6-6 fix (`node scripts/probe.ts deploy`, 16:19 UTC). Its next evaluations: staging has nothing open, and production has only its stated `checks_unknown` (no OpenBao yet).

## Commits

- `69f61aa` fix(auth): R1-1
- `5201db8` fix(auth): R1-2 R4-1
- `5b7816a` fix(probe): R6-6
- `eefdb31` fix(cli): R5-1 R5-2 R5-3 R5-4 (CLI 0.1.2, D-68)
- `c46bac6` docs(limits): R4-12 R6-1
- `9cd9004` fix(auth): F-1
- `bceca57` fix(cli): F-3
- `a767254` fix(cli): F-4
- `7a214c8` docs(limits): R4-12 F-8 F-10 F-11
- `e5fd83e` docs(evidence): the fixes review

## Commands and results

- **The R1-1 RED step.** `git stash` of the fix, then the two-process file: 10 to 20 of 20 parallel wrong passwords answered 401. With the fix: green three times.
- **`pnpm exec vitest run --project integration`:**
  - `tests/integration/auth/throttle-two-process.test.ts`: 6/6;
  - `throttle.test.ts`: 12/12, three times (F-1 RED first: "expected 28 to be 0");
  - `reset-after-restore.test.ts`;
  - `restore/full.test.ts`: 10/10.
- **`pnpm run test:cli` (the Linux container):**
  - before the R5-3/R5-4 code (stashed): 3 failed (the launcher text, SIGUSR, getconf);
  - after: 56/56;
  - after F-3 and F-4: 57/57.
  - The SIGUSR1 test was shown to fail without the harness's `--disable-sigusr1`: the child received the signal, so a debugger would have opened in the CLI.
- **Unit tests:**
  - `pnpm exec vitest run --project unit tests/unit/cli/ tests/unit/probe/`: 127/127.
  - `pnpm test`: 1467/1467.
- **`pnpm run check`:** green before every commit.
- **CI on the pushes:** the draft's check and secret scan were green (`44759139720`, `44764057215`).

## Deviations and decisions

- **One commit for the four CLI findings** (`eefdb31`). They share `run.ts`, `run.test.ts` and the harness, and ship as one CLI version.
- **SIGUSR1 is not passed on.** Under `--disable-sigusr1`, Node keeps SIGUSR1 blocked, so the CLI never sees it. The disposition planned to forward it. Keeping the inspector shut outranks forwarding. Stated in `known-limits.md`, and the disposition is annotated.
- **The harness starts the bundle with `--disable-sigusr1`**, as the launcher does. The harness also takes a `PATH` the test gives (R5-4's test).
- **The fixes reviewer got `3dd265e..HEAD`, not `7494401..HEAD`.** The longer range also holds the review texts with their dispositions, which are opinion (D-06), and the manifest tool, which is not a fix.
- **`review-fixes.md`** gives the reviewer's text as it came, except that the workstation path of its findings file is replaced by a description.
- **The unit suite timed out once more than usual.** The dotenv fuzz test (`roundtrip.test.ts`) exceeded its 5 s limit twice under the full suite's import load (88% of the run is imports). It passed alone in 1.9 s and in every full run after. That is load on the workstation, not a defect; CI's runs were green.
- **No route, contract or migration changed.** No restore code changed (P-150): the R1-2 refusal is in `packages/auth`, and the restore test only gained assertions.

## Open issues

- **CLI 0.1.2** is built at the freeze, where its release, `cli-matrix`, `cli.staging` and `test:consumers` run, and the consumer runbooks switch to it (Run 8.1 Task B).
- **Open Mediums for Gate R** (stated limits): R2-1, R3-1 (D-65), R3-2, R4-2, R4-3, R4-4, R4-5, R4-10 and R6-1. R4-2, R4-3, R4-4, R4-7, R4-10, R4-13 and R4-14 are carried to Session 9 (P-150).
- **The full integration suite** runs at the gate, on CI (D-58).
