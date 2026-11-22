# Run 9.2 — The first real consumer

**Date:** 22 Nov 2026. **Branch:** `session-9`. **Consumer:** `consumer-1`, the owner's workstation WSL (Ubuntu), local tab of the connect panel, `cli-v0.1.2`.

No secret name, value, token, project or environment name, id or address of production appears here (Gate R).

## What was done

1. **Secrets.** The owner made a project and an environment on production and entered an application's secret set (about 30 names). The values are the owner's choice. Those seen in the owner's terminal were test values.
2. **First token.** The owner issued a credential and followed the panel's local tab.
   - The CLI checked out and installed (`SHA256SUMS` OK; `secrets 0.1.2`, build `b19ca6671e14` from `/v1/version`).
   - The token step failed. This is **F-9.2-1**, below; the token was revoked.
3. **Second token.** It was stored with one command that reads silently (`IFS= read -rs`), with no `stty`.
   - `secrets-launch.sh -- sh -c '… env | cut -d= -f1'` started and listed every secret name. No value was printed.
   - The folder the owner named holds no application yet, so consumer-1 runs a names-only start.
4. **One rotation and one revocation:**
   - a third token was stored in place, and the start was run again (59 names in the environment);
   - the second credential was revoked;
   - `secrets keys --token-stdin` with the second token gave `denied: the API answered 401`, **exit 77**.
5. **The leak check** (`scripts/consumer-leak-check.sh`, run by the owner on consumer-1).
   - **Needles:** the old and the new token (read from their files, which are excluded from the search) and four lines the owner pasted.
   - **Result:** 0 hits on every surface (shell histories, `/tmp`, `~/.config` without the token file, every process's argv and environment, the journal, `docker inspect` of 1 container), and every written control found. Docker has no control: no container is started.
   - The app's `.env*` was not searched (no `--app-dir`; there is no application).
6. **The real-use clock** (production's audit, counts and the first time only): `machine.resolve success`, 3 reads, the first at **2026-11-22 14:27:41 UTC**. **AC-1.58 stays `OPEN`: started 22 Nov 2026**; it closes at W-2 (D-05).

## Findings

- **F-9.2-1, the panel's three-block token step leaked a token on first real use** (review RR-5's risk, met).
  - **What happened:** `stty -echo` ran, and the middle block (`( umask 077; …; cat > … )`) failed with `syntax error near unexpected token '('`. The owner, typing blind, pasted the token anyway. The shell ran it as a command, so it went into the terminal, the shell's in-memory history and the agent's conversation.
  - **What was done:** the owner turned the echo back on, cleared the history (`history -c`) and revoked that credential before any use. The token never reached a file. The audit shows no read by it.
  - **The fix to carry:** the panel and `consumer-local.md` step 8 use one silent command, `IFS= read -rs`, with no `stty` and no second block. That was the command that worked twice in this run. Until a release carries it, the panel's step is the known risk recorded in `known-limits.md`.
- **F-9.2-2, the leak check's value prompt takes one value per line.** The owner pasted a dotenv block. The lines after the first empty one went to the shell after the script ended: the test values reached the terminal history and the conversation, and the owner cleared the history. The prompt should say "one value, not a file", and could refuse a line that holds `=`.
- **F-9.2-3, `APP_DIR` and `APP_START`** default to `~/my-app` and `npm start`. The first start failed (`cd: … No such file`). That was expected, but the panel could say to change them.

## Commands and results

| Command (consumer-1, run by the owner)                       | Result                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| `sha256sum -c SHA256SUMS`; `install.sh`; `secrets --version` | OK; `secrets 0.1.2`; API build `b19ca6671e14`             |
| `secrets-launch.sh -- sh -c '… env \| cut -d= -f1 …'`        | started; every secret name listed, no value               |
| `secrets keys --token-stdin < old-token`                     | `denied: 401`, exit 77                                    |
| `consumer-leak-check.sh --token-file old-token`              | 0 on every surface; controls found (Docker: none written) |
| production audit, machine actions (count, first time)        | `machine.resolve success 3`, first 14:27:41 UTC           |
