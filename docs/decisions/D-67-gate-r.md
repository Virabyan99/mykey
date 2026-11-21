# D-67 — Gate R: controlled use of Stage 1's release

**Date:** 2026-11-21

**Status:** ASKED. The owner reads `docs/evidence/session-8/gate-r.md` and answers "approved", or not. The answer is written here and in `owner-requests.md`, with its date. Evidence:

- `docs/evidence/session-8/gate-r.md`, `manifest.md`, `candidate.json`;
- `docs/evidence/session-8/report.md`.

## Context

Doc 10's Run 8.9 (OWN-7) ends Session 8 with one owner decision: whether real, non-critical secrets may go to production for one first consumer. Plan P-156 puts everything the owner signs into one document, above a signature line. Nothing the owner must know is below that line.

## Decision

- **What is asked.** Controlled use of `host-v0.8.1` with `cli-v0.1.2`: real, non-critical secrets, on production, for one declared first consumer, from Run 9.1.
- **What it is signed with.**
  - 144 items PASS, 9 of them `earlier`;
  - 9 items NOT PROVEN, among them the staging drill of an unknown issuance (AC-1.18, AC-1.40, AC-1.57, PO-18), whose fault is proven on CI only;
  - 7 items not yet due (Gate F);
  - the accepted findings (D-65, D-66) and nine open Mediums of the reviews;
  - 53 image-scan exceptions until 14 Dec 2026.
- **How it is signed.** The owner writes "approved", or signs by a commit of their own.
- **Without "approved":**
  - nothing of Session 9 starts;
  - production stays closed (rule 10);
  - the report says plainly that the gate is not signed, and why.

## Consequences

- **With "approved":** Run 9.1 opens production by `production.md`. The owner's terminal and the owner's journey are the only way in: `deploy --owner-confirmed` (D-64).
- **Session 9 carries:**
  - the drill's re-aim;
  - the four restore Mediums (P-150);
  - the owner's UI and UX request;
  - the dated items of Gate R's section 10.

## Answer

_(to be recorded: the owner's words and the date)_
