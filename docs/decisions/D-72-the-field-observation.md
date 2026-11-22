# D-72 — The field observation: day records from the host, weekly reports, W-1 and W-2

**Date:** 2026-11-22

**Status:** DECIDED (P-166; built in Run 9.6). Evidence: `tests/unit/hosts/field-day.test.ts`, `tests/unit/field/report.test.ts`, `docs/evidence/session-9/run-9.6.md`, `docs/evidence/field/week-1.md`.

## Context

FR-1.100 and AC-1.58 ask for 28 days of real use. Doc 10's D-05 lets Gate F come on day 14 and keeps the 28 days as watch item W-2. The repository is public, so the observation cannot hold names, ids or values of production's data.

## Decision

1. **One record per day, written by the host.** `mykey-field-day.timer` (00:10 UTC, `Persistent=true`) runs `field-day.sh`. The collector is run with the API image's node, with no network and a read-only root, and it writes `/var/lib/mykey/field/<date>.json`. A record holds:
   - counts and timings, from the API's journal and the audit;
   - credentials as labels (`credential-A`, …), whose mapping stays on the host;
   - down minutes, meaning minutes with no `GET /health` answered 200, so an API that logs nothing counts as an outage.
2. **The day's class:**
   - `use`: a successful machine read, or a change by the owner;
   - `blocked`: refusals and no success;
   - `outage`: more than 30 down minutes, or the gate closed;
   - `no activity`.
3. **Weekly:** `host.ts prod field-pull`, then `field-report.ts prod --week <n>`. Week 1 starts at the clock start in `docs/evidence/field/clock.json` (22 Nov 2026, the first read by consumer-1). A partial week says so.
4. **Not measured, and said so:** CLI errors on the consumer's side; costs, which are the owner's invoice lines; operator minutes, which come from the run notes.
5. **W-1:** the real 30-day ageing of production's backup retention, due 23 to 26 Dec 2026. **W-2:** the 28-day report, due 20 Dec 2026. Both are in CLAUDE.md's "Dated" list and in the dossier's calendar. The registry's statuses for the ids they cover come from Run 9.8's manifest.

## Consequences

- The observation needs no workstation awake. A missed day is written when the timer next runs.
- A day with no read by consumer-1 counts as `no activity`. The owner was told that the consumer should start at least once a day (P-168).
