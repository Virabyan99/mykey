# Run 10.5 — The freeze, `host-v0.9.2`, staging, production

**Date:** 23 Nov 2026. **Branch:** `session-10`. **Frozen commit:** `0486f24`.

## Task A — The freeze

- **The diff check.** `git diff --name-only host-v0.9.1..HEAD` holds only D-69's classes, apart from `workers/probe/wrangler.jsonc`, which is Session 9's (Run 9.1, production in service) and is not part of a host release. This session's own diff (`4c1ab89..HEAD`) has nothing outside the classes.
- **Full CI by hand**, three runs:

  | Run         | Commit    | Result                                                                                                                                                                                                                            |
  | ----------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 45156894756 | `0390daf` | `check` red: `tests/unit/pins/pins.test.ts` lists the test tools' images exactly, and `agent-guide` was missing. Fixed; the whole unit project had not been run since the image was added                                         |
  | 45158814529 | `3c21f3f` | `browser` red: axe `scrollable-region-focusable` on the connect page (the longer one-line command scrolls sideways). `scans` red: 14 new krb5 findings (HIGH, 56 rows) in the pinned postgres image, published upstream overnight |
  | 45164524607 | `0486f24` | **green**, every job                                                                                                                                                                                                              |

- **The krb5 findings** are in `.trivyignore.images` with their reason: no `pg_hba` line on any host or in dev uses `gss`, `sspi` or `hostgssenc` (only `scram-sha-256` and `reject`), and most are in the KDC and kadmind, which the image does not ship. Debian has the fix; moving the postgres pin is a runtime image change after Gate R (D-69), so it is an owner question, not done here. They expire with the others on 14 Dec 2026.
- **The fresh-context review** (`review.md`, saved as it came): one reviewer on the most capable model, read-only, with the diff, `known-limits.md` and Doc 10 §4.1. No Critical; one High; four Medium; seventeen Low.
- **The claims walk** (`claims.md`): one recipe line in the guide was wrong (in Next.js a set variable wins over `.env`) and is corrected.
- **`cli-matrix`** (run 45166999715) against `cli-v0.1.2`: green on linux-x64, linux-arm64, darwin-x64 and darwin-arm64; it runs the branch's `tests/cli`, so `token-step.test.ts` passed 15/15 on macOS. The job does not print the `bash` it used; GitHub's macOS runners put Homebrew's bash 5 first on `PATH`, so bash 3.2 is not proven (valve 3, partly taken).

### What was done about the review

| #           | Severity                 | Finding                                                                                                                                                                           | Done                                                                                                                                                                                                                        |
| ----------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1           | High                     | `heartbeat.test.ts` overwritten, six Worker tests gone                                                                                                                            | restored from `4c1ab89`; the `--host` tests are in `heartbeat-host.test.ts`                                                                                                                                                 |
| 2           | Medium                   | echo on between the token step's reads                                                                                                                                            | the command keeps the echo off throughout, after a trap that turns it back on. A new test (300 lines in separate writes) passes on the old block too, so the gap was **not reproduced**; the change is kept as a precaution |
| 3           | Medium                   | the guide's `--override` cannot pass through the launcher                                                                                                                         | removed; `env -u NAME secrets-launch.sh -- …`; a guide test refuses `--override` and any `secrets run` line (seen failing first)                                                                                            |
| 4           | Medium                   | the leak check refuses padded base64 values                                                                                                                                       | a `NAME=value` line needs a character other than `=` after the `=`; test seen failing first                                                                                                                                 |
| 5           | Medium                   | the proof's `docker cp` unchecked                                                                                                                                                 | the files are searched inside the container (`tests/harness/agent-sweep.ts`), and a failed search fails; checked in a local container (excluded paths only: 0; a planted leak: 2; a broken home: exit 2)                    |
| 6, 7, 8     | Low, re-graded Important | an empty line ended the step (the next paste, a token, went to the shell); an existing file or directory kept its mode until after the write; a failed write gave neither outcome | fixed in the same command; three terminal tests seen failing first                                                                                                                                                          |
| 13          | Low, re-graded Important | a flaky freeze-trigger test in `check`                                                                                                                                            | the script kills every job it started; 18 of 19 runs passed after the fix (the one failure, right after a heavy formatting run, was not captured)                                                                           |
| 22          | Low, re-graded Important | two texts said "issue" before "store" (copying the command then replaces the token on the clipboard)                                                                              | the help article and `consumer-local.md` §7 now say to start the command first                                                                                                                                              |
| 9–12, 14–21 | Low                      |                                                                                                                                                                                   | deferred; listed in the session report                                                                                                                                                                                      |

## Task B — The release

- **Built once** in the clean clone `~/mykey-release/src` at `0486f24` (`node infra/release/build.ts --version 0.9.2`). The first build was stopped by Claude Code for low memory after three archives; its partial folder was removed and the build started again, alone, on the owner's word. No host file (`infra/`) changed since `host-v0.9.1`, so no `push` is needed.

  | Image       | Digest                                                                    |
  | ----------- | ------------------------------------------------------------------------- |
  | api         | `sha256:dbdf340feb2760f1f12679c22196230e30759c22d7de86cc0ffb9f868b665c7a` |
  | provisioner | `sha256:66948873895475d748699732bf1e946f126ee423c59da7a720251b9bdf436043` |
  | ops         | `sha256:b873a4599a84798d825016b2b1fd4d18f95c60b198200e99c264652c5ea78152` |

- **Published:** `gh release create host-v0.9.2 --target session-10`, five files (three archives, `release.json`, `SHA256SUMS`); the tag is at `0486f24c3b6e`.
- **The candidate:** `candidate.json` (`release-candidate.ts --session 10`), `host-v0.9.2` with `cli-v0.1.2`.

## Task C — Staging

_Pending._

## Task D — Production

_Pending (the owner's answer 1)._
