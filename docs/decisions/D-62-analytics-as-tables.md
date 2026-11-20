# D-62 — The analytics are tables (scope valve 1)

**Date:** 2026-11-19

**Status:** DECIDED. The owner approved scope valve 1 of Doc 10 §8.2 on 19 Nov 2026 at the start of Session 7 ("yes to tables"). Built in Run 7.8 (P-142; FR-1.94; AC-1.55). Evidence:

- `docs/evidence/session-7/owner-requests.md` (the question) and `docs/evidence/session-7/run-7.8.md`;
- `tests/browser/activity.test.ts`, `tests/browser/resources.test.ts`, `tests/browser/credentials.test.ts`.

## Context

Doc 10 §8.2 lists what may be given up when the stage is behind its map; the first item is the charts ("FR-1.94 keeps its minimum"). At the start of Session 7 the stage was two days behind, which is the valve's condition. FR-1.94 itself accepts "timelines/tables/appropriate graphics" and says that a decorative or misleading chart never satisfies it.

## Decision

The summary on the overview is three tables. Each one names its source, its window and the time it was observed.

| Table                     | Source                    | What it shows                                                                |
| ------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| Outcomes by day           | `metrics.get` (audit log) | per UTC day: succeeded, failed, not known, denied and their sum              |
| Credentials by state      | `credentials.summary`     | a count per state, and the list of the credentials that expire within 7 days |
| Operations without an end | `metrics.get`             | operations not ended, and operations whose outcome is not known              |

Rules of the first table:

- A day the audit log does not cover reads "not measured", in one cell across the row. It never reads 0.
- A 0 is a day that was counted and had no such event.
- Each counted row has a bar beside its sum. The bar is a native `<meter>` with `aria-hidden`, because the content policy allows no inline style. It is decoration: the number is the text of the cell.

There is no chart library and no SVG chart. The timeline (the activity screen) and the operations screen are tables as well.

## Consequences

- FR-1.94 keeps its minimum: one current outcome summary, a time-ordered timeline, and the credential expiry and status view, all with source, scope and time.
- No dependency was added for drawing.
- A trend is read from seven numbers, not seen at a glance. If real use in Session 9 shows that the owner wants a picture, an inline SVG bar chart beside the same table is the planned next step (P-142), still without a library.
- A screen reader gets the whole summary: nothing is said only by a shape or a colour.
