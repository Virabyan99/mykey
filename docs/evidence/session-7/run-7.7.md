# Run 7.7 — Machine credentials (D08-S36)

**Date:** 19 Nov 2026. **Branch:** `session-7`. **Requirements:** FR-1.39 to FR-1.44, FR-1.91, AC-1.47. **Decisions:** D-60 (P-138), P-139.

## What was done

- **`credentials.summary` has its body and its handler** (`contract: credentials summary`; `packages/db/src/repos/credentials-summary.ts`, `apps/api/src/routes/credentials.ts`). One read-only transaction on one snapshot gives the organization's credentials counted by state and the active ones within seven days of their expiry, soonest first, at most 50, with `expiringTruncated`. States are derived as the inventory derives them: an `active` row past its expiry counts as `expired`. A read past 5 s answers `503 busy` (the statement timeout of `audit.list`; no test of this run makes a read that slow). The answer has no token and no accessor. The pending snapshot of the contract holds one route, `metrics.get`.
- **The credentials screen** (`apps/web/src/screens/credentials.tsx`), for one environment:
  - the inventory: name, scope, state, issue time, issuer, expiry and last use; "not known" where the server has nothing; the seven-day warning as text on the row;
  - Issue, with a name and a lifetime in days (1 to 30, default 30), behind a fresh code. After the step-up the owner presses Issue again; the form keeps what was typed;
  - the token panel: the token of the 201, held by the forgetting holder for 120 seconds with a countdown, Copy and "Hide now", and the sentence that it cannot be shown again. It goes on hide, on a change of address and at sign-out. A token that arrives while the tab is hidden is not kept, and the page says to revoke and issue again;
  - `credential_not_replayable` shown with its explanation from the one error table;
  - Revoke on an active row, behind the typed name;
  - `needs_review` and `revoking` rows say that an operator settles them, and no row offers a button but Revoke on an active one. While an issuance is unresolved the screen offers no new one and names the row that blocks;
  - a fixed text: replace, do not renew; a restore revokes every token.
- **The overview** shows the summary: a table by state with its time, and the expiring credentials with a link to their environment's screen.

## Commits

- `contract: credentials summary`
- `feat: the credentials summary and the credentials screens`

## Commands and results

| Command                                                                                    | Result                                               |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `pnpm exec vitest run --project integration tests/integration/credentials/summary.test.ts` | red first: 3 failed (404, no handler); then 3 passed |
| `pnpm exec vitest run --project browser tests/browser/credentials.test.ts`                 | red first: 7 failed (no screen); then 8 passed       |
| `pnpm exec vitest run --project browser tests/browser/resources.test.ts`                   | 5 passed (the overview's bound is now 5 requests)    |
| `pnpm test`, `pnpm run check`                                                              | 1425 passed; `check` green                           |

CI after Run 7.6's push: green in 2 min 18 s (`check` and `secret-scan`).

## Evidence

FR-1.91 SPIKE_PASS — per credential the screen shows name, bound project and environment, the backend's effective expiry, who issued it and when, its state, the last use only when the server has one ("not known" otherwise) and the one next step its state allows. The seven-day warning is text on the row and on the overview. The token is shown once and never again; a lost delivery is explained, revocation is confirmed by the typed name, and the replacement guidance is fixed text (`tests/browser/credentials.test.ts`, `tests/integration/credentials/summary.test.ts`).

AC-1.47 SPIKE_PASS — active, expiring, expired, issuing, revoked, revoking and review credentials were issued through the product over real OpenBao and shown. Scope, expiry, "not known" last use, the warning and the lost-token guidance were checked; a revocation made in the page was followed by `machine.keys` refusing the token with 401, and no token was shown a second time (`tests/browser/credentials.test.ts`). Local proof; the staging demonstration is the gate's.

## Deviations and decisions

- **The summary leaves out what the inventory never lists.** A row `revoked` with no accessor is an issuance that never made a token; `credentials.list` hides it. The summary does the same, so every number is something the caller can list (P-139). The integration test has such a row.
- **The step-up dialog sits beside the issue form, not inside it.** The dialog is a form; inside another form its submit also submitted the issue, which the first browser run showed (the page issued by itself after the code).
- **Rows for the browser tests are issued through the product.** The inventory joins the issuance operation, so a row written directly is not listed. The tests issue a real credential and then change its state, expiry or last use as the superuser.
- **The replay test loses the first answer.** The page's first request is answered by the harness with the page's own key and body, and the page gets a broken connection. Its second press sends the same key and gets the 409.
- **One unresolved issuance hides "New credential".** The plan asks for no "issue again" on the row; the screen also offers no new issuance while a listed row is `issuing` or `needs_review`, because the server refuses it. The server stays the authority: a blocking row beyond the first 50 leads to the server's refusal.
- **Three more tests than the plan:** the 50-row cut of `expiring`, the remaining states (expired, revoking, issuing), and the overview's summary section.

## Open issues

- The clipboard keeps a copied token after the panel is gone; the page says so at the copy (D-60).
- "Last used" is written at most once a minute, so the screen can be up to a minute behind a use.
