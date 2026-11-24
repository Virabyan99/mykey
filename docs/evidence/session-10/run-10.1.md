# Run 10.1 — The token step and the names-only command

**Date:** 23 Nov 2026. **Branch:** `session-10`. **Real time:** about 1 h 45 min (box 2.5 h). D-76.

## What was done

- **Task A.** `tests/cli/token-step.test.ts` drives the step in an interactive shell in a pseudo-terminal (`tests/cli/pty.ts`, moved out of `run.test.ts`). Against the old block 7 cases failed and the control passed; with the new one-line command in `consumer-local.md` §8, 8 of 8 passed.
- **Task B.** One source for the step: both consumer runbooks (setup and rotation) and `machine-credentials.md` "Store a token" hold the same bytes; the panel shows it as one block; `quietly()` and the `stty` texts are gone from the panel, its copy and the help article; `start-here.md` follows. The names-only command is the `awk` form (F-10.0-1). `known-limits.md`: the three-block line left (the behaviour changed), three lines came in.
- **Task D (F-9.2-2).** The leak check refuses a pasted block or a `NAME=value` line at its value prompt, and swallows what follows it.

## Commits

`778a317` (Task A), `2424666` (Task B), and this note's commit (Task D, D-76).

## Commands and results

| Command                                                                  | Result                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `pnpm run test:cli tests/cli/token-step.test.ts` (old block)             | 7 failed, control passed                                            |
| the same, new block                                                      | 8/8; with Task B's names-only cases 10/10; with Task D's case 11/11 |
| `pnpm exec vitest run --project unit tests/unit/runbooks tests/unit/web` | before the change 8 failed; after 210/210                           |
| `pnpm run test:browser tests/browser/navigation.test.ts`                 | 18/18                                                               |
| `pnpm run test:cli` (the whole project)                                  | 67/67 (before Task D)                                               |
| `pnpm run check`                                                         | green                                                               |

## Deviations and decisions

- The step is the plan's candidate unchanged. One test-helper fix: the answer of `echo "[$A]…"` was first matched on the echo of the typed line.
- `tests/unit/registry/registry.test.ts` timed out once (5 s) under the full unit run; alone it passes 14/14, with and without this run's changes.
- The leak check refuses `NAME=value` lines by shape (a name, then `=`), not every line with `=`: a real value may hold `=` (base64).
- Not yet proven: the step on macOS's bash 3.2 (`cli-matrix`, Run 10.5), and the rehearsal of both runbooks with the new block (`test:consumers`, Run 10.5).

## Open issues

- F-9.2-3 (the panel's default `APP_DIR` and `APP_START`) is not in this session.
