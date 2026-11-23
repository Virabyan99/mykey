# Run 10.2 — What the drill needs before it starts

**Date:** 23 Nov 2026. **Branch:** `session-10`. **Real time:** about 1 h 15 min (box 2 h). D-73, D-77.

## What was done

- **Task A — generate-root's host path.** `hostSysCall` (`scripts/host.ts`) is exported with its exec injected. `tests/unit/hosts/host-sys-call.test.ts` proves the token and the body travel on stdin only, the header file is removed whatever curl answers, and the status is the answer's last line. `tests/staging/host-sys-call.staging.test.ts` ran it on today's staging, before any reinstall: a root token was made with staging's recovery key through the host path, its lookup held the root policy, it was revoked by its accessor at once, and OpenBao refused it afterwards.
- **Task B — the drill's tools.**
  - `node scripts/probe.ts secrets --host <staging|prod>` installs one host's **existing** heartbeat token and units: no new token, no Worker secret, no other host (`tests/unit/probe/heartbeat.test.ts`). `restore.md` and `probe.md` name it.
  - `tests/harness/drill.ts`: `drillTarget()` (staging itself with `MYKEY_DRILL_TARGET=staging`), a state file of its own for the re-drill, and `restoreClock()`, the minutes left of the restore's 120 (`tests/unit/hosts/drill-clock.test.ts`).
  - `tests/staging/redrill.staging.test.ts`: Run 6.8's drill re-aimed at staging itself, in three phases (`MYKEY_REDRILL_PHASE=before|lost|restore`). It runs in Run 10.6.

## Commits

`a77d59c` (Task A), and this note's commit (Task B, with the lint fix of Task A's unit test).

## Commands and results

| Command                                                                                     | Result                                                                  |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm exec vitest run --project unit tests/unit/hosts/host-sys-call.test.ts`                | before the export 5 failed (`hostSysCall is not a function`); after 5/5 |
| `pnpm run test:staging tests/staging/host-sys-call.staging.test.ts`                         | 2/2; the log holds no token shape                                       |
| `pnpm exec vitest run --project unit tests/unit/probe/heartbeat.test.ts`                    | before 2 failed; after 2/2                                              |
| `pnpm exec vitest run --project unit tests/unit/hosts/drill-clock.test.ts`                  | before 2 failed; after 2/2                                              |
| `pnpm exec vitest run --project unit tests/unit/probe tests/unit/hosts tests/unit/runbooks` | 352/352                                                                 |
| `pnpm run check`                                                                            | green (the re-drill file type-checks; it is not run here)               |

## Deviations and decisions

- **"No attempt is left open"** is checked by a cancel that answers 2xx: the host path sends POST and DELETE only, so the plan's `GET …/attempt` is not used.
- **The changes after P** are a token revoked, the admin removed, a secret created and a token issued. The plan's "one secret changed" is not used: a revoked token and a removed member are the changes a restore must undo, and Run 6.8 used them.
- **The clock starts** when the restore command starts. Step 4 comes inside that command, so the clock reads a few minutes short of the truth, on the safe side.
- **The key rings:** `host.ts keys init` creates only the files missing on the workstation and installs what is there, so the reinstalled server gets staging's own key rings back.
- **Task A's first commit** went in before `check` finished, with one lint error in its unit test. It was fixed in this note's commit, before any push.

## Open issues

- The re-drill file's restore half has not run yet: its host commands (`push`, the `env` settings of a fresh `host.env`, the order of `acme`) are checked against the host in Run 10.6, and the note of that run says what changed.
