# Run 10.3 — The credential drill's trigger (local part)

**Date:** 23 Nov 2026. **Branch:** `session-10`. **Real time:** about 1 h (box 1 h). D-78 is written in Run 10.6 Task D, with the measured times.

## What was done

- `tests/staging/host-scripts/freeze-on-create.sh`: the trigger. It follows OpenBao's audit device from its end and, at the first **request** record of `auth/token/create/machine-env-<environment id>`, writes 1 to OpenBao's `cgroup.freeze`, holds, and writes 0. The freeze file reads 0 at every exit, a signal included; the hold runs in the background so a stop thaws at once. It prints four lines of a word and a time, and nothing of any audit line.
- `tests/unit/hosts/freeze-trigger.test.ts`: five cases against temporary files with synthetic records of OpenBao's shape.
- `hostUnit()` in `tests/harness/staging.ts`: a script sent for one run, written under `/run`, started as a transient `systemd-run` unit with `RuntimeMaxSec` and an `ExecStopPost` that thaws and removes the script. Its output comes from the journal.
- `tests/staging/credential-drill.staging.test.ts`, re-aimed: up to five attempts of one issuance each, each in a fresh minute, with the trigger armed for that environment. Everything after "caught" is unchanged. `docker pause` and the five-shot aiming are gone. The evidence moves to `docs/evidence/session-10/credential-drill.json`.

**No change under `apps/`, `packages/` or `infra/compose`, and no host file.** The trigger is never under `infra/hosts`, so `host.ts push` cannot carry it to production.

## Commands and results

| Command                                                                                   | Result                                                            |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `pnpm exec vitest run --project unit tests/unit/hosts/freeze-trigger.test.ts` (no script) | 5 failed                                                          |
| the same, with the script                                                                 | 4/5; "killed while holding" read 1 (the trap waited out the hold) |
| after the background hold, and the sleep killed in the cleanup                            | 5/5, three runs in a row                                          |
| `pnpm exec vitest run --project unit tests/unit/hosts`                                    | 264/264                                                           |
| `pnpm run check`                                                                          | green (the drill file type-checks; it runs in Run 10.6)           |

## Deviations and decisions

- The kill case is driven by a bash parent that sends SIGTERM when the freeze file reads 1, as systemd stops a unit: a signal from Node is not one on Windows.
- `hostUnit` refuses a `stopPost` holding `"`, `$` or `\`: systemd parses the command line itself.
- The drill finds the freeze file from the container's id (`/sys/fs/cgroup/system.slice/docker-<id>.scope/cgroup.freeze`) and the audit file through the volume's source, and refuses to start if either is missing. Whether staging's Docker uses that cgroup layout is checked first thing in Run 10.6 Task D Step 1.

## Open issues

- The record's place in the order (written before the request is handled) is OpenBao's documented behaviour; Run 10.6 Task D Step 1 measures it on staging before the drill.
