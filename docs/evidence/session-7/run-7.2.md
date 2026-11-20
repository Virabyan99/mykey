# Run 7.2 — Sign-in and security screens (D08-S33)

**Date:** 19 Nov 2026. **Branch:** `session-7`. **Decisions:** none new (P-137; the holder of P-138 is written here, its record D-60 comes with Run 7.4).

## What was done

- **The auth client** (`apps/web/src/api/auth.ts`): one function per path of `docs/auth-route-contract.md`, none through the query cache.
- **The forgetting holder** (`state/ephemeral.ts`, `state/use-ephemeral.ts`): a value goes when its time is over, when the tab is hidden, on a change of address, on sign-out and when asked.
- **Sign-in:** the password, then the code or a recovery code. A refused sign-in has one text for every cause, with the note that a restore needs an operator's reset. The password is read from its field at submit and the field is emptied; it is never in the page's state.
- **Enrolment:** the key in groups of four beside the `otpauth://` address, activation, the ten recovery codes with "I saved them".
- **Reset:** the fragment is taken out of the address and the history entry before anything is rendered; the token lives in the holder. Kind `mfa` goes on to enrolment.
- **Account:** the session list with "End session" and "End every session"; the password change; new recovery codes. A 403 `fresh_verification_required` opens the step-up dialog; the owner then sends the change again with the same button.
- **Sign-out and an ended session:** every held secret and every cached row is dropped, and the sign-in screen says why it is there.

## Commits

- `feat(web): sign-in, enrolment, reset and the account screens` (this commit)

## Commands and results

| Command                                                                | Result                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------- |
| `pnpm exec vitest run --project unit tests/unit/web/ephemeral.test.ts` | 9 passed (red first: 9 failed)                    |
| `pnpm exec vitest run --project browser tests/browser/auth.test.ts`    | 8 passed (red first: 8 failed, no screen existed) |
| `pnpm exec vitest run --project browser tests/browser/shell.test.ts`   | 5 passed (rerun: the app changed under it)        |
| `pnpm test`                                                            | 115 files, 1422 tests passed                      |
| `pnpm run check`                                                       | green                                             |

CI on the draft pull request after Run 7.1: red once (`tests/unit/runbooks/links.test.ts`: a runbook named `apps/web/dist`, which exists only after a local build), fixed in `e1bc66c`, then green in 2 min 10 s with `check` and `secret-scan` only.

## Deviations and decisions

- **The page cannot tell an account without an authenticator.** The session answer has no account state. The second step offers "Set up an authenticator", and a 409 `state_conflict` from the code check leads to enrolment. Nothing is probed with a request that changes something.
- **The key, the recovery codes and the reset token stay while the tab is hidden** (`clearOnHide: false`, ten or fifteen minutes). The owner has to leave the tab to use them; forgetting them there would make enrolment impossible with a desktop authenticator and would lose recovery codes that are shown once. They still go on a change of address, on sign-out and when confirmed.
- **"The API calls behind them answered `mfa_incomplete`":** the page asks for nothing of the workspace with a password-only session. The test proves that, and makes the refused call itself with the same cookie.
- **After a reset of kind `mfa`, a reload loses the hand-over to enrolment.** The server shows no session for a reset's own session, so the page cannot find it again. A new link is needed.
- **"Signed out" is said only when the server answered.** A sign-out that did not arrive is shown as an error, and the session stays.

## Open issues

- Not in the browser test (the plan's eight are): a recovery code at the second step, a reset of kind `password`, new recovery codes, "End every session". All are implemented.
- `workspace.md` (Run 7.9) gets the lines about the reload after a reset and about the missing QR code.
