# Session 10 review: `session-10` against `main` (`4c1ab89..3c21f3f`)

_The fresh-context review of Run 10.5 Task A (P-175), saved as it came. One reviewer (model `fable`), read-only, given the diff, `known-limits.md` and Doc 10 §4.1, not the plan or the run notes. What was done about each finding is in `run-10.5.md`._

**Summary.** I read the whole diff except the plan and the run notes, plus `known-limits.md` and Doc 10 §4.1. No Critical finding, and no secret or token-shaped string in any added line. There is one High: commit `a45e0b2` overwrote `tests/unit/probe/heartbeat.test.ts`, deleting six Worker tests that the release manifest still names as proof. There are four Mediums: the token step's echo comes back on between its reads; the guide's `--override` cannot be used without the agent handling the token; the leak check now refuses many base64 values; and the agent proof's file sweep ignores a failed `docker cp`. The drill's trigger cannot leave OpenBao frozen beyond its bounds and cannot reach production by any code path here. `probe.ts secrets --host` touches only its one host. No assertion in the three named test files is weaker than before.

- **What I ran:** the changed unit files (61 tests), and the token step without a terminal in Git Bash (bash 5.2). 60 of 61 unit tests passed on the first run; `freeze-trigger` "killed while holding" timed out once in three runs.
- **What I did not run:** the step on a real terminal, `test:cli`, or any staging file. Findings about terminal echo are reasoned from bash's `read`, not reproduced.
- **HEAD moved during the review.** `3c21f3f` fixed two things I had found on `0390daf`: `pins.test.ts` failed on the new Dockerfile, and the Next.js recipe line was wrong. The two newest CI runs listed for the branch (10:31 UTC) are failures; check the run for `3c21f3f`.

## (a) The token step

- **Medium — echo is on between the reads.** `docs/runbooks/consumer-local.md:117` and its four copies; the same loop in `scripts/consumer-leak-check.sh:44-50`.
  - **What goes wrong:** each `read -s` restores the terminal when it returns, so echo is on between the first read and every pass of the drain loop. Text that reaches the terminal in such a gap is echoed.
  - **Scenario:** the owner pastes a dotenv file larger than the terminal's 4,096-byte input queue, or pastes over a slow SSH link. The first chunk arrives with echo off; later chunks can land in a gap and show whole lines of values.
  - **Why the test misses it:** `tests/cli/token-step.test.ts` sends its three lines in one small write. "Nothing you paste is shown" is proven only for that case.
  - **Fix:** keep echo off for the whole command after the first read (`stty -echo 2>/dev/null` with `trap 'stty echo 2>/dev/null' EXIT`; it comes after the read, so nothing fallible precedes the read). Add a test with a paste over 4,096 bytes sent in chunks.
- **Low — an empty line ends the step.** Same line. The panel tells the owner to leave the prompt waiting and go to the browser (`apps/web/src/copy/connect.ts`, `local-store`). A stray Enter in between gives `Nothing was stored`, exit 1, and a shell prompt; the token pasted on return goes to the shell and its history. Fix: on an empty first line, prompt again instead of exiting.
- **Low — an existing file is written before its mode is set.** The command writes, then runs `chmod 600`. A token file that already exists with mode 0644 in a 0755 directory holds the new token readable by others for a moment. `mkdir -p` also leaves an existing directory's mode alone, so D-76's "directory of mode 0700" holds only for a new one. Fix: `chmod 600` an existing file before the write.
- **Low — a failed write gives neither documented outcome.** A failing `mkdir`, redirect or `chmod` prints the shell's own error and exits with that command's status. D-76 item 6 and the runbook promise `Token stored.` or `Nothing was stored`. No token is shown. Fix: add `|| { echo "Nothing was stored: …"; exit 1; }`.
- **Low — behaviour differs by bash version, untested.**
  - bash 3.2 (macOS) does not keep partial input when `read -t` times out. A token followed by an unterminated fragment is stored and the fragment dropped; bash 4 and later refuse it.
  - On bash before 5.0 with a glibc UTF-8 locale, the ranges in `[^A-Za-z0-9._-]` can let accented letters through. The CLI then refuses the file with exit 64.
  - The Ctrl-C test runs only with bash 5 as both shells.
- **No finding on the rest.**
  - The command holds no `'`, `!` or backtick, so bash, zsh, dash, fish and tcsh pass it unchanged.
  - The token is in no argument (`printf` is a builtin) and no history.
  - Nothing that can fail comes before the read except starting `bash` itself, which is a known limit.
  - A refusal leaves an existing token file untouched.
  - A paste before the prompt and a line later than one second are known limits.
  - Without a terminal I confirmed: a token; a token and an empty line; a token and a fragment (refused); two lines (refused); a leading empty line (refused); a space (refused); no line end (stored); empty (refused).

## (b) The guide and `llms.txt`

- **Medium — `--override` cannot be used without the token.** `docs/agents/connect-an-application.md:139` tells the agent that `secrets run --override -- <command>` lets a secret win. The launcher ends with `exec secrets run -- "$@"` (`tests/fixtures/consumers/secrets-launch.sh:35`) and has no way to pass `--override`. Run directly, `secrets run` needs `SECRETS_MACHINE_TOKEN`, so the agent must read the token file into a command, which §13 forbids. `guide.test.ts` only checks that `parseArgs` accepts the line, and `claims.md` cites `buildChildEnv`. Fix: remove the sentence and give `env -u NAME secrets-launch.sh -- …` instead, or say it is not available through the launcher.
- **Low — the `/check` example invites an unsalted digest endpoint.** Line 207 says the fixtures answer with each name and the SHA-256 of its value. An agent can copy that into a real application, where a short secret's digest can be guessed offline, and the digests enter its transcript. Fix: say names or presence only, and not to add such a route.
- **Low — the exit-code table says less than the code.** Lines 224-231.
  - 64 is also a token file whose content is not a token (`apps/cli/src/token.ts`) and a command that cannot be found (`run.ts`). The advice "fix the command or the settings" then points an agent at the token file. It should say `replace-token`.
  - 75 is also an environment too large for the platform (`checkSize`), where waiting does not help.
  - The launcher runs under `set -eu`, so an unreadable token file exits with `cat`'s status, outside the table.
- **No finding on the rest.** The marked blocks equal the runbooks' byte for byte. The limits are `LIMITS`, the name rule is `SECRET_NAME_PATTERN`, and every `SECRETS_*` name is read by the CLI or the launcher. The names-only command prints names only. No block outside §13 reads the token file, prints the environment, exports or opens `.env`. `llms.txt` puts the rule before any link.

## (c) The drill's trigger

- **No finding: OpenBao cannot stay frozen.** The unit is started by `systemd-run` without `--wait`, so a dead SSH session or test process does not affect it. Each exit path thaws:
  - a normal end, exit 3 and a signal run the script's `EXIT` trap;
  - SIGKILL and the 60-second `RuntimeMaxSec` run `ExecStopPost`;
  - a test that throws runs the `finally` thaw.

  The longest freeze is the 8-second hold.

- **No finding: it does not reach production by any path here.** The script is under `tests/staging/host-scripts/`; `host.ts push` sends only `infra/hosts/**` and `infra/compose/host*`. The drill file fixes `host` to `loadHosts().staging`.
- **Low — `hostUnit` takes any host.** `tests/harness/staging.ts:36-44` checks the unit's name but not the host, so "never on production" rests on its callers. Fix: throw unless `host.name === "staging"`.
- **Low — a flaky test and a small race.** `tests/unit/hosts/freeze-trigger.test.ts:108` timed out once in three runs here. A likely cause is `tests/staging/host-scripts/freeze-on-create.sh:58-59`: a TERM between `sleep "$hold" &` and `sleep_pid=$!` leaves the sleep alive, holding the test's pipe for 30 seconds. On the host, systemd kills the unit's group and the freeze file is still thawed. Fix: kill `$(jobs -p)` in `cleanup`.
- **Low — two stale texts.** `docs/runbooks/known-limits.md:129` still says the drill places its fault by chance and tries ten times. `tests/staging/credential-drill.staging.test.ts:270` still speaks of five issuances per attempt.

## (d) Weaker assertions

- **`tests/unit/web/connect-commands.test.ts`: no finding.** The `stty` entries leave the expected lists because the step changed. The token step must now equal the runbook's block alone, start with `bash -c '`, and carry the new warning without `stty`.
- **`tests/browser/navigation.test.ts`: no finding.** It is stronger: one block, no "part 2", and the clipboard equals the block.
- **`tests/staging/credential-drill.staging.test.ts`: no finding of weakening.** The expectations are the same, and the attempts drop from ten to five.
  - **Low — a gap in the new claim.** `matched` is only recorded (line 247). The pass at line 254 accepts an `outcome_unknown` from any cause. Fix: require `matched` for the caught attempt.

## (e) `hostSysCall`

- **No finding on the names of the unit tests.** Tests 1, 2 and 4 prove what they say. Test 3 proves removal by the command's text only. Test 5's "holds no token" cannot fail while the message stays a constant.
- **No finding on the token and key.** Both travel on stdin only. On the host `read` and `printf` are builtins and curl reads the header from a 0600 file, so nothing is in an argument or in sudo's log. Both callers register the bare values for redaction.
- **Low — a non-JSON answer can quote the body.** `scripts/host.ts:2813` lets `JSON.parse` throw; V8's message quotes a slice of the text, which for the generate-root calls can hold part of the one-time password or the encoded token. Fix: catch and throw `OpenBao <path>: answer is not JSON`.
- **Low — the header file survives a killed session.** `scripts/host.ts:2802` removes it after curl, with no trap. A dropped SSH session during curl's 30 seconds leaves the root token header in a root-only temporary file. Fix: `trap 'rm -f "$h"' EXIT`.
- **Low — the staging test can leave a root token alive.** `tests/staging/host-sys-call.staging.test.ts:42-49`: if the lookup after `generateRoot` fails, `madeAccessor` is never set and `afterAll` revokes nothing. The token is in memory only, but root tokens do not expire. Fix: keep `made` and revoke it by token in `afterAll`.

## (f) `probe.ts secrets --host`

- **No finding.** `scripts/probe.ts:528-532` routes `--host` to `installHeartbeat(heartbeatInstallPlan(host))` only. That path reads the existing `heartbeat-<host>` file, creates no token, makes no Cloudflare call, and connects to that one host. Any other argument after `secrets` now prints usage instead of rotating everything, which is stricter than before.
- **Low — the unit test proves less than its name.** `tests/unit/probe/heartbeat.test.ts:24-36` checks the plan's shape. `not.toMatch(/\bprod\b/)` cannot fail, because the commands never name a host, and the dispatch in `main` is untested.

## Other

- **High — six Worker tests were deleted by overwriting their file.** Commit `a45e0b2` replaced the whole of `tests/unit/probe/heartbeat.test.ts` with the `--host` tests.
  - **What is gone:** the strict acceptance of the old and version-2 heartbeat shapes (`readHeartbeat`, P-116), the heartbeat route's 204 and 400, the state route's `evaluatedAt`, and the test alert's rule that any token but the read token answers 404 and sends nothing (P-117). Nothing else in `tests/` calls `readHeartbeat` or the test-alert route.
  - **Scenario:** a change that lets the Worker accept an unknown heartbeat key, or the test alert accept a heartbeat token, now passes CI.
  - **Evidence effect:** `docs/evidence/session-9/proof-map.json:1609` (AC-1.49) and `session-8/proof-map.json:1511` name this file as CI proof, so a Session 10 manifest would count it.
  - **Fix:** restore the file from `4c1ab89` and move the new tests to a file of their own.
- **Medium — the leak check refuses many real values.** `scripts/consumer-leak-check.sh:53` refuses any line matching `^[A-Za-z_][A-Za-z0-9_]*=`. A base64 value with padding and no `+` or `/` matches; that is roughly a quarter of 32-byte keys. The owner gets "Not taken: one value, not a file" and cannot search for that value at all. I confirmed the match with synthetic strings. Fix: require a character other than `=` after the first `=`, or refuse only upper-case names.
- **Medium — the proof's file sweep can be partial and still pass.** `tests/staging/agent-guide.staging.test.ts:511` ignores `docker cp`'s exit code. On Windows, `docker cp` is known to stop at the first symbolic link it cannot create (`node_modules/.bin`). If `.env.example` was copied before that, the control is found, and "needles: 0" then covers only part of the agent's files. Fix: check the exit code, or count needles inside the container with the needles on stdin.
- **Low — the sweep leaves a token copy on the workstation.** The same `docker cp` copies the token file and the transcripts to the temporary folder, removed only at the next run (line 296). The token is revoked in `afterAll` and lasts an hour. Fix: remove the folder at the end.
- **Low — "two passwords refused" accepts an accepted password.** `tests/staging/redrill.staging.test.ts:696-712`: when the sign-in answers 200, the helper returns the status of the next request. A password-only session gets 401 or 403 there, so the test passes even if the old password still works. This is inherited from `drill.staging.test.ts:717`. Fix: require the sign-in itself to be refused.
- **Low — two texts put "issue" before "store".** `apps/web/src/help/articles.ts:211-212` and `docs/runbooks/consumer-local.md:101-105`. Copying the 446-character command after copying the token replaces the token on the clipboard; the token is shown once. The panel, `consumer-deploy.md` §5 and `machine-credentials.md` have the right order.

## Findings

| #   | Question | Finding                                                                                               | Severity   |
| --- | -------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Other    | `tests/unit/probe/heartbeat.test.ts` overwritten; six Worker tests gone; AC-1.49 still names the file | **High**   |
| 2   | (a)      | Echo is on between the token step's reads; a large or slow paste can show (also the leak check)       | **Medium** |
| 3   | (b)      | The guide's `--override` cannot pass through the launcher; using it means handling the token          | **Medium** |
| 4   | Other    | The leak check refuses padded base64 values as `NAME=value`                                           | **Medium** |
| 5   | Other    | The agent proof's `docker cp` is unchecked; the file sweep can be partial and pass                    | **Medium** |
| 6   | (a)      | An empty line ends the step; a later paste goes to the shell                                          | **Low**    |
| 7   | (a)      | An existing 0644 file is written before `chmod`; an existing directory keeps its mode                 | **Low**    |
| 8   | (a)      | A failed write gives neither documented outcome line                                                  | **Low**    |
| 9   | (a)      | bash 3.2 and locale differences, and Ctrl-C, are untested                                             | **Low**    |
| 10  | (b)      | The `/check` example invites an unsalted digest endpoint                                              | **Low**    |
| 11  | (b)      | The exit-code table omits cases of 64 and 75 and the launcher's own exits                             | **Low**    |
| 12  | (c)      | `hostUnit` is not restricted to staging                                                               | **Low**    |
| 13  | (c)      | `freeze-trigger` test flaky; `sleep_pid` race in the script                                           | **Low**    |
| 14  | (c)      | `known-limits.md:129` and a drill comment are stale                                                   | **Low**    |
| 15  | (d)      | The drill does not require that the trigger matched                                                   | **Low**    |
| 16  | (e)      | A non-JSON answer's parse error can quote the body                                                    | **Low**    |
| 17  | (e)      | The header file survives a killed SSH session                                                         | **Low**    |
| 18  | (e)      | The staging test can leave a new root token unrevoked                                                 | **Low**    |
| 19  | (f)      | The `--host` unit test proves the plan's shape, not the dispatch                                      | **Low**    |
| 20  | Other    | The agent proof leaves a token copy and transcripts in the temporary folder                           | **Low**    |
| 21  | Other    | Redrill's "passwords refused" passes when a password is accepted                                      | **Low**    |
| 22  | Other    | The help article and `consumer-local.md` put "issue" before "store"                                   | **Low**    |
| –   | (c)      | A stuck freeze, or reaching production                                                                | no finding |
| –   | (d)      | Weaker assertions in the three files                                                                  | no finding |
| –   | (f)      | Changing anything but the one host                                                                    | no finding |
| –   | Other    | A secret or token in Git                                                                              | no finding |
