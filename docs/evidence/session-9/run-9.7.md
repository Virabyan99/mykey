# Run 9.7 — The restore fixes (Task A) and the drill (Task B)

**Date:** 22 Nov 2026 (Task A). **Branch:** `session-9`. **Decisions:** D-69 (restore code may change after Gate R), D-73 (begins here). **Findings:** Session 8's review 4: R4-2, R4-3, R4-4, R4-7 and R4-10 (`docs/evidence/session-8/review-4-backup.md`).

Task B (the restore drill, after the freeze) completes this note.

## What was done (Task A)

- **R4-3 (a rerun after the OpenBao step):**
  - Step 4 now offers the target's OpenBao every root token that may open it, and sends the snapshot with the first one accepted (`acceptedRootToken`). The order: the restore's own kept token, the dated init answers newest first, the custody copy, the pair's token.
  - A new state step, `snapshot`, records that the target's own token is gone.
  - The minted token is kept (`keepRootToken`, `restore-root-token`) before `openbao` is recorded.
  - The local target now keeps one scratch OpenBao per target, as a host does. Until now it made a new one for every run, so the old test passed for a reason the host does not share.
- **R4-10 (a host onto its own reinstalled server):** `bao-init` keeps a custody copy that holds another answer (the lost host's) and writes the new server's answer beside it, as `openbao-init.<UTC stamp>.json`. It refuses only a dated path that already holds another answer.
- **R4-2 (no root token after a restore):**
  - `restore-verify --open` first makes the restored OpenBao's next root token. It uses generate-root with the **source's** recovery key, through the authenticated `sys/generate-root-token` and the restore's own token, over SSH with curl. OpenBao 2.7 answers the unauthenticated `sys/generate-root` with 405.
  - It then rewrites the target's custody copy as the source's answer with that token, and keeps the copy it replaces, dated. Only then does it open the gate.
- **R4-4 (a finished state file left behind):** `--open` marks the state line `opened` before it revokes its token and removes the files. Step 1 refuses a line marked `opened`, with its path named, and always refuses a serving host (gate open). Data is refused unless the line names the same pair at a step before the opening (`startRefusal`).
- **R4-7 (a deploy opening a restored host):** fixing R4-2 alone would make it live. A deploy's `gate_open` now refuses while `/var/lib/mykey/restore-state.json` exists (`deployRestoreRefusal`).
- **R4-13 and R4-14** are not closed by this change; their `known-limits.md` lines stay.
- **Documents:**
  - `restore.md`: bao-init on the same name, step 4, "When it stops", `--open`.
  - `custody-map.md`: the dated answers, and the copy after a restore.
  - `known-limits.md`: the five lines of what is fixed are gone. A new line says a rerun has two hours after step 5.
- **Where the code ships:** `apps/ops` has its own image (`apps/ops/Dockerfile`), not the API's.

## Commands and results

| Command                                                                                               | Result                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest --project unit tests/unit/hosts/restore-custody.test.ts tests/unit/ops/restore-start.test.ts` | RED 8/8 (the functions did not exist); GREEN 8/8                                                                                                                                                                                       |
| `vitest --project unit tests/unit/hosts tests/unit/ops`                                               | GREEN 277/277                                                                                                                                                                                                                          |
| `vitest --project integration tests/fault/restore/interrupted.test.ts`                                | First 3/5: the target was read before its OpenBao existed; the new test began on the earlier test's database. Then 4/5: generate-root answered 405 (unauthenticated, disabled in OpenBao 2.7), then its answer under `data`. GREEN 5/5 |
| `vitest --project integration --maxWorkers=2 tests/integration/restore` (the same local target)       | GREEN 32/32 in 5 files                                                                                                                                                                                                                 |

## What the fault test now proves

- **The stops:** a restore stopped after each of its six steps is run again from step 1 and completes. Every rerun meets the OpenBao the earlier run left.
- **A stop after the snapshot:** the target's own token answers 403, and nothing is kept yet.
- **A stop after step 5:** the pair's token answers 403, and the kept token 200. The rerun completes and keeps its own new token.
- **The next root token:** made with the source's recovery key, it answers 200. The target's own recovery key does not complete the attempt.
- **The custody copy:** written with the new token, it is what `ops` and a deploy read. The restore's own token, revoked, answers 403.

## Deviations and decisions

The rulings are in the run's ledger and are carried into the session report.

- generate-root runs from `scripts/` (SSH and curl), not as a method of `packages/openbao`: D-69 does not list `packages/`.
- The fault proof could not be watched red against the old code, because the interface and the harness changed together. The unit tests were watched red, and the fault test's 403 controls show the rerun succeeds only through the kept token.
