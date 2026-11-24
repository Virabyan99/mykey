# Run 10.4 — Documentation for AI agents

**Date:** 23 Nov 2026. **Branch:** `session-10`. **Real time (Tasks A, B and C's harness):** about 1 h 45 min (box 2.5 h for A and B). D-79 is written with Task C's result.

## What was done

- **Task A.** `llms.txt` at the root (an H1, a quoted summary, the rule before any link, one guide under "Guide"; its links resolve against the address the file is read from, so it works at any commit). `docs/agents/connect-an-application.md`: the rule first; who does what and the four hand-overs (`put-secrets`, `store-token`, `remove-dotenv`, `replace-token`) with their exact texts; installing the CLI; finding the names without reading values; local development; Next.js, FastAPI and any process; Docker; names-only checks; the exit codes; rotation, revocation and restores; limits; a "Never" section. `README.md` and `start-here.md` point to `llms.txt`.
- **Task B.** `tests/unit/agents/guide.test.ts` (11 tests) keeps the guide equal to the code: the runbook blocks byte for byte, `parseArgs` on every `secrets` line, the exit-code table against `EXIT`, the limits against `LIMITS`, the CLI version, every `SECRETS_` variable, no command that leads to a value outside "Never", the four hand-over ids, and a lint. `tests/unit/runbooks/links.test.ts` now covers `docs/agents` and `llms.txt`.
- **Task C, the harness** (`tools/agent-guide/`, `tests/staging/agent-guide.staging.test.ts`): written and type-checked; it runs after `host-v0.9.2` is on staging, with the owner's "key ok".

## Commands and results

| Command                                                                                   | Result                                  |
| ----------------------------------------------------------------------------------------- | --------------------------------------- |
| `pnpm exec vitest run --project unit tests/unit/agents tests/unit/runbooks`               | 23/23                                   |
| each guide test against a broken copy (`MYKEY_GUIDE_COPY`, `MYKEY_LLMS_COPY`; 11 mutants) | 11 of 11 caught by their own test       |
| `links.test.ts` with a broken link added to `llms.txt`                                    | failed, naming the link; restored       |
| `pnpm run check`                                                                          | green (`pins: ok` with the agent image) |

## Deviations and decisions

- The tests were written after the guide, as the plan orders, and each was seen to fail once on a broken copy before it counted.
- The guide does not say a token is "not renewable": that was not checked in the code. It says a token lives at most 30 days, as chosen at issue.
- The claims walk (Run 10.5) corrected one recipe line: in Next.js a variable already set wins over `.env`, so the old "or they still win" was wrong; the reason the files must go is a name that is only in the file.
- The agent's image installs `curl`, `git` and `procps` by `apt-get` (test-only; `node:bookworm-slim` has no `curl`).

- **Task C, the proof** (`agent-guide.md`, `agent-guide.json`), after `host-v0.9.2` was on staging, with the owner's "key is ok to use":
  - Run 1 (`e57e5c6`) **failed** on the file sweep (5 needles): the agent reported done without `remove-dotenv`, and took the names with `cut -d= -f1 .env`. Both were read as the guide being unclear (round 1 of 2). The guide was fixed in `6c0c5c1`, with two tests seen failing first.
  - Run 2 (`6c0c5c1`) **passed** every point of the pass rule, every control found: 3,784 s, $3.08.
  - The harness, its prompts and its answers were the same in both runs.

## Commands and results (Task C)

| Command                                                                   | Result                                   |
| ------------------------------------------------------------------------- | ---------------------------------------- |
| `pnpm run test:staging tests/staging/agent-guide.staging.test.ts` (run 1) | 1 failed: `sweep.files.needles` 5        |
| `pnpm exec vitest run --project unit tests/unit/agents`                   | 14/14 (two new tests seen failing first) |
| `pnpm run test:staging tests/staging/agent-guide.staging.test.ts` (run 2) | 1/1 PASS, 3,784 s                        |

## Open issues

- The agent read `.env` before it read the guide. A real project should point its own agent file to `llms.txt` first; that is the owner's choice, in the session report.
- A turn that starts the application lasts the harness's full 30 minutes. That costs time only.
