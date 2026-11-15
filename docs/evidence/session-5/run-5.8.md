# Run 5.8 — Consumer setup and fixture apps

**Result: DONE on 15 Nov 2026.** Both runbooks were followed against staging, block by block, from a clean machine: a developer's machine (`consumer-local.md`) and a first deployment (`consumer-deploy.md`), each with the Next.js and the FastAPI fixture. Both fixtures got the complete set, the token was rotated, and after a synthetic restore it was replaced. The token was found in no shell history, no argument list, no image layer, no image history, no `docker inspect`, no file of the working tree and no output the test captured. Every search had a control that found a marker planted the same way.

- **Fixtures** (`tests/fixtures/consumers/`):
  - Each serves `GET /check`, which answers the names and SHA-256 digests of the variables `FIXTURE_NAMES` lists, never a value. Next.js 16.4.6 serves it from a route handler of a production build; FastAPI 0.163.1 serves it under uvicorn 0.54.0.
  - Each Dockerfile installs the CLI offline from `mykey-release/`. That directory holds the release files, the Node archive of the build machine and `secrets-launch.sh`. Each Dockerfile ends in `ENTRYPOINT ["secrets-launch.sh", "--"]`.
  - No build argument and no layer holds a token.
- **`secrets-launch.sh`** reads `SECRETS_TOKEN_FILE` (default `~/.config/mykey/machine-token`). It refuses, with exit 78, a symbolic link, a missing file, a file not owned by the user, or a file with any group or other permission bit. Then it runs `exec secrets run -- "$@"` and prints nothing but its refusals.
- **The rehearsal** (`tests/consumers/runbook.test.ts`, `tests/harness/runbook.ts`, `tests/harness/leak-search.ts`) ran against staging over its public name, with project `507065af-…` (archived afterwards) and ten synthetic secrets.
  - `consumer-local.md`, 11 blocks:
    - The clean machine is a fresh container of the fixture's application image: the pinned Node or Python image with the application only, plus `curl` and a user.
    - All blocks exited 0, and `/check` answered the ten names with the digests of the owner's export.
    - Rotation: with the second token in place the answer was the same, and `secrets keys` with the revoked first token exited 77.
    - After the synthetic restore (every token revoked, a third issued), the replace-and-restart blocks brought the application back.
    - The wrapper refused a group-readable file, a link and a missing file, 78 each, and started nothing.
    - Elapsed time from the first block: 106 s (Next.js) and 154 s (FastAPI).
  - `consumer-deploy.md`, 9 blocks, on the workstation's Linux shell (WSL's Ubuntu) with the workstation's Docker:
    - Each fixture was built from the runbook. It ran with the token file mounted read-only as the file owner's user, answered `/check`, was rotated by rewriting the file and `docker restart`, and refused the old token with 77.
    - `docker inspect` showed only `SECRETS_TOKEN_FILE=/run/secrets/mykey-token`.
- **Tokens:** ten tokens in all, each issued just before it was used. Each reached a block only on stdin.

FR-1.85 SPIKE_PASS — setup and rotation from the runbooks, rehearsed on a clean machine and a Docker host against staging (`tests/consumers/runbook.test.ts`, `docs/evidence/session-5/run-5.8-consumers.json`).
PO-20 SPIKE_PASS — credential setup and replacement for a workstation and a first deployment, both fixtures, staging; the four-platform half of "multi-platform" is PO-8 (Run 5.7, macOS open).
AC-1.42 SPIKE_PASS — the synthetic consumer rehearsal D-03 defines: installation, endpoint check, protected token supply, launch, rotation and the restore replacement, every block of both runbooks run against staging.

## Commands and results

| Command                                                                                                   | Result                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm exec vitest run --project consumers tests/consumers/fixtures.test.ts` (before the fixtures existed) | FAIL: no context to build                                    |
| the same, after                                                                                           | 2 passed                                                     |
| `pnpm exec vitest run --project unit tests/unit/pins` (fixture pins, before and after)                    | RED `fixtureDockerfiles is not a function` → 22 passed       |
| `pnpm run test:consumers` (run 1)                                                                         | 3 passed, 2 failed: the WSL history search (below)           |
| the same (run 2)                                                                                          | 5 passed, 2 failed: `wsl.exe` exited −1 in one block (below) |
| the same (run 3)                                                                                          | **2 files, 7 passed** (695 s)                                |
| `pnpm run check`                                                                                          | exit 0                                                       |

## What the runs found

- **A silent zero:** `grep -f /dev/stdin` cannot reopen WSL's interop pipe (EACCES). The first version of the search reported 0 when grep failed; only the history control (expected 1, found 0) caught it. The search now reads its patterns with `-f -`, and a grep status above 1 fails the search instead of counting. A probe on the WSL host gave 1 for the control and 0 otherwise.
- **A `wsl.exe` failure:** in run 2 the FastAPI deploy rehearsal's block 3 got exit 4294967295 (`wsl.exe` returned −1) after 32 s, with no output. The same block had passed for Next.js minutes earlier. That case alone then passed, and so did the whole project in run 3. The harness does not retry: a block that fails is a failure.

## Rulings

- The harness has a fourth mode, `background`, for a block that starts an application in the foreground of its terminal. It runs detached, and stopping it is SIGINT to the CLI, as Ctrl-C would send. The plan's three modes cannot rehearse "start the application" without leaving a shell blocked.
- Blocks run as one terminal session: each runs in `sh -e`, and what it exported and the directory it ended in carry over to the next block (a session file in the target's HOME). That is how a user runs them, one after another in one shell.
- The deploy runbook is rehearsed on WSL's Ubuntu with the workstation's Docker, not in Git Bash. A file mounted from Windows shows root as its owner and mode 777, so the wrapper would rightly refuse it. A file in the WSL file system keeps its owner and 0600, as on a Linux host.
- The clean machine of `consumer-local.md` is the fixture's own application image, without MyKey, plus `curl`, which the runbook names as needed. There is one machine per fixture: a FastAPI developer has Python.
- The wrapper is fetched from the repository at the release tag (`gh api …/contents/…?ref=cli-v0.1.0`), not from the release. The release is never changed, and its archive's three entries are fixed (D-44).
- Issuing and revoking are by the owner through the API: the web workspace is Session 7. The runbooks point to `machine-credentials.md`.
- Ordering: the Dockerfiles, the apps and the runbooks were written before their tests' first run. Each test was then watched fail for a real reason (no context; the WSL search) before it passed.
