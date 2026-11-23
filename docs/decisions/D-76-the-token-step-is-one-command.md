# D-76 — The token step is one command that reads first

**Date:** 2026-11-23

**Status:** DECIDED (P-171, P-172, P-173; Run 10.1). Evidence: `tests/cli/token-step.test.ts`, `tests/unit/runbooks/token-step.test.ts`, `tests/unit/web/connect-commands.test.ts`, `docs/evidence/session-10/run-10.1.md`.

## Context

The connect panel's token step was three blocks: `stty -echo`, a store block, `stty echo` (review RR-5's fix). On both first uses (Runs 8.8 and 9.2) a token reached the shell, the screen and a chat. In Run 9.2 the store block failed with echo off, and the owner pasted the token into the shell (F-9.2-1). The form in `known-limits.md` read silently but used `read -s -p`, which fails in zsh and `dash` before it reads.

## Decision

1. **The step is one command line, run by `bash`,** in `consumer-local.md` §8. It has six properties, each proven in a pseudo-terminal:
   - one line, nothing before or after it;
   - it reads first, silently, after printing `Paste the token, then press Enter: `; nothing that can fail comes before the read;
   - one token and nothing else: a paste of several lines is swallowed (lines that follow within a second) and refused, and an empty line after the token is ignored;
   - only the CLI's own token characters (`apps/cli/src/token.ts`) are stored;
   - the file is rewritten in place (same inode, for a mounted container), mode 0600, in a directory of mode 0700;
   - one line of outcome: `Token stored.`, or `Nothing was stored: …` with exit 1.
2. **One source (P-172).** Every place that shows or writes the step holds the same bytes: both consumer runbooks (setup and rotation), `machine-credentials.md` "Store a token", and the panel, which reads the runbooks. `tests/unit/runbooks/token-step.test.ts` refuses `stty`, "Ctrl-D" and a `cat` into the token file anywhere a reader is shown the step.
3. **The CLI gains no command for storing a token, and there is no `cli-v0.1.3`.** Weighed:
   - _for_ a command: a short name, raw terminal mode in the program, covered by the release's sums, independent of the shell;
   - _against_ it: the CLI is not where a deployment stores the token (it is inside the image on a Docker host), so a second form would remain; the defect was the step's shape, not a missing program; a new token path in the signed CLI is product code after Gate R (D-68, D-69), with its own review, release, `cli-matrix` run, runbook and fixture changes and a reinstall on consumer-1.

   The cost of the ruling: the step needs `bash` (a known limit), and the line is long; the panel copies it with one button. It is revisited at the next CLI release made for another reason.

4. **The names-only command asks `awk` for the names (P-173, F-10.0-1).** `env | cut -d= -f1` printed the later lines of a value with several lines.
5. **The leak check's value prompt** refuses a pasted block and a `NAME=value` line, and swallows what follows (F-9.2-2).

## Consequences

- The panel changes with `host-v0.9.2`, which goes to production by `production.md` §4.
- `known-limits.md`: the three-block line leaves; three lines come in (`bash` and a paste before the prompt; the one-second wait; the names-only command before `host-v0.9.2`).
- A paste whose lines arrive more than a second apart is not swallowed.
