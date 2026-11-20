# Run 7.8 — Operations, activity and the summary (D08-S39)

**Date:** 19 Nov 2026. **Branch:** `session-7`. **Requirements:** FR-1.92, FR-1.94, AC-1.48, AC-1.55. **Decisions:** D-61 (P-139), D-62 (P-142, scope valve 1), P-140.

## What was done

- **`metrics.get` has its body and its handler** (`contract: metrics`; `packages/db/src/repos/metrics.ts`, `apps/api/src/routes/metrics.ts`). One read-only transaction on one snapshot gives, for 1 to 30 UTC days (default 7), the organization's audit events counted by day and outcome, and its operations without an end. A day before the organization's oldest audit row has `counts: null`. The pending snapshot of the contract is empty: every route of the frozen list has a body.
- **The operations screen** (`apps/web/src/screens/operations.tsx`), for one environment: every operation newest first with its action, name, state badge (the server's seven states), who started it ("you" or "another member") and its id. "Details" opens a panel that reads `operations.get`. The list and the panel are asked again by the schedule of P-140 only while the server is still working (`accepted`, `executing`).
  - `uncertain` shows the error table's text for an unknown outcome: do not enter it a second time, an operator settles it from the host (runbook `reconciliation.md`).
  - `awaiting_input` says that the import waits for its file and links to the import screen, where Resume is.
  - No button on the screen sends a change or settles anything: the only buttons are Details, Close, More and "Check again".
- **The activity screen** (`activity.tsx`): `activity.list` as a table with time, action, actor, target by its current name, outcome, the linked operation's state as it is now, and the request id. The events of one operation are on one line ("started, then not known"). Filters by project and by environment; "More" by cursor.
- **The audit screen** (`audit.tsx`): `audit.list` as a plain table. Every filter of the route is a field of the form, and the request holds what the form says. A filter the server refuses is shown as its refusal.
- **The summary on the overview** (`overview.tsx`), three tables with source, window and observation time (D-62): outcomes by day, credentials by state (Run 7.7), operations without an end. A `null` day reads "not measured" in one cell; a 0 is a counted zero. The bar beside a day's sum is a `<meter>` with `aria-hidden`.
- **An unknown outcome stays readable on the credentials screen.** After `503 outcome_unknown` the issue form stays, with its fields disabled and without its submit button, so the explanation and the operation id are not lost when the list shows the blocking row. The panel links to the environment's operations (`ui/OperationsLink.tsx`); the revoke dialog has the same link.
- The placeholder screens of Run 7.1 are gone from `app.tsx`.

## Commits

- `contract: metrics`
- `feat: the metrics route, the timeline and the summary` (this commit)

## Commands and results

| Command                                                                                                    | Result                                                              |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm exec vitest run --project integration tests/integration/metrics/metrics.test.ts`                     | red first: 4 failed (404, no handler); then 4 passed                |
| `pnpm exec vitest run --project browser tests/browser/activity.test.ts`                                    | red first: 7 failed (no screen, no summary, no link); then 7 passed |
| `pnpm exec vitest run --project browser tests/browser/credentials.test.ts tests/browser/resources.test.ts` | 13 passed (the overview's bound is now 6 requests)                  |
| `pnpm test`, `pnpm run check`                                                                              | 1425 passed; `check` green                                          |

CI after Run 7.7's push: green (`check` and `secret-scan`).

## How the three states were made

All three are made by the product, with the fault hooks of the fixtures. Nothing was written into the database to make a state.

| State                     | How                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| a delayed write           | the secret fault hook waits at `after_dispatch_marker` until the test lets it go                  |
| an unknown issuance       | the credential fault hook throws at `after_marker` while the page issues: `503 outcome_unknown`   |
| an interrupted import     | `setImportBudget(0)`: the apply answers 202 and the operation is `awaiting_input`                 |
| an uncertain secret write | the secret fault hook throws at `after_send`: `503 outcome_unknown`, the operation is `uncertain` |

Only the audit rows of earlier days were written directly, as the superuser: an audit row cannot be given an earlier time afterwards, and the summary test needs a first event three days ago.

## Evidence

FR-1.92 SPIKE_PASS — owners and admins read the organization's activity and one environment's operations, paged and scoped, with time, action, actor kind, target, request and operation ids, outcome and the operation's current state. The seven states are shown by the server's word; an uncertain operation is never called failed; the screens show the operator sentence and offer nothing that reconciles (`tests/browser/activity.test.ts`).

FR-1.94 SPIKE_PASS — the overview has a current outcome summary, the credential status and expiry view and the unresolved operations, each with source, window and observation time; "not measured" is a `null` of the server and never a zero; the timeline is the activity screen. A member is refused by the server (`tests/integration/metrics/metrics.test.ts`, `tests/browser/activity.test.ts`).

AC-1.48 SPIKE_PASS — a delayed secret write, an unknown issuance and an interrupted import were forced over real OpenBao; the page showed `executing` then `succeeded` without a reload, `needs review` with `uncertain`, and `awaiting input` with the way to Resume; ids and the operator sentence were shown and no button sent the change again (`tests/browser/activity.test.ts`). Local proof; the staging demonstration is the gate's.

AC-1.55 SPIKE_PASS — the summary was shown from real audit rows: days before the first event "not measured", a later empty day 0, a counted day with its numbers, and the unresolved operations equal to a direct count. Organization B is counted nowhere and a member gets 403 (`tests/integration/metrics/metrics.test.ts`, `tests/browser/activity.test.ts`). Local proof.

## Deviations and decisions

- **The window's last day is today**, counted up to the observation; `window.to` is `observedAt`. The plan says "whole UTC days".
- **`denied` counts rows `audit.list` serves, not rows `activity.list` serves.** The activity timeline does not include the action `access.denied`, so the plan's sentence cannot hold for that column. The caller may list every counted row (D-61).
- **An `intent` row is not counted.** It is the row written before a change is sent, and it is no outcome.
- **`measuredFrom` is the organization's oldest audit row**, and its day is counted.
- **`unresolved`** is `accepted`, `executing`, `awaiting_input`, and `uncertain` without an end time; **`uncertain`** is every operation in that state. Children of an import are not counted.
- **`days=1.5` answers 400**, the pipeline's answer to a value that is no integer; 0, -1 and 31 answer 422.
- **The page follows only `accepted` and `executing`.** An `awaiting_input` or `uncertain` operation does not move by itself, so the page does not ask again for it.
- **A member's overview does not call `metrics.get`**, as it does not call `overview.get` (Run 7.3): the call would be refused and would write a denial row on every visit. The test asks the route directly as a member and gets 403.
- **The audit view's project filter is a list; environment, actor, operation and request are id fields.** An owner copies an id from a row.
- **The issue form stays after an unknown outcome** (above). Before this run the refreshed list replaced the form, and the explanation was on the screen for a moment only.
- **The tests of the audit view are one more than the plan's title:** a refused filter (`422`) is shown as the server's refusal.

## Open issues

- The overview makes 6 API requests for an owner. The bound is in `tests/browser/resources.test.ts`.
- The activity screen groups only the events it has loaded: an operation whose events fall on two pages shows its newer events only, until "More" has loaded the rest.
- The summary reads the database's audit rows, not the archive. After a purge, older days read "not measured".
- The audit view shows `details` as the server's keys and values, without labels.
