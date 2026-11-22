# Run 9.8 — The gate review of the exit dossier, saved as it came

**Reviewer:** one fresh-context agent (Opus), read-only, with one question: "is any statement in the dossier stronger than its evidence?" It reviewed `exit-dossier.md` at `65fc1dc`. **Disposition** is at the end. Every finding was applied to the dossier, the manifest's restore lines, `agent-experiment.md`, `baseline.md` and `report.md`.

---

## 1. Findings

**F1 (High). Gate F's first condition is not met, and the dossier does not say so.**

- Dossier, line 3: "Release serving real data". Line 11: "consumer-1 reads the complete set through the CLI".
- Doc 10 §2 (line 72) says Gate F needs "a real non-critical app runs on MyKey".
- What the evidence shows:
  - run-9.2.md:15: "The folder the owner named holds no application yet, so consumer-1 runs a names-only start." The only start was `sh -c '… env | cut -d= -f1'`.
  - run-9.2.md:9: "Those seen in the owner's terminal were test values." Nothing establishes that production holds real values.
  - Every "real-use day" (D-72 "use" = a successful machine read) is a names-only read.
- Correction: in §1 and §7, say plainly that there is no application yet and that it is not established whether the values are real. State that Gate F's "real app runs" condition is open until one runs.

**F2 (High). The manifest the dossier cites as "144 PASS" holds false "unchanged" text for restore ids.**

- Dossier, line 7: "The release manifest … gives **144 PASS**".
- session-9/manifest.md:153, 154 and 192 (AC-1.43, AC-1.44, PO-22) are byte-identical to Session 8's lines. They say "Since then: packages/backup/src/restore.ts and scripts/host-restore.ts unchanged".
- `git diff --stat 9af7051..b19ca66` shows changes to:
  - scripts/host-restore.ts (40 lines);
  - apps/ops/src/commands/restore.ts (112 lines);
  - restore-verify.ts;
  - host-custody.ts (+224);
  - the restore part of host.ts.
- These three PASS ids rest only on Run 6.8's drill of host-v0.6.1 code, which has since changed.
- There is a related gap. `hostSysCall` (scripts/host.ts:2783), the host path of R4-2's generate-root, has no test anywhere. review-release.md:221 flags this, and `grep` finds no test. So that part of R4-2 is not even "proven locally".
- Correction: fix the three manifest lines, or mark those ids earlier with the restore change named. In §1 and §4, say that the restore PASS ids rest on a drill of pre-fix code, and that the host-side generate-root path is untested.

**F3 (Medium). "Fixed" for RR-3 and RR-5.**

- Dossier, line 66: "RR-1 (High) and RR-3, RR-5, RR-9 fixed".
- review-release.md:287 calls RR-3 "**Partly fixed**" (the check is still at gate_open and still keys on the state file).
- RR-5's "fix" (review-release.md:289: "three blocks run one at a time") is the exact step that failed in real use (F-9.2-1, run-9.2.md:29).
- Correction: "RR-1 and RR-9 fixed; RR-3 partly; RR-5's fix failed on first real use (F-9.2-1)". Add RR-3's remainder to §5.

**F4 (Medium). The baseline is not like-for-like (§2, line 19; H-05, line 49).**

- Dossier: "On disk, MyKey left no value where the leak check looks. The baseline left the value in 3 files and a root token in a fourth."
- What the evidence shows:
  - baseline.md:45 counts "the terminal's output" as one of the 3 "files". On MyKey's side, the F-9.2-1 token and the F-9.2-2 test values reached exactly that surface, the terminal (and the conversation), and are not counted.
  - The baseline's counts come from a script that is not in Git (baseline.md:10), so they cannot be checked. A non-interactive script normally writes no .bash_history.
  - MyKey's needles were 2 tokens plus "four lines the owner pasted" (run-9.2.md:21). Per F-9.2-2 these were lines of a dotenv block, probably `NAME=value` lines of test values, not bare values.
  - The exposed F-9.2-1 token was not shown to have been a needle.
  - The baseline did no "replace its access once": the commands at baseline.md:33-40 have no rotation or revoke. Doc 10 Run 9.5 asks for one.
- Correction: count the same surfaces on both sides. Say the needles were four pasted lines (test values) and two later tokens. Say the baseline did no rotation.

**F5 (Medium). The before/after task comparison (line 12, and task-test.md:5).**

- Dossier: "On the old page, task 1 failed and task 6 needed the agent (`session-8/walkthrough.md`)."
- The walkthrough was not the seven-task test:
  - its step 6 is reading restore.md "Between 7 and 8" (walkthrough.md:19), not "what to do after losing the phone";
  - "task 1" maps only to finding (b).
- The owner had also just spent 10+ minutes on host-v0.9.0 before the test (task-test.md:30), so some learning carried over.
- Correction: "The old page was not given these seven tasks. Its walkthrough found the project id missing (≈ task 1) and needed the agent for restore.md." Note the earlier v0.9.0 exposure.

**F6 (Medium). H-02 (line 46): "The owner enrolled, reset and signed in on both hosts without help."**

- On production there was no reset (run-9.1.md:12-15).
- The journey needed the agent twice:
  - F-9.1-1, where a new tool, `tunnel verify --browser`, was written;
  - F-9.1-2, where `node.exe` was needed.
- Correction: "on staging after a reset; on production after bootstrap, with two agent fixes (F-9.1-1, F-9.1-2)."

**F7 (Medium). H-07 (line 51) and the agent counts.**

- The dossier says:
  - "The runner's boundary held. 0 needles on 6 surfaces." / "The runner pattern stands.";
  - §2: "Three of the six adversarial rows"; §12: "half its adversarial rows".
- What the evidence shows:
  - By the plan's own rule the experiment did not pass (agent-experiment.md:76).
  - Of the six scenarios run, five are adversarial (1 is the happy path, scenarios.json). The agent exercised 2 of those 5 (4 and 9). Against the plan's adversarial rows 2–10, the agent exercised 2 of 9; revocation and outage were never run by an agent (Doc 03 H-07 asks for "denial/revocation").
  - `docker diff` was never searched for needles. The harness only counts lines (agent-experiment.staging.test.ts:392-394), yet agent-experiment.md:60 says "none holding a needle". That leaves 5 searched surfaces, not 6.
  - run-9.4-experiment.json records `"requests": 1` for scenario 4 (3 tool calls in all, not "four requests"). It also records `"matched": true` for the unexercised scenarios 2 and 3.
  - agent-experiment.md:56 calls the runner-log control "a canary-shaped secret name". The code uses the correlation ids.
- Correction: "not a pass by the plan's rule; 0 needles on 5 searched surfaces; 3 of 5 adversarial scenarios not exercised (2 of 9 plan rows by an agent)". Fix the JSON's matched flags and the docker diff line. Drop or qualify "the runner pattern stands", which is not one of Doc 03's listed consequences.

**F8 (Medium). "No incident on production since its opening" (line 72).**

- F-9.2-1 is a production machine token exposed to a third party (the conversation).
- It is also a repeat: walkthrough.md:15(a) records the same token-in-chat on the owner's first use in Session 8.
- The status and probe evidence is from the opening (run-9.1.md:24), not from the time of writing.
- Correction: "No outage or alert; one credential exposure (F-9.2-1, the second first-use token leak after Run 8.8)."

**F9 (Medium). The calendar's first row (line 126).**

- Dossier: "from 12 Dec 2026, 09:57 | Staging's KMS certificates expire … replace".
- 09:57 is the start of the `kms-cert-expiry` checkpoint, which proves that an _expired_ certificate fails (kms-and-unseal.md:74).
- The runbook says "Replace it at least a week before" (kms-and-unseal.md:48), and the alert opens 2 Dec.
- Correction: split it into "replace by 5 Dec (alert from 2 Dec)" and "checkpoint from 12 Dec 09:57".

**F10 (Medium). Real-use days and time figures.**

- Dossier, line 3 "Real-use days so far: 1" and §12 "Real use is one day old".
  - The clock started at 14:27:41 UTC. The dossier was committed at 19:33 +0400 (15:33 UTC), so real use had lasted about 1 hour.
  - D-05 asks for the actual number.
  - "3 reads on day 1" is the count at the time of the note.
- Dossier §9 / H-08: "about 10 hours of agent time and about 2.5 hours of the owner's (the run notes)".
  - No run note records either figure.
  - report.md's table sums to more than 10 h and gives the owner's sitting as about 1.5 h.
- Correction: "day 1 under way (about 1 hour of use at writing)". Give the times' source, or mark them as estimates.

**F11 (Low).**

- Line 8, "marked `earlier` with that release on their line": AC-1.43, AC-1.44, PO-22 and R2-L1 name no release.
- Line 13, "The release review … fixed it before the release": the review covered the v0.9.0 candidate. The RR-1 fix (a323998) and v0.9.1's delta (b19ca66, with new page text) had no fresh review. The claims walk is of 6233002 (claims.md:3), not of v0.9.1.
- Line 36, "before production's first restore": restore.md "Before" adds "unless the restore is an emergency".
- Line 67-71, the harness defects: a fourth is missing. deploy.staging left staging on host-v0.6.0 (report.md "Deviations"; fixed by the diff to deploy.staging.test.ts).
- Line 134, "17 Feb 2027": no source in the repository (Session 2 had 9 Feb 2027).
- Line 3, "Where the agent gives an opinion, it is marked": the §6 "Consequence" column and the §11 judgments are the agent's but are labelled "(Doc 03 §9)" / not marked.
- F-9.2-3 (APP_DIR/APP_START) is missing from §8.
- The owner's "focused pass" choice is recorded only in a commit message and report.md, with no decision page.
- run-9.6 said Run 9.8 would apply D-05's `WATCH`. The manifest shows NOT YET DUE instead.

## 2. What the owner should know before signing and the dossier omits

1. **No application runs yet.** Values may be test values (F1). Doc 10 §2's Gate F condition is open.
2. **Gate F's four choices are not mapped.** The dossier recommends "Maintain only" but never maps it to the four verdicts the owner signs (ADVANCE / HARDEN / PIVOT / STOP). Doc 10 Run 9.9 also asks for the plan for running MyKey in the meantime and a named owner for W-1 and W-2. "Operator" is an agent that runs only when the owner starts a session, so every calendar row needs the owner to start one.
3. **The token step is still live and unscheduled.**
   - Production's connect panel still shows the three-block step that leaked.
   - Two of two first uses have now leaked a token to the chat (Run 8.8, Run 9.2).
   - The fix release has no date.
4. **consumer-1's token rotation is not on the calendar.** Tokens last at most 30 days, so it expires by about 22 Dec, around W-2. A missed rotation turns the field days into "blocked". The rotation also meets the panel's step from point 3.
5. **An emergency restore before the re-drill is risky.**
   - It would run code whose host path (`hostSysCall`, generate-root over SSH) has never run on a host or in a test.
   - It has a hard two-hour window from step 4 to `--open` (RR-2, known-limits.md:107). Without that, OpenBao must be initialised anew.
6. **The consumer runbook rehearsal was not rerun.** `test:consumers` ran on host-v0.8.1 only, although consumer-local.md and the panel's blocks changed in Session 9. Most other staging files also kept v0.8.1 results.
7. **W-2 cannot include a restore time.** Doc 10 §11 asks for one, but the re-drill is due after W-2 (31 Dec vs 20 Dec).
8. **Run notes are incomplete.** run-9.0.md Task I and run-9.7.md Task B, both promised ("completes this note"), were never written.

## 3. Verdict

The dossier is mostly candid about its limits. But it presents production as running "real data" in "real use" when no application runs and the values may be test values. It also rests "144 PASS" on manifest lines that call changed restore code "unchanged". Correct F1 and F2, and preferably F3 to F10, before the owner signs Gate F.

---

## Disposition (the agent, after the review)

| Finding             | What was done                                                                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1                  | The dossier's header and §1, §4, §7 and §12 say that no application runs and that the values are not established as real. Gate F's condition is open (`gate-f.md`).                                                                                                                                  |
| F2                  | `proof-map.json`'s three restore entries now name Session 9's restore changes, the local-only proof and the untested `hostSysCall`. The manifest was rebuilt (still 144 / 9 / 7). The dossier's §1 and §4 say so.                                                                                    |
| F3, F5, F6, F8, F10 | Corrected in the dossier as the reviewer worded them.                                                                                                                                                                                                                                                |
| F4                  | `baseline.md` counts the terminal and the conversation on MyKey's side, names the needles, and adds a row saying the baseline did no rotation. Its script is committed (`baseline-openbao.sh`). It runs an interactive shell with `set -o history` and `history -w`, so its history count is real.   |
| F7                  | `agent-experiment.md`: not a pass by the plan's rule; 5 searched surfaces; 3 tool calls and 4 answers; the runner log's control is the correlation ids; `matched` for 2 and 3 is vacuous. The JSON is left as the harness wrote it, and the note explains it.                                        |
| F9                  | The calendar is split by the runbook: replace by 5 Dec, the checkpoint from 12 Dec, and production's seal by 14 Dec.                                                                                                                                                                                 |
| F11                 | All applied, except two. The focused-pass choice gets no separate decision page: it is a ruling in the ledger and a line in D-74's context (`gate-f.md`). D-05's `WATCH` is not applied, because the manifest keeps Gate F ids as NOT YET DUE until Gate F decides. The 17 Feb 2027 row was dropped. |
| Missing 1–7         | In the dossier's §5, §7, §12 and §13, and in `gate-f.md`. The four choices are mapped in `gate-f.md`.                                                                                                                                                                                                |
| Missing 8           | `run-9.0.md` Task I and `run-9.7.md` Task B are completed in this commit (Task B as deferred, by D-73).                                                                                                                                                                                              |
