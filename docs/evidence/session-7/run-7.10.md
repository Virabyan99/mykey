# Run 7.10 — The journey, the canary scan and the session gate

**Date:** 19 Nov 2026. **Branch:** `session-7`. **Requirements:** FR-1.22, FR-1.23, FR-1.76, FR-1.89 (Doc 10 §4.5 and §4.1 rules 2 and 6). The gate's own account is `report.md`; this note holds what the run itself did.

## Task A — the two last files

- **`tests/browser/journey.test.ts`** (with `tests/harness/journey.ts`). One owner and one page, from the sign-in form to the sign-out:
  - a project and an environment, made by the real provisioning job;
  - three secrets, one edited and revealed, one deleted and undeleted;
  - an import of two entries, an export;
  - a token issued, used and revoked; the activity; the sign-out.

  After the first address the page is never loaded again: every move is a link or a button. Every step asserts what the server then says:
  - the list as another admin reads it;
  - the audit log's rows of this owner;
  - the values the machine token resolves, by digest (the edited value, and no older one);
  - the 401 after the revoke;
  - the session's row and its cookie after the sign-out.

- **`tests/browser/canary.test.ts`.** The same journey after an operator's reset link, so that every kind of secret of the product is in it. A canary is assembled at run time for:
  - the reset token, the new password, the setup key (as shown and without spaces), the ten recovery codes;
  - every authenticator code typed, the six secret values, the machine token.

  Then, signed in and again after the sign-out, in the page as it stands and in every earlier entry of the history, none of them is in: `localStorage`, `sessionStorage`, IndexedDB (names and contents), Cache Storage, `document.cookie`, the context's cookies, `history.state`, the address, the document with its field values, the console, any address requested, any address shown.

  **Control:** a canary the test itself puts into each of those twelve places is found by the same search in all twelve. A finding names what was found and where, never the value.

## What it found

- **Nothing in any storage, address, history entry, document or console line.**
- **One defect of the page, repaired:** after a reset ends with a new authenticator the service ends every session (P-51), and the sign-in form came back without a reason. It now says "The new authenticator is active. Sign in with your new password and a code from it." The test was red first.
- **One wrong expectation of mine:** I had the canary journey continue into the workspace after enrolment. The server's rule is a new sign-in; the test follows it.

## Task B — the gate

The account is `report.md`. In short:

- **CI:** the first full run found four stale or racy test files; the second was green.
- **The review:** nothing Critical, two Important findings fixed with failing tests first.
- **Staging:** `host-v0.7.0` deployed; every staging file and the consumer rehearsal ran.
- **A defect of Session 6:** after `boundary`'s reboot OpenBao stayed down, because the audit rotation signalled it with `docker kill`. Fixed in `bao-audit-rotate.sh` with two failing tests first, sent to staging with `push`, and proven by the reboot.
- **Five stale staging tests** repaired as tests.

## Commits

- `test(web): the owner journey and the canary scan` (`35dc700`)
- `fix(web): a request the server has not finished is never shown as done` (`e121aab`; the gate's fixes, with the notice above)
- `test: four files that the first full run of Session 7 found stale` (`236083a`)
- `fix(host): the audit rotation no longer stops Docker from restarting OpenBao` (the script, its two tests, the runbook line)
- `test(staging): the workspace on staging, and the tests the gate found stale`
- `docs: the Session 7 gate` (the report, this note, `CLAUDE.md`, the runbooks)

## Commands and results

| Command                                                                     | Result                                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run --project browser tests/browser/journey.test.ts`      | 1 passed at once: a proof of what Runs 7.1 to 7.9 built                                        |
| `pnpm exec vitest run --project browser tests/browser/canary.test.ts`       | the search found nothing; the control found all twelve places; red, then green, for the notice |
| `pnpm run check`                                                            | green                                                                                          |
| CI on the ready pull request                                                | first run: four stale or racy test files; second run green (`report.md`)                       |
| `vitest --project integration tests/integration/archive/rotation.test.ts`   | red (no restart after the old script's signal), then 3 of 3                                    |
| `pnpm run test:staging <file>`, eleven files, and `pnpm run test:consumers` | all green at the end (`report.md`, Step 4)                                                     |

## Evidence

FR-1.22 SPIKE_PASS — after a whole journey with a canary as every secret, no storage, cookie, address, history entry, document or console line of the browser holds one, signed in or signed out (`tests/browser/canary.test.ts`; the holder's own rules are Run 7.4's).

FR-1.89 SPIKE_PASS — one owner does every task of the workspace in one page, and the server confirms each step (`tests/browser/journey.test.ts`); on staging, the same journey through the page under `host-v0.7.0` (`tests/staging/workspace.staging.test.ts`, `run-7.10-staging.json`).

## Deviations and decisions

- **The canary journey starts from an operator's reset of the owner.** That makes the reset token, the new password, the setup key and the recovery codes real secrets of the run. The plan's list names them; it does not say how they come to be.
- **An authenticator code counts as found only as a whole word.** Six digits inside an id are not a code. A code glued to letters would be missed.
- **Both files passed without a change to the product**, except for the notice. They are proofs of what exists; the canary's control is what shows the search can fail.
- **The search cannot see what the page holds in memory or in its query cache** (the reviewer's finding 12). The proof for those is the holder's unit tests and the source rules of Run 7.4.

- **The rotation fix reached staging by `push`, not as `host-v0.7.1`.** It is a host file, and a release holds only images.
- **The new browser test for a 202 was first run after the fix** (the unit tests for the same fix were watched failing). It is coverage, not a watched red.

## Open issues

- Production's host files hold the old rotation script: `host.ts prod push` before OpenBao is started there.

- The reviewer's thirteen Minor findings and two open questions go to Session 8 (`report.md`).
