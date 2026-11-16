# Run 5.6 — CLI `run` and `export`

**Result: DONE on 15 Nov 2026.**

- **`secrets run`** starts the command only with the complete, validated set. The child's environment holds no `SECRETS_*` variable, and a collision fails unless `--override`. The size is checked against the platform before the spawn. There is no shell, and stdin belongs to the child.
- **Signals:** `SIGTERM` is forwarded once. `SIGINT`, `SIGHUP` and `SIGQUIT` are forwarded once without a terminal; with a terminal, Ctrl-C reaches the child once. A signal before the spawn starts nothing (`130`). The CLI's status is the child's, or `128 + n`.
- **Twenty-one damaged answers** each give their exit code. In every case no child was started, and `HOME`, `TMPDIR`, `XDG_*` and the working directory stayed empty: a cut body, a short connection, a wrong count, `complete` false or absent, a duplicate, a missing value, HTML, `{}`, another `apiMajor`, a redirect, and the eleven refusals.
- **The token** is in no environment variable of the child, in no argument list of the process group (`/proc/<pid>/cmdline`), and nowhere on stdout or stderr.
- **`secrets export`** writes one new `0600` file whose parsed digests are the set, or nothing.
  - An existing file, a link at the target, a link in the directory's path and a group-writable directory each give `73`, and nothing is touched.
  - A umask of 000 still gives `0600`; a umask of 277 gives a working `0400` file.
  - A failure after the creation unlinks only the file this invocation created; otherwise it reports `cleanup required`.
- **Staging**, through the public name and in the glibc container:
  - `keys` printed the ten names;
  - `run`'s child had the owner's digests;
  - `export` wrote `0600` with the same digests;
  - after the revocation, `run` and `keys` exited `77` and started nothing.
- Decisions: D-43 (completed).

FR-1.48 SPIKE_PASS — run: `tests/cli/run.test.ts` (13), `tests/unit/cli/child-env.test.ts` (6), `tests/staging/cli.staging.test.ts`. Linux (container) evidence; macOS is Run 5.7.
FR-1.49 SPIKE_PASS — failure launches nothing: `tests/cli/run.test.ts` "nothing starts on anything less than the complete set" (21 cases, exit code, no marker, every directory empty) and "a signal before the spawn starts nothing"; the staging run after revocation (77, no output). Linux evidence.
FR-1.50 SPIKE_PASS — export: `tests/cli/export.test.ts` (8), `tests/unit/cli/export-target.test.ts` (5), the staging export (`0600`, digests). Linux evidence.
AC-1.20 SPIKE_PASS — complete values to a process without files or credentials: argument vectors, collisions, stdin, size limits, pre-spawn cancellation and signals without double forwarding (`run.test.ts`), on Linux; the Next.js and FastAPI fixtures are Run 5.8, the four platforms Run 5.7.
AC-1.21 SPIKE_PASS — export target safety: `export.test.ts` and `export-target.test.ts` on Linux.

## What was done

- **`apps/cli/src/run.ts`:** `buildChildEnv`, `checkSize` (`argMax` injectable) and `runCommand` (signal handlers before the resolve, `spawn` with `shell: false`, the child assigned at once).
- **`apps/cli/src/export.ts`:** `ExportFs` (node:fs by default), `checkTarget` and `exportCommand`. Paths are POSIX.
- **`main.ts`** wires both commands. The token travels in a holder that each command empties after its one request.
- **`token.ts`:** `run` passes no stdin.
- **`bin.ts`:** the standard streams are getters.
- **Tests:**
  - `tests/cli/child.mjs`: the child, which writes names, digests, arguments, starts and signal counts;
  - `tests/cli/run.test.ts` (13) and `export.test.ts` (8);
  - `tests/unit/cli/child-env.test.ts` (6) and `export-target.test.ts` (5);
  - `tests/harness/cli.ts` gains `startCli` (signals, process groups, open stdin, a wrapper such as `script` or `sh -c 'umask …'`);
  - `tests/harness/cli-linux.ts` (`runCliInLinux`, `runShellInLinux`);
  - `tests/staging/cli.staging.test.ts`.
- **D-43** completed.

## Commits

- `3bb1e44` feat(cli): run starts a process with the complete set or not at all; export writes one new private file or nothing
- this commit: test(staging): the CLI against the deployed API

## Commands and results

| Command                                                                                                                                 | Result                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/cli` before the exports                                                                                                     | RED (10 failed: functions missing); after: 35 passed                                                                                                |
| `node scripts/test-cli.ts tests/cli/run.test.ts tests/cli/export.test.ts`, `main` not wired                                             | RED (21 failed: "run/export is not in this build")                                                                                                  |
| the same after wiring                                                                                                                   | 41 of 43 green: two harness faults (stdin taken for a token; a `sh` under `script` died of SIGINT), fixed in the harness; then 43                   |
| mutation run: SIGINT forwarded despite a terminal; `SECRETS_*` kept; no exit before the spawn; mode `0644`; no link check per component | 7 failed (6 mutations caught); the link-component mutation survived: the next check refuses a link (`lstat` of a link is not a directory); restored |
| `pnpm run test:cli`                                                                                                                     | 43 passed (5 files, Linux container)                                                                                                                |
| `pnpm test` (unit)                                                                                                                      | 937 passed                                                                                                                                          |
| `tests/staging/cli.staging.test.ts` (alone)                                                                                             | 1 passed: keys 0, run 0 (10 names, no `SECRETS_*`), export `600` with equal digests, after revoke run 77 and keys 77, stdout empty                  |
| `pnpm run check`                                                                                                                        | exit 0                                                                                                                                              |

## TDD

- `run.ts` and `export.ts` were drafted before their tests.
- The process tests then ran RED against the unwired `main`, and the unit tests ran RED before the modules were exported.
- The reach of the specific rules is proven by the mutation run.

## Deviations and decisions (rulings in the ledger)

- Tasks A and B are one commit, because `main` wires both.
- `export` uses POSIX paths explicitly, so its unit test runs on the Windows workstation too.
- `checkSize` takes an optional `argMax`.
- A reserved name or a NUL in a value is `65`; a collision is `64`.
- The standard streams are lazy, and `run` never touches stdin.
- The process-group scan reads `/proc` on Linux, because the glibc image has no `ps`. It uses `ps` on macOS.
- The terminal case runs `script -qec 'exec …'`.
- `runCli` treats stdin as a token only with `--token-stdin`.
- The staging test runs `export --output` (Doc 04), not `--out`.

## Open issues

- **macOS evidence for all of this run is Run 5.7.** That covers the `script` form, `ps` and `ARG_MAX` of 1 MiB.
- The staging test leaves its project, with every credential revoked, as the other staging files do.

## What Run 5.7 must know

- `pnpm --filter @mykey/cli test` on a runner runs project `cli`. Its global setup needs `openssl` (`-days -1`, `-addext`) and builds the bundle unless `MYKEY_CLI_BIN` is set.
- `run.test.ts` needs `script` and `getconf`. On macOS it uses `ps` and `script -q /dev/null …`.
- The bundle is the same bytes on every platform: `apps/cli/dist/secrets.mjs`, built by `pnpm run cli:build`.
