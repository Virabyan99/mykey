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

## Open issues

- Task C's run and its result (Run 10.5 Task C Step 4).
