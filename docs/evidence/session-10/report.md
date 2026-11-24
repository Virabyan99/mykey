# Session 10 — Report

**Dates:** 23–24 Nov 2026. **Branch:** `session-10`, PR #24. **Plan:** `docs/plans/session-10-plan.md` (the hardening session, D-75). **Execution:** inline, one agent (`superpowers:executing-plans`); rulings in the ledger, carried into the run notes.

## Result, item by item of D-74

| D-74 item                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The panel's token step as one silent command** (F-9.2-1) | **Done.** One `bash -c` line that reads first, the same bytes in the connect panel, both consumer runbooks, `machine-credentials.md` and the agent guide (D-76). Proven in a pseudo-terminal on Linux, 11 of 11, with a control that reproduces the old leak. `cli-matrix` passed on macOS, but under Homebrew's bash 5, so macOS's bash 3.2 is not proven (valve 3, partly). The names-only command prints names only (the `awk` form, F-10.0-1). `test:consumers` passed with the new block (7/7). |
| **The restore re-drill, with a test for `hostSysCall`**    | **Done, with one red check that the drill itself caused.** `hostSysCall` has a unit test and ran on staging before the reinstall (Run 10.2). Staging was reinstalled and restored onto its own server on `host-v0.9.2` (D-77). The gate opened 75.6 minutes after step 4, against RR-2's 120. All 20 report checks were ok, and every old credential was refused. `redrill.staging` was 15 of 16: the restored pair was not P (below).                                                               |
| **The credential drill re-aimed**                          | **Done.** A trigger on the host freezes OpenBao at the token create's audit record (D-78). It caught the issuance on its first attempt, 0.98 ms after the record, and the file passed to its end.                                                                                                                                                                                                                                                                                                    |
| **Connect a real application**                             | **Not this session's** (D-75): the owner's, after it. The agent setup for it is ready: `llms.txt` and one guide (D-79), proven by one real agent on a staging fixture.                                                                                                                                                                                                                                                                                                                               |
| Outside the list: the reviewers' M1 change (R3-1, D-65)    | Stage 2, as D-74 says.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Production** serves `host-v0.9.2` (`0486f24c3b6e`), opened through the owner's journey at epoch 11, 23 Nov 18:14:27 UTC. **Staging** serves `host-v0.9.2` on its reinstalled server, unsealed by `staging-seal-3` (ends 24 Dec 2026, 10:28:57 UTC).

## The release manifest

`node scripts/release-manifest.ts --session 10`, applied: **161 PASS** (35 of them `earlier`), **7 NOT YET DUE**, **5 NOT PROVEN** (AC-1.25, AC-1.26, AC-1.36, AC-1.52, AC-1.55).

- Session 9 had 144 PASS. The four drill ids (AC-1.18, AC-1.40, AC-1.57, PO-18) are now PASS, and with them 13 FRs that only they held back. The plan's "148" counted the ids, not the FRs.
- AC-1.43, AC-1.44, PO-22 and AC-1.57 keep their clean-host item as `earlier`, now Run 10.6's re-drill. Its 15 of 16 and the cause are written into that item.
- The CI result is the ready pull request's full run 45425329696 at `ce09269`. `field-day.sh` and `scripts/host-restore.ts` differ from the candidate's source and are listed as tooling in `candidate.json`.

## What ran where, once

| Run               | What                                                                                                                         | Real time                                                                | Box       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------- |
| 10.1              | The token step and the names-only command (D-76)                                                                             | about 1 h 45 min                                                         | 2.5 h     |
| 10.2              | What the drill needs: `hostSysCall`'s test and staging run, `probe.ts secrets --host`, the re-drill file, the clock          | about 1 h 15 min                                                         | 2 h       |
| 10.3              | The credential drill's trigger, local part                                                                                   | about 1 h                                                                | 1 h       |
| 10.4 A, B         | `llms.txt` and the guide, kept equal to the code by a test (D-79)                                                            | about 1 h 45 min                                                         | 2.5 h     |
| 10.5 A–C          | The freeze and its review, `host-v0.9.2`, staging (deploy, workspace, api, status, sweep), `cli-matrix`, `test:consumers`    | about 3 h, with `test:consumers` twice (the first killed for low memory) | 2.5 h     |
| 10.4 C            | The agent proof: run 1 failed, the guide fixed once, run 2 passed (3,784 s, $3.08)                                           | about 2 h 30 min                                                         | 1 h       |
| 10.5 D            | Production on `host-v0.9.2`, with the owner's journey                                                                        | about 25 min                                                             | (in 10.5) |
| 10.6 A            | Inventory, the window's estimate, the `expiry` instance saved, pair P, staging declared lost                                 | about 40 min                                                             | 0.5 h     |
| The owner's block | Production's journey; staging's reinstall, password, tunnel, certificate                                                     | about 1 h, over two sittings                                             | 1 h       |
| 10.6 C            | The restore (three runs of its phase), the work after it, the nine staging files with one defect and three stale tests found | about 4 h 30 min                                                         | 2.5 h     |
| 10.6 D            | The order measured, the credential drill                                                                                     | about 25 min                                                             | 0.75 h    |
| 10.7              | The manifest, full CI, the review of the code after the freeze, this report                                                  | (this run)                                                               | 1 h       |

10.4 C and 10.6 C passed their boxes. 10.4 C stayed under twice its box apart from the agent's own 63-minute run. 10.6 C came close to twice its box, and no valve was taken: the restore had opened inside its window, and what followed was finding and fixing defects.

## The token step's cases

In a pseudo-terminal, an interactive outer shell, the token assembled at run time (`tests/cli/token-step.test.ts`):

- a token and Enter: stored, mode 0600 in a 0700 directory, never shown;
- a paste of three `NAME=value` lines: nothing stored, exit 1, nothing shown, and the outer shell received none of them;
- a token with a second Enter: stored;
- an existing 0644 file: rewritten in place, 0600;
- a directory that cannot be made: nothing stored, the outer shell received nothing;
- Ctrl-C at the prompt: nothing stored, echo back on;
- the outer shell `dash`: the same first two results;
- the leak check's value prompt refuses a pasted block (F-9.2-2);
- the control: the old three-block form, with a failing middle block, sends the paste to the outer shell.

Before the change, 7 failed and the control passed. After it, 11 of 11 passed.

## The drill's time (D-77, `redrill.json`)

|                            | Run 6.8 (drill host, `host-v0.6.1`) | Run 10.6 (staging onto itself, `host-v0.9.2`) |
| -------------------------- | ----------------------------------- | --------------------------------------------- |
| Environments reconciled    | 84, about 19 s each                 | 163, about 16 s each (2,672 s)                |
| Steps 1–7                  | —                                   | 184 s                                         |
| From step 4 to the opening | 42 min of work                      | **75.6 min** (RR-2: 120; 44 min left)         |
| Report                     | —                                   | 20 of 20 checks ok                            |

At this rate about 330 active environments fill the window (`known-limits.md`).

**What went differently.**

- **The first restore run stopped before anything was restored.** A reinstalled server's `host.env` lacks the four OpenBao and KMS settings, and `compose pull` needs `MYKEY_BASE_URL` before the first `up`. Both are now in `restore.md`'s "Before".
- **The pair restored was not P.** `quiesce` stops the executors, not the timers, so the "lost" staging made its 03:00 pair, and `--newest` took it. The drill now stops the backup timer.
- **One report check came back `unknown` once.** It passed ten minutes later.

## The credential drill's reaction times (D-78)

- **The order, hold 0 s:** the request record came 114 ms before the 201, and the freeze 1.2 ms after the match.
- **The drill:** attempt 1 was caught, reaction 0.98 ms.
  - `503 outcome_unknown`, the credential `needs_review`, the next issuance refused with 409;
  - `operations_unresolved` after 21 s;
  - quiesce, reconcile (1 issuance settled), resume;
  - cleared 4 minutes 59 seconds after the send.

## The agent proof and its limits (D-79, `agent-guide.md`)

One Claude Code agent (`claude-opus-5-5`) connected a staging fixture from `llms.txt` alone. It handed the four human steps over by their ids, and the sweep found no needle on any surface: 61 files, 14,409 process-argument samples, every control found.

- **Run 1 failed:** the agent took names with `cut -d= -f1 .env` and finished without `remove-dotenv`. The guide was fixed once and run 2 passed, with the harness unchanged.
- **Scenario 2 was declined** by the model's safeguards: not exercised.
- **What it does not prove:** another agent or model; an agent that does not keep the rule (the token file is readable by the agent's user); a real project. The agent read `.env` before the guide; a line in the real project's agent file pointing to `llms.txt` first would prevent that (the owner's choice).

## Defects found and fixed this session

- **The field day never wrote a record** (Run 10.5, both hosts). `set -f` broke `chmod "$work"/*`, so no record exists for 22 Nov, the first day of real use. It is fixed in `field-day.sh`, kept by `noglob.test.ts`, and pushed to both hosts (production on the owner's yes).
- **A clean server's provisioner got no organization id from the restore** (Run 10.6). Every job and the sweep were deferred as `incarnation`, and new environments stayed `pending`. `scripts/host-restore.ts` is fixed, with a unit test that failed first; staging was repaired by hand. A second real restore has not run with the fix, and no report check looks at the provisioner (D-77).
- **The agent guide** (Run 10.4 C): never take names from a values file; the work ends with `remove-dotenv`.
- **Stale staging tests:** `backup` and `unseal` named the previous seal certificates (now one constant pair), and `workspace` assumed a new project shows on Home (Home lists 100 projects by id; staging has 157).

## Deviations and valves

- **Valve 3, partly:** macOS ran the step, but under bash 5, not 3.2.
- **No other valve was taken.** The pass on the restored host ran all nine files.
- **Rulings that changed the plan's path**, each in its run note:
  - the tunnel restart came before `apply` and `confirm`;
  - the pair signing key `k1` came back from custody instead of a new key id, because a pair names no key id (D-77);
  - C2 was marked done by hand after its restore had run, because a rerun is refused on a database with organizations;
  - staging's 16 Session 2 spike organizations were retired on the owner's answer (`failed`, their 28 environments `archived`).
- **Permission refusals:** production's first `--stay-closed` and the spike-organization change were refused by Claude Code's permission check, then done on the owner's word.
- **The VPN dropped twice during the staging pass;** the files were rerun.

## The review

The freeze's fresh-context review (Run 10.5 A, `review.md`) found no Critical, one High and four Mediums, all dealt with in `run-10.5.md`. The code changed after the freeze had a review of its own (Run 10.7, appended to `review.md`). It found no Critical. The High and both Mediums were fixed in one pass:

- the workspace test now pages the project list and asserts Home both ways (three staging runs);
- the re-drill records the restored pair from the restore's output;
- the unseal test records which branch ran.

**Deferred minors** (six Lows, in `review.md`):

- `noglob.test.ts` misses some glob shapes and `set -o noglob`;
- B4 does not check that P is still the newest pair;
- an abandoned `lost` phase leaves the backup timer stopped;
- two literals in the re-drill duplicate their sources;
- only C2 guards its predecessor;
- `host-restore.test.ts` does not pin owner and redaction, and `backup.staging`'s `false` leg passes on any okms failure.

## Open issues

- **F-9.2-3:** the connect panel's default `APP_DIR` and `APP_START` (not this session's).
- **The agent experiment's adversarial rows** (Session 9) and this session's scenario 2: declined by the model's safeguards, not exercised.
- **The restore's provisioner fix** is proven by a unit test only. A report check for the provisioner is a candidate for a later session.
- **NOT PROVEN, five ids:** AC-1.25, AC-1.26, AC-1.36, AC-1.52, AC-1.55, as in Session 9.
- **The owner's open answers:** question 3 (no token-store command in the CLI, ruled P-171) and question 6 (which coding agent the real project will use).
- **The owner's console step:** delete `staging-seal-2`, and `drill-seal-1` if it is listed.

## What the next session must know

- **Stage 1 stays open.** One D-74 item is left, and it is the owner's: a real application on consumer-1. Gate F is decided again at W-2, 20 Dec 2026.
- **Both hosts serve `host-v0.9.2`.** Staging runs on its reinstalled server with a new host key, a new WireGuard key and `staging-seal-3`. Its earlier staging results (before 24 Nov) are of the old server.
- **A restore onto a host's own server** needs `restore.md`'s whole "Before" and its new "After" part: the signing key back from custody, `backup-init`, the R2 tokens, `timers`, the first pair by hand.
- **Dates:**
  - `kms-cert-expiry` from 12 Dec (its `expiry` instance was put back);
  - production's `prod-seal-1` ends 21 Dec;
  - `staging-seal-3` ends 24 Dec;
  - `.trivyignore.images` 14 Dec;
  - `pair-30-day` from 17 Dec;
  - consumer-1's token by about 22 Dec;
  - W-2 20 Dec, W-1 23 to 26 Dec.
