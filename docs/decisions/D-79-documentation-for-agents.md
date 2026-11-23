# D-79 — Documentation for agents is `llms.txt` and one guide

**Date:** 2026-11-23

**Status:** DECIDED (P-179; Run 10.4). Evidence: `llms.txt`, `docs/agents/connect-an-application.md`, `tests/unit/agents/guide.test.ts`, `docs/evidence/session-10/agent-guide.md`, `agent-guide.json`, `run-10.4.md`.

## Context

The owner will connect real projects with an AI agent at the keyboard. The facts an agent needs were spread over six runbooks written for a human, and an agent that must read six runbooks reads the wrong one. A guide that copies commands by hand drifts from the runbooks and the code.

## Decision

1. **Two files.** `llms.txt` at the repository's root (an H1, a quoted summary, the rule before any link, one link under "Guide"; its links resolve against the address the file is read from, so it works at any commit), and one guide, `docs/agents/connect-an-application.md`.
2. **The guide stands alone and states the rule first:** the agent never reads, prints or copies a value. Four steps belong to the human, each a message with a fixed id: `put-secrets`, `store-token`, `remove-dotenv`, `replace-token`. The work is done only after `remove-dotenv` is answered. Names never come from a file that holds values.
3. **A test keeps it equal to the code** (`tests/unit/agents/guide.test.ts`). The checks: the runbook blocks byte for byte; `parseArgs` on every `secrets` line; the exit codes against `EXIT`; the limits against `LIMITS`; the CLI version; every `SECRETS_` variable; no command leading to a value outside "Never"; the four ids. Each check was seen to catch its own broken copy.
4. **One real agent proved it on staging**, from `llms.txt` alone. The plan allowed two rounds of guide fixes; it took one (`agent-guide.md`).

## Consequences

- A change to a runbook block, the CLI's arguments, its exit codes or the limits fails `check` until the guide follows.
- The proof covers one agent, one model and one fixture. It says nothing about an agent that does not keep the rule, because the token file is readable by the agent's user. Its full list of limits is in `agent-guide.md`.
- The agent read `.env` before it read the guide. A real project should point its own agent file to `llms.txt` first (an owner choice).
- The owner connects a real project only after this session (D-75).
