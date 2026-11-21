# Run 8.4 — Forbidden-surface canary sweep (Task A)

_20 Nov 2026. Plan: `docs/plans/session-8-plan.md`, Run 8.4 Task A (P-152, P-148, D08-S44). Task B (the sweep on the candidate) is Run 8.7's._

## What was done

**The seed (`tests/harness/sweep.ts`, `seedAndExercise`).** The seed runs as the staging owner, through the public name.

- **The controls:** a project and a secret, each named with a canary-shaped, upper-case control. The control secret's create answer gives the control request id.
- **The values:** three secrets with canary values (one created, one updated, one imported). They are revealed, one is revealed at an older version, and they are exported.
- **A machine token:** issued, used once by `resolve`, and revoked.
- **The owner's credentials:**
  - an operator reset of kind `password`, completed;
  - the recovery codes regenerated;
  - a sign-out.

  The new password and the new codes went to custody.

- **The needles, of ten kinds:**
  - the values;
  - the machine token;
  - every session cookie;
  - the old and new owner passwords;
  - the TOTP seed;
  - the ten recovery codes;
  - the reset token;
  - and from custody: the root token (M1, D-65), the backup password and the maintenance password.

  TOTP codes are not needles: six digits are found by chance anywhere.

**`countOnHost` gains needle controls** (`tests/harness/search-script.ts`). Controls can now travel with the needles: on stdin, read into a shell variable that is never exported, and handed to grep through a here-document on fd 4. They are never an argument. Three counts come back. A needle shorter than 8 bytes is refused. The script is unit-tested in a local `sh` (`tests/unit/hosts/search-script.test.ts`).

**`tests/staging/sweep.staging.test.ts`.** Every surface has its control, and only counts are written (`run-8.4-sweep.txt`). The surfaces, in run order:

1. **The database:** a plain `pg_dump` of every schema.
2. **OpenBao's audit device:** the live file and the rotated files.
3. **The audit archive:** searched after a rotation and an archive run.
4. **A pair captured after the seeding:**
   - the pair is downloaded and restored on the workstation;
   - the dump is turned into text with the pinned `pg_restore`;
   - also searched: `globals.sql`, a `restic check --read-data` log of the same repository, and `eligible.json`;
   - `openbao.snap` is searched as bytes; OpenBao encrypts it, so that search proves little.
5. **Containers and processes:** the containers' environments and argument lists, and every process's arguments and environment.
6. **The journals since the start:**
   - the API's log, with the control request id;
   - the edge's log, with the control name;
   - the provisioner's log;
   - the postgres and openbao logs, and every `mykey-*` unit's journal.
7. **The reference:** the page with its inline bundle, and the OpenAPI document.
8. **The operator's views:** `host.ts staging status --json` and `probe.ts state staging`.
9. **The workstation:** the operator's shell histories (Git Bash and PowerShell).
10. **Clean-up:** the sweep's project is archived. A run that is interrupted leaves its project behind, and the next run archives it.

The file's header lists what the sweep cannot see:

- TOTP codes on the host;
- the page's memory and its query cache;
- the inside of the encrypted snapshot;
- the text of a delivered alert;
- an agent's transcript.

**The local half (`tests/browser/canary.test.ts`).** After the browser's scan, the session cookie and its token become needles. They are searched, with every needle of the journey, in the local dump (`pgDump`), the API's and the provisioner's log lines, and OpenBao's audit device. Each of those places has its control: a secret name of the journey, `"event":"request"`, `"event":"job"`, and the secret name again.

**Canaries in upper case.** `token-sweep.staging.test.ts` and `drill.staging.test.ts` used lower-case hex, which the secret scan's rule (`MYKEY_CANARY_[A-Z0-9]{32}`) does not match. Both are upper case now.

**`scripts/sweep-ci.ts <file>…`.**

- **What it counts:** canary-shaped strings (in any case) and OpenBao token shapes (`hvs.`, `hvb.`, `hvr.`, and the legacy `s.` followed by 24 characters).
- **What it prints:** one line of counts per file, never what it found.
- **Exit codes:** 1 when any file holds one, 2 without a file or when a file cannot be read.
- **The test:** `tests/unit/registry/sweep-ci.test.ts` assembles both shapes at run time and plants them in temporary files.

**The reset helper moved.** The operator-reset helper of `identity.staging.test.ts` is now in the harness (`initiateOwnerReset`, `completeOwnerPasswordReset` and `stagingOps` in `staging-owner.ts`). The identity file uses it.

**D-65** records M1 as an accepted limit of Stage 1, unless reviewer 3 rates it high.

### Results (the staging run, `host-v0.7.0`)

Twenty searches were made. None found a needle, and every control was found:

| Surface                                                   | Needles found | Controls     |
| --------------------------------------------------------- | ------------- | ------------ |
| database (`pg_dump`, every schema)                        | 0             | 2 of 2       |
| OpenBao audit device (live and rotated)                   | 0             | 1 of 1       |
| audit archive (1 segment since the start)                 | 0             | in 1 segment |
| pair: dump as text, globals, check log, manifest          | 0             | 2, 1, 1, 1   |
| pair: `openbao.snap` as bytes                             | 0             | —            |
| containers' and processes' environments and arguments     | 0             | 1 of 1       |
| API log; edge log; provisioner log                        | 0; 0; 0       | 1 of 1 each  |
| postgres and openbao logs, every `mykey-*` unit's journal | 0             | 1 of 1       |
| reference page with its bundle; OpenAPI document          | 0; 0          | 1 of 1 each  |
| `host.ts staging status --json`; `probe.ts state staging` | 0; 0          | 1 of 1 each  |
| shell histories (2 files)                                 | 0             | 1 of 1       |

The root token (M1) is on none of these surfaces.

AC-1.13 SPIKE_PASS: after create, update, import, reveal, a historical reveal, export, issuance, resolve, revocation, an operator reset, recovery-code regeneration and sign-out on staging, no needle of ten kinds is on any surface of the host, in the audit archive, in a pair captured afterwards, in the operator's views or in the shell histories. Every surface has a control (`tests/staging/sweep.staging.test.ts`). The browser's half extends to the dump, the logs and OpenBao's audit device (`tests/browser/canary.test.ts`).

AC-1.50 SPIKE_PASS: the synthetic secrets and identifiers are seeded labelled. They are canary-shaped and upper case, assembled at run time, and the control travels as they do (`tests/harness/sweep.ts`). The secret scan's rule matches them, and `scripts/sweep-ci.ts` counts them in CI logs (`tests/unit/registry/sweep-ci.test.ts`).

## Commits

- `test(sweep): every kind of secret against every surface, with controls that travel as the needles do`.

## Commands and results

- `pnpm exec vitest run --project unit tests/unit/hosts/search-script.test.ts`:
  - RED: the module was missing;
  - RED again: a here-document followed by `|| true` inside a command substitution is a syntax error in bash;
  - GREEN: 4 tests.
- `pnpm exec vitest run --project unit tests/unit/registry/sweep-ci.test.ts`: RED (the module was missing), then GREEN with 3 tests.
- `pnpm run test:staging tests/staging/sweep.staging.test.ts`, three runs:
  - **Run 1** stopped in the seed. The export answers a dotenv attachment, which the seed tried to parse as JSON. The error printed the first ten characters of that body: the control secret's name prefix, not a needle. No reset had been made. The project was left behind and archived by run 3.
  - **Run 2** had 9 of 10 tests green. The archive test failed because a decompressed OpenBao segment is longer than a JavaScript string may be. The segments are now searched as bytes.
  - **Run 3** was 10 of 10 green in 211 s.
- `pnpm run test:browser tests/browser/canary.test.ts`: 1 passed.
- `pnpm run evidence:build`: 191 items.
- `pnpm run check`: green.
- CI of Run 8.2's push: green (2m20s).

## Deviations and decisions

- **The workstation's control is "pnpm", not "host.ts".** Neither shell history holds "host.ts": the owner's PowerShell history has 905 lines, and Git Bash's has 2. The control must be present to prove the files were read.
- **The pair's check log is a fresh `restic check --read-data` of the same repository, run on the workstation.** The host's own `check.log` lives on the pair's tmpfs and is gone when the unit ends. It is the same tool's output over the same bytes.
- **The manifest that is searched is `eligible.json`,** which holds the signed manifest.
- **The browser half's server search was green when written.** It checks behaviour that already existed, as in Run 8.2, and its controls prove that each place was read.
- **The OpenBao snapshot is searched as bytes** and recorded with "proves little", as the plan says.

## Open issues

- No needle was found, so this run gives Run 8.6 nothing to fix.
- Task B, the sweep on the candidate, is in Run 8.7.
- D-65 waits for reviewer 3 (Run 8.5).
