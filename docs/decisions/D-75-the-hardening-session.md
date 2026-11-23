# D-75 — Session 10 is the hardening session of D-74

**Date:** 2026-11-23

**Status:** DECIDED (P-170, `docs/plans/session-10-plan.md`).

## Context

Doc 10 plans nine sessions and ends Stage 1 with Gate F. Gate F was decided HARDEN on 22 Nov 2026 (D-74), and D-74 says the hardening work needs its own session plan. Without a record, a later reader takes "Session 10" for a session of Doc 10.

## Decision

1. **Session 10 is not one of Doc 10's nine.** It carries out D-74's list, except its first item (a real application on consumer-1), which the owner does after the session with the documents it writes.
2. **Its scope is four items:**
   - the connect panel's token step as one silent command (F-9.2-1), with a release and the owner's journey on production;
   - the staging restore re-drill (D-73), with a test for generate-root's host path;
   - the credential drill re-aimed with a trigger on the host;
   - documentation for AI coding agents, with a proof.
3. **Doc 10 §4 and D-69's classes of change stay in force.** Without a new authorization `apps/web`, host files, scripts, tests, test tools and documents may change. Anything else under `apps/`, `packages/` or `infra/compose`, any route, contract body, migration or pin of a product image goes to the owner first.
4. **Gate F is not decided in this session.** It is decided again at W-2 (20 Dec 2026), as D-74 says.

## Consequences

- The session's evidence is `docs/evidence/session-10/`, and its manifest is built with `--session 10`.
- Stage 2 does not start.
