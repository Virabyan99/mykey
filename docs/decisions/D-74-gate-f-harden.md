# D-74 — Gate F: HARDEN

**Date:** 2026-11-22

**Status:** DECIDED by the owner on 2026-11-22 (21:12 UTC). Evidence:

- `docs/evidence/session-9/gate-f.md`, `exit-dossier.md`, `manifest.md`, `gate-review.md`;
- `docs/evidence/session-9/report.md`.

## Context

Doc 10's Run 9.9 (OWN-9) ends Stage 1 with one owner decision: ADVANCE, HARDEN, PIVOT or STOP. The exit dossier, as corrected after the gate review, shows four things:

- production is open on `host-v0.9.1` with one declared consumer;
- **no application runs on MyKey yet**, so Gate F's own condition ("a real non-critical app runs on MyKey", Doc 10 §2) is open;
- the connect panel's token step leaked a token on first use (F-9.2-1);
- the restore changes are proven locally only (D-73).

The agent recommended HARDEN.

## Decision

**HARDEN.** Stage 1 stays open on a short list:

1. connect a real non-critical application to consumer-1;
2. ship the connect panel's token step as one silent command (F-9.2-1), with the owner's journey on production;
3. run the staging restore re-drill (D-73), with a test for generate-root's host path (`hostSysCall`);
4. re-aim the credential drill (AC-1.18, AC-1.40, AC-1.57, PO-18) with a trigger on the host.

Gate F is decided again at W-2 (20 Dec 2026), on 28 days of use. Its ids (FR-1.98 to FR-1.100, AC-1.53, AC-1.54, AC-1.58, AC-1.59) stay NOT YET DUE until then.

## Consequences

- **Stage 2 does not start.** The hardening work needs its own session plan, written by a planning agent (three layers).
- **Production stays open** on `host-v0.9.1`. Every change follows `production.md`: `--stay-closed`, then the owner's journey in the `tunnel verify --browser` window, then `--owner-confirmed`.
- **The maintenance calendar** in `gate-f.md` applies from now. Each row needs the owner to start a session.
- **PR #23 is merged** into `main`, on the owner's word.

## Answer

"HARDEN, and yes merge" (the owner, 22 Nov 2026, 21:12 UTC). The full CI run at `5cbb080` was green. GitGuardian's check was red on two synthetic test fixtures (incidents 40835003 and 40837234); see `owner-requests.md`.
