# Run 9.6 — Field metrics and watch items

**Date:** 22 Nov 2026 (Task A). **Branch:** `session-9`. **Requirement:** FR-1.100. **Plan item:** P-166. **Decision:** D-72.

Task B (the first report, after Run 9.2) and Task C (W-1 and W-2, dated) complete this note.

## What was done (Task A, the tools)

- **The day record** (`infra/hosts/field/day.ts`) holds counts and timings only, from the host's own facts:
  - machine reads per credential label, and machine refusals per HTTP status;
  - sign-ins, completed and failed; the owner's changes;
  - P50 and P95 of `durationMs` per route class with the sample count ("too few" under 20);
  - down minutes, the gate, the backup pair's age and the volume headroom;
  - the day's class, by P-166's rules.
- **Down minutes** are read from the host's side: minutes of the day with no `GET /health` answered 200. The probe asks every minute, and the API logs every request, so an API that logs nothing at all is an outage, not a quiet day.
- **Labels, not ids:** a credential is `credential-A`, `credential-B`, and so on. The mapping (`labels.json`) stays on the host. The glob `field-pull` reads never matches it.
- **The collector** (`infra/hosts/field/collect.ts`) parses what `field-day.sh` gathered, and writes the record and the labels atomically.
- **On the host:** `field-day.sh` and `mykey-field-day.timer` (00:10 UTC, `Persistent=true`).
  - The script gathers the API's journal of the day, the day's audit rows (read only, through the PostgreSQL container's socket, as `status.sh` reads), the newest eligible pair and the capacity record.
  - It runs the collector with the API image's node, with no network, a read-only root and no capabilities.
  - The timer is in `jobTimers()`, so `host.ts <host> timers` installs it.
- **On the workstation:**
  - `host.ts <host> field-pull` checks every record against its exact shape and copies it to `~/.mykey/field/<host>/`.
  - `scripts/field-report.ts <host> --week <n>` writes `docs/evidence/field/week-<n>.md`: the daily table, the week's figures, "a partial week" when it is one, and the "not measured" lines.
- **The runbook:** `docs/runbooks/field-use.md`.
- **Not yet on a host.** The `push` and `timers` to production come in Run 9.0 Task I Step 5, with the owner's yes.

## Commands and results

| Command                                                                                                                       | Result                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `vitest --project unit tests/unit/hosts/field-day.test.ts`                                                                    | RED (no module); GREEN. Then GREEN 6/6 with down minutes from `/health` and the collector's helpers |
| `vitest --project unit tests/unit/field`                                                                                      | RED (no module); GREEN 4/4 with `field-pull`                                                        |
| `vitest --project unit tests/unit/hosts/units.test.ts`                                                                        | RED 1/11 (no field timer); GREEN 11/11                                                              |
| `vitest --project unit tests/unit/runbooks tests/unit/hosts tests/unit/field tests/unit/agent tests/unit/pins tests/unit/ops` | GREEN after one fix: `field-use.md` named `clock.json` by a path that does not exist yet            |
| `pnpm run check`                                                                                                              | GREEN                                                                                               |

## Rulings

They are in the ledger, and these reach the report:

- labels with the mapping on the host;
- down minutes from the `/health` answers;
- the audit read through the PostgreSQL socket, not as `maintenance` (an `apps/ops` command is closed by D-69);
- the gate "closed" for a day when the API refused a request at its gate that day;
- the timer on both hosts;
- week 1 from `clock.json`.

## Task B — The first report (22 Nov 2026, after Run 9.2)

- `host.ts prod field-pull`: 0 records. The timer was installed on production at 13:4x UTC with Run 9.0's deploy, and each record covers the day before, so the first one (22 Nov, the clock's first day) is written on 23 Nov at 00:10 UTC.
- `docs/evidence/field/clock.json`: `{ "start": "2026-11-22" }`, the date of consumer-1's first successful read (`run-9.2.md`).
- `node scripts/field-report.ts prod --week 1` wrote `docs/evidence/field/week-1.md`: "a partial week: 0 of 7 days have a record". The report says so rather than leaving the week out.

## Task C — W-1 and W-2, dated

- **W-1:** the real 30-day ageing of production's backup retention (Doc 10 D-04). It is due **23 to 26 Dec 2026**, 32 to 35 days after production's first eligible pair (21 Nov 2026, 08:00 UTC). The check is Doc 10 §11's. The operator runs it, and the owner reads the result.
- **W-2:** the 28-day real-use observation (D-05, FR-1.100, AC-1.58). It is due **20 Dec 2026**, 28 days after the clock start of 22 Nov. It holds the four weekly reports, the daily table, incidents, backup ages, the drill's time, costs and the owner's friction notes, all added to the dossier. The operator pulls and builds the reports, and the owner adds costs and friction notes.
- Both are in CLAUDE.md's "Dated" list and in the dossier's calendar (Run 9.8). The registry's statuses for the ids they cover are set by Run 9.8's manifest. That is where D-05's `WATCH` is applied, so no status here is typed by hand.
