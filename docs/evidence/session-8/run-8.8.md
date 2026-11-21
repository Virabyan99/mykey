# Run 8.8 — The owner's first run (OWN-6)

_21 Nov 2026. Plan: `docs/plans/session-8-plan.md`, Run 8.8 (P-155)._

## What was done

**Step 1 — Before.** `docs/runbooks/start-here.md` was written in Run 8.8 Step 1 (`66cab15`). At 08:44:42 UTC the agent ran `ops reset-account --email owner@mykey-staging.invalid --kind mfa` and gave the owner only the path of the link's file.

**Step 2 — The hour.** The owner followed `start-here.md` on staging (`host-v0.8.0`, open), with synthetic values only. The agent ran nothing on staging during the hour. The owner's words, step by step, are in `walkthrough.md`.

- **Reached:**
  - the link;
  - password, authenticator and recovery codes;
  - a project, secrets and a machine credential;
  - the CLI `cli-v0.1.2` installed in WSL and the environment delivered to a command, with no `.env`;
  - after revocation, `denied`;
  - Activity showing both the machine's and the person's actions;
  - the known limits.
- **The two questions:**
  - "nothing else needed" (FR-1.97), beyond the three findings below;
  - "text key was fine": no QR code.
- **The owner's verdict on the workspace:** it is hard to navigate and understand on a first visit. The owner asks that the UI and UX be addressed in Session 9. That request goes to Session 9's plan.

**Step 3 — After.**

1. **The findings, and what was done with each.**

   | Finding                                                                                                                        | Kind                     | Done                                                                                                                                                                                                                      |
   | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Step 1 of `consumer-local.md` needs `gh`; the owner had none, and `start-here.md` did not say so                               | Document (it stopped)    | `consumer-local.md`: the repository is public, `gh` is optional, and a `curl` block downloads the same four files. `start-here.md` says so.                                                                               |
   | The project's id is shown nowhere as text, only as a segment of the address. The wrong segment gave `denied … 404 (not_found)` | Document; page behaviour | `consumer-local.md` step 5 and `start-here.md` say it is the segment after `/p/`, name the 404, and say the environment is its name. Showing the id on the page goes to Session 9's UI and UX work (the owner's request). |
   | `APP_DIR`/`APP_START` are examples, and the runbook said nothing for someone without an application                            | Document                 | Step 5 says to replace every example; step 9 has a command that lists only the names it was given.                                                                                                                        |
   | The token pasted into `cat` stays on the screen, and the owner's paste carried it into the chat                                | Document                 | Step 8 warns, and gives `stty -echo`. The token (staging, synthetic data) was revoked by the owner and replaced.                                                                                                          |
   | `restore.md`'s "Between 7 and 8" is the operator's text; the owner did not understand it                                       | Document                 | `start-here.md` step 6 now says in five plain steps what a restore asks of the owner; `restore.md` points the owner there.                                                                                                |

   The rehearsed blocks of `consumer-local.md` are unchanged; the new blocks are unmarked, so `test:consumers` runs what it ran.

2. **No `host-v0.8.1`.** Nothing needed a change to the build: each stop was overcome by a document, which the owner then used. The page behaviour (the project id) goes to a hardening run, as the plan's Step 3 has it for a text or a behaviour that did not stop the owner.
3. **The test owner re-established.** Written test first:
   - **Red:** `identity.staging.test.ts` failed 4 of 15 (`sign-in answered 401`) while the account held the owner's own password and authenticator.
   - `reestablishStagingOwner` (`tests/harness/staging-owner.ts`) is an `mfa` reset completed as the reset page completes it. `reset/complete` sets a new password and answers `next: "enroll"`. The new authenticator is enrolled **on the session that answer hands back**: a password sign-in is refused until then. The activation ends every session (P-51), and a fresh sign-in proves the new password and seed. Password, seed and recovery codes are in workstation custody only.
   - The first version signed in with the password after the reset and got 401. That spent one reset link, with no other effect; the second version is the one above.
   - **Green:** `identity.staging.test.ts` 15/15, and `api.staging.test.ts` 12/12.
4. **The owner's project archived.**
   - `91d9280a-…` was found among the 98 projects of the staging organization `e2350312-…`; it was `active`.
   - `POST …/projects/91d9280a-…/archive` (`confirmed: true`) answered `200`, operation `succeeded`.
   - The id the owner tried first (`b75ad1e7-…`) is not the organization's, so it was most likely the environment's (after `/e/`). The runbooks name both wrong segments.

## Commits

- docs and harness: the owner's first run; the runbooks corrected; the staging owner re-established.

## Commands and results

- `pnpm run test:staging tests/staging/identity.staging.test.ts`: red 4/15 failed, then 15/15.
- `pnpm run test:staging tests/staging/api.staging.test.ts`: 12/12. It rewrote `docs/evidence/session-3/canary-sweep.txt`, which was restored.
- `pnpm run check`: green.

## Deviations and decisions

- **The project id stays a document fix in Session 8.** The plan sends a page behaviour that did not stop the owner to a hardening run. The owner reached the step with the corrected text and asks for the UI and UX in Session 9. A `host-v0.8.1` now would repeat the candidate's proofs for a change the owner wants rethought anyway.
- **The token in the chat.** It belonged to a staging credential over synthetic values, and it was revoked within minutes. No other value was shown, and `walkthrough.md` does not hold it.

## Open issues

- Session 9: the owner's request for the workspace's UI and UX, with the visible project id among its first items.
