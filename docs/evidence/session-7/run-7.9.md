# Run 7.9 — Errors, keyboard, narrow screen, browser security (D08-S37)

**Date:** 19 Nov 2026. **Branch:** `session-7`. **Requirements:** FR-1.76, FR-1.89, FR-1.93, FR-1.96, AC-1.29, AC-1.34, AC-1.51, PO-12. **Decisions:** D-59 (P-134, P-141), D-60, P-136, P-140.

Most of this run is proof of what Runs 7.1 to 7.8 built. It found three defects, which are repaired, and no failure that is shown as a code alone.

## What was found and repaired

- **A confirmation dialog did not give the focus back.** After Cancel or Escape the keyboard was on nothing, and the next Tab started at the top of the page. The dialog was closed after React had already removed it from the document, and a dialog removed while open gives the focus to nobody. It is now closed in a layout effect, while it is still in the document (`apps/web/src/ui/Dialog.tsx`). The step-up dialog was not affected: it stays in the document.
- **The credentials screen moved sideways at 360 pixels** (the page was 572 wide). The hidden header of the actions column is positioned, and nothing in the table's frame held it, so it widened the page. The frame is now its container (`.scroll { position: relative }`). The operations screen has the same header and gets the same repair.
- **The activity screen hid a failed read.** When the environments of the chosen project could not be read, the filter showed an empty list. It now says so and shows the failure with Reload.

## What was proven

- **A GET changes nothing** (`tests/integration/browser-security/origin.test.ts`, real stores). Every GET of the route table that a browser session can send (17 of 18; the other is the machine route) is asked three ways: from this origin, as another site would ask it, and without an Origin. Every table of the schemas `app`, `audit`, `auth`, `jobs` and `meta` is compared before and after by count and digest, except `app.rate_limit`. A refused GET adds its one denial to the audit log and nothing else. A control shows that the comparison sees one new secret.
- **The Origin check covers every route that changes something.** Run 3.7's file already refuses a foreign, a null, a missing and a cross-site Origin on each of them. Its list is now stated without naming the kinds of route, so a new kind cannot stay outside (`tests/integration/authz/origin.test.ts`).
- **Every asset carries the shell's headers**, not only the index (`tests/integration/web/shell.test.ts`).
- **In a browser** (`tests/browser/access.test.ts`, 16 tests, real OpenBao):
  - keyboard only: sign in, create a secret, reveal it, issue a token (which `machine.keys` accepts), revoke it (which `machine.keys` then refuses). Every control was reached by Tab and showed the 3-pixel focus ring. E-mail to password is one Tab. Twelve Tabs never left the dialog; Escape gave the focus back to the button that opened it;
  - at 360 by 740 the overview, the secrets list, a secret, the credentials and the activity screens do not move sideways, and every table is inside a frame that fits;
  - a page of another origin that embeds the workspace gets nothing: the browser refuses the answer (`ERR_BLOCKED_BY_RESPONSE`), the frame holds its own error page, and no request to the API was made;
  - an inline script, a script of another origin and an inline style, put into the page, are each refused by the browser and reported, and the other origin is never asked;
  - with colours switched off every state badge on the overview is a word;
  - every field, button and link of ten screens has a name, and a field's error is announced and tied to the field;
  - each of the nine failure classes shows its own words, the id to quote, never the code and never the server's text.
- **One table, one presentation.** No two codes share a title or a text, and no explanation holds a code (`tests/unit/web/explain.test.ts`). A search of the screens found no place that prints the code or the message of an error, and no query whose failure is not shown (the activity filter was the one). One server word is shown as it is: the review reason of a resource under review, beside the operator sentence (Run 7.3).

## The nine failure classes

| Class              | Code                          | How it was made                                                            | What the page shows                                              |
| ------------------ | ----------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| hidden or absent   | `not_found`                   | the server's 404: a secret taken out of the index after the page listed it | "Not found": absent or not visible, the same answer for both     |
| a state conflict   | `state_conflict`              | the harness answers the page's request with the contract's envelope        | "Not possible in the current state"                              |
| an expired session | `unauthenticated`             | the server's 401: the session's row is deleted                             | the sign-in screen: "Your session ended. Sign in again."         |
| fresh verification | `fresh_verification_required` | the server's 403: the session's code is 20 minutes old                     | the dialog "Confirm with your authenticator"; the form is kept   |
| a version conflict | `version_conflict`            | the server's 409: the secret is updated while the form is open             | "The secret changed since you opened it": Reload or Cancel only  |
| review             | `key_under_review`            | the server's 409: the key is put under review, then Reveal                 | "This secret is under review", the operator sentence, no button  |
| backend sealed     | `backend_sealed`              | the harness's answer                                                       | "The secret store is sealed", runbook `kms-and-unseal.md`        |
| audit unavailable  | `audit_unavailable`           | the harness's answer                                                       | "The action could not be recorded": the action was not performed |
| capacity           | `capacity_exceeded`           | the harness's answer                                                       | "No room for this"                                               |

Four classes are answered by the harness, not by the server. Sealing OpenBao, breaking the audit log or filling the host on the shared test stack would break the files that run beside this one. That the server answers these codes is proven by the integration suites of earlier sessions; here the page is the subject.

## Commits

- `feat(web): errors, keyboard, narrow layout and the origin proof` (this commit)

## Commands and results

| Command                                                                                                                 | Result                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm exec vitest run --project integration tests/integration/browser-security/origin.test.ts`                          | 4 passed at once: a proof of what exists, with a control that fails the comparison      |
| `pnpm exec vitest run --project integration tests/integration/authz/origin.test.ts tests/integration/web/shell.test.ts` | 24 passed                                                                               |
| `pnpm exec vitest run --project browser tests/browser/access.test.ts`                                                   | red first: the focus return, the 572-pixel page, the hidden failed read; then 16 passed |
| `pnpm exec vitest run --project browser` for `resources`, `history`, `credentials`, `import-export`, `activity`         | 34 passed (the dialog and the table frame are used by all of them)                      |
| `pnpm test`, `pnpm run check`                                                                                           | 1426 passed; `check` green                                                              |

CI after Run 7.8's push: green in 2 min 35 s (`check` and `secret-scan`).

## Evidence

FR-1.76 SPIKE_PASS — every cookie-authenticated change needs this origin (foreign, null, missing and cross-site are refused on every route and every auth path that is not a GET); no GET changes a row; the page and every asset carry the content policy, no framing and no referrer; the workspace asks no other origin (`tests/integration/authz/origin.test.ts`, `tests/integration/browser-security/origin.test.ts`, `tests/integration/web/shell.test.ts`, `tests/browser/access.test.ts`).

FR-1.89 SPIKE_PASS — after a complete sign-in the owner reaches every screen from the navigation: overview, activity, audit, secrets, import and export, machine credentials, operations, account and help; each shows the states the server reports in the server's words; no placeholder screen is left (`tests/browser/access.test.ts` and the browser files of Runs 7.2 to 7.8).

FR-1.93 SPIKE_PASS — one table maps every code of the contract to what happened, the safe next step and the ids; the nine classes each show their own words in a real screen, never the code and never the server's text; an unknown outcome never invites a second send (`tests/unit/web/explain.test.ts`, `tests/browser/access.test.ts`, `tests/browser/activity.test.ts`).

FR-1.96 SPIKE_PASS — labels on every control, errors tied to their fields, Tab in reading order, a visible focus ring, dialogs that hold and return the focus, confirmation by typed name for destructive effects, words beside every colour, and a 360-pixel screen that does not move sideways (`tests/browser/access.test.ts`). No conformance to a standard is claimed.

AC-1.29 SPIKE_PASS — the page's part: product errors are read by the envelope's schema, anything else (a cut connection, a proxy's page) is "No usable answer came back" and never a claim that the change failed or succeeded; hidden and absent read the same (`tests/browser/access.test.ts`, `tests/browser/shell.test.ts`, `tests/unit/web/explain.test.ts`). The CLI's and the API's parts are Sessions 3 and 5's.

AC-1.34 SPIKE_PASS — cross-site changes are refused on product and auth routes; an inline script, a third-party script and an inline style are refused by the browser and no screen of the workspace causes a violation; framing is refused by the browser; the referrer policy is `no-referrer` (`tests/integration/authz/origin.test.ts`, `tests/browser/access.test.ts`, `tests/browser/shell.test.ts`).

AC-1.51 SPIKE_PASS — the main flow was done with the keyboard only, and the narrow layout, labels, focus placement and return and textual equivalents were inspected in Chromium; three defects were found and repaired. Contrast was not measured (`tests/browser/access.test.ts`).

PO-12 SPIKE_PASS — the browser's content policy on the workspace: the headers are on the page and on every asset, Chromium enforces them (a framed page is refused; no violation is reported by any screen), and the bundle loads only its own script and stylesheet (`tests/integration/web/shell.test.ts`, `tests/browser/access.test.ts`, `tests/browser/shell.test.ts`). Local proof; the staging check is the gate's.

## Deviations and decisions

- **The Origin proofs stay in Run 3.7's file.** The plan allows extending it. The new file `tests/integration/browser-security/origin.test.ts` holds what was missing: the GET proof.
- **"No GET changes a row" allows the audit log's denial.** A refused GET writes one `access.denied` row, by design. `app.rate_limit` is not compared: every request is counted there.
- **Wide tables move inside their own frame; rows are not stacked.** The plan says "tables fall to stacked rows". Stacking needs a label on every cell of twelve tables and takes the table's meaning away from a screen reader in some browsers. The page does not move sideways, which is what the test asks. `known-limits.md` has the line.
- **Four failure classes are answered by the harness** (above).
- **The embedding page of the framing test is a real page on this machine.** A page the test makes up at a public name is stopped earlier by Chromium, for reaching into a local network, and would prove nothing about the headers.
- **`font-src 'self'` stays in the policy.** P-141 allowed tightening it. No font is shipped, so it allows nothing today; changing the header buys nothing.
- **Four tests beyond the plan:** names on every control with a field's error tied to it, the failed read on the activity screen, the policy refusing injected scripts and styles, and the unit test that no two codes share their words.
- **The CLI and the page.** The CLI prints one line: category, text, code, request id. It has no next step and no operation id. The CLI is not changed in this session; `known-limits.md` has the line.

## Open issues

- Contrast and a screen reader's speech were not tested. Roles and names were.
- The keyboard and narrow-screen proofs are Chromium's. No other browser was used.
- A scrollable table frame is reached by the keyboard only in browsers that make scrolling frames focusable (Chromium does).
