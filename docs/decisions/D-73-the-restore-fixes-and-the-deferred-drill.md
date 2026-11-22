# D-73 — The restore fixes proven locally; the staging re-drill deferred

**Date:** 2026-11-22

**Status:** DECIDED by the owner (Run 9.7 Task B deferred). Evidence: `docs/evidence/session-9/run-9.7.md`, `tests/fault/restore/interrupted.test.ts`, `tests/integration/restore/*`, `tests/unit/hosts/restore-custody.test.ts`, `docs/evidence/session-9/review-release.md` (RR-1, RR-3).

## Context

P-167 planned a staging restore drill onto staging's own reinstalled server. It would prove R4-10's case ("a host onto its own reinstalled server") and the restore Mediums R4-2, R4-3, R4-4, R4-7 and R4-10, fixed in Run 9.7 Task A. On 22 Nov 2026 the owner asked for Session 9 to finish that day (12 to 14 hours). The drill needs a reinstall by the owner and about two hours of host time.

## Decision

1. **Task A stands**, proven by the fault and integration tests, which were run locally:
   - a dated root token after the restore;
   - a rerun after the OpenBao step;
   - no leftover state;
   - a host onto itself.
     The release review found **RR-1** (High): `--open` revoked the only root token before writing custody. It was reproduced in `tests/fault/restore/interrupted.test.ts` and fixed before the release.
2. **Task B, the staging re-drill, is deferred** by the owner's decision. It is a dated watch item: **before 31 Dec 2026**, and in any case before production's first restore. It follows `restore.md` on staging's own reinstalled server.
3. The dossier says plainly that **the restore fixes are proven locally only**. Run 6.8's production-procedure drill was done on the code before these fixes.

## Consequences

- H-04 (recovery) keeps Run 6.8's observation and adds the local proofs. It gets no new drill time in Session 9.
- A restore of production before the re-drill would run code whose whole path has not run on a real host since the fixes. `restore.md` says to do the re-drill first, unless the restore is an emergency.
