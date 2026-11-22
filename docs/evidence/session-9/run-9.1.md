# Run 9.1 — Production opened

**Date:** 22 Nov 2026. **Branch:** `session-9`. **Release:** `host-v0.9.1` (`b19ca6671e14`) with `cli-v0.1.2`. **Owner:** present for the whole run.

Production's organization, user and project ids, the owner's address and every name the owner entered stay out of this note (Gate R: real data never reaches Git).

## What was done

1. **Production updated, still closed.**
   - Before the run, with the owner's yes: `prod push`, `prod timers` (eight timers, `mykey-field-day` among them) and `prod deploy --release …/host-v0.9.1 --stay-closed`.
   - Migrations, start and the store checks passed. `prod status`: every check `ok`, the gate `closed`.
2. **The owner's account.** The owner ran `ops bootstrap-owner` in their own Git Bash, with a password file they made and shredded afterwards. The answer was `created user … organization …`.
   - **First attempt:** `node` in Git Bash's mintty runs through `winpty`, which refuses a redirected stdin ("stdin is not a tty"). Nothing was created.
   - **Second attempt:** `node.exe` instead of `node`.
3. **Enrolment** through `tunnel verify --browser` (new in this session, below): the owner signed in, enrolled their own authenticator and saved the ten recovery codes.
4. **The organization:** `ops provision-organization` answered `active`, and `ops verify-organization` answered `equal`.
5. **The owner's journey**, in the same window:
   - sign-in with the password and a code;
   - no secret to reveal;
   - creating a project answered "The service is not open";
   - sign-out.
     The owner said "journey done".
6. **The opening:** `prod deploy --release …/host-v0.9.1 --owner-confirmed`. The journey was recorded as owner confirmed, the report was written, and the gate went `open` at **epoch 7**, release build `b19ca6671e14`.
7. **The probe:** `inService: true` in `workers/probe/wrangler.jsonc`, then `probe.ts deploy`. `probe.ts state prod` shows nothing open, and `GET /health` answers 200. `prod status` after the opening: every check `ok`.

## Findings

- **F-9.1-1, the journey cannot be done on `https://127.0.0.1:<port>`.** It showed on staging the same morning:
  - Chrome warns about the listener's own CA and may offer no way past;
  - once past, sign-in is refused as `origin_rejected`, because the API takes changes only from `MYKEY_BASE_URL`'s origin.
  - **Fix:** `host.ts <host> tunnel verify --browser` opens Chrome with a temporary profile of its own. The window maps the host's own name on 443 to the tunnel and trusts only the listener's key, read through the tunnel (`tests/unit/hosts/verify-browser.test.ts`). `production.md` and `restore.md` use it. Production's opening went through it with no warning and no refusal.
- **F-9.1-2, `node` in Git Bash.** A command that feeds a file on stdin must call `node.exe`. This is to be added to `production.md`'s step 1.
- **The owner's first visit:** at this point nothing like the task test's failures. The owner created the first project and environment without a question (`task-test.md`, "Production, first visit").

## Commands and results

| Command                                                                          | Result                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------- |
| `host.ts prod push`, `prod timers`                                               | pushed and read back; eight timers enabled     |
| `host.ts prod deploy --release …/host-v0.9.1 --stay-closed`                      | exit 0; gate closed (verifying)                |
| `host.ts prod ops bootstrap-owner` (owner's terminal, `node.exe`)                | `created user … organization …`                |
| `host.ts prod tunnel verify --browser`                                           | the window opened at production's own name     |
| `host.ts prod ops provision-organization`, `verify-organization`                 | `active`; `equal`                              |
| `host.ts prod deploy --release …/host-v0.9.1 --owner-confirmed`                  | exit 0; gate open, epoch 7                     |
| `probe.ts deploy` (prod `inService: true`); `probe.ts state prod`; `prod status` | deployed; nothing open; every check `ok`       |
| `vitest --project unit tests/unit/probe`                                         | 85/85 (the config test now expects in service) |
