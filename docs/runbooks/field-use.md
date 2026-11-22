# Field use runbook

How production's real use is observed during Session 9 and after it (FR-1.100, P-166, D-72): one record per day from the host's own facts, and one report per week. The records hold counts and timings only, so a week's report can live in this public repository.

## What is collected

`mykey-field-day.timer` runs `infra/hosts/field/field-day.sh` at 00:10 UTC for the day before. It reads:

- the API container's journal lines of the day (its request log);
- the day's audit rows: action, actor kind and id, outcome. They are read only, through the PostgreSQL container's socket, as `status.sh` reads;
- the newest eligible backup pair's capture time;
- the capacity record `/etc/mykey/gate/capacity.json`.

`infra/hosts/field/collect.ts` then runs with the API image's node, with no network and a read-only root, and writes `/var/lib/mykey/field/<date>.json`. The record (`infra/hosts/field/day.ts`) holds:

| key                       | what it is                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `machineReads`            | successful machine reads (`machine.keys`, `machine.resolve`) per credential **label**, and machine refusals per HTTP status                                      |
| `signIns`                 | completed sign-ins (`auth.mfa_complete`) and failed ones                                                                                                         |
| `ownerChanges`            | the owner's successful changes to secrets, projects, environments and credentials (reveals and exports are not changes)                                          |
| `timings`                 | P50 and P95 of `durationMs` per route class (`machine`, `auth`, `read`, `write`) with the sample count; under 20 samples, "too few"                              |
| `healthDownMinutes`       | minutes of the day without a `GET /health` answered 200. The probe asks every minute, so this is the outage as the host saw it                                   |
| `gateClosed`              | whether the API refused a request at its gate that day                                                                                                           |
| `backupPairAgeHours`      | the newest eligible pair's age at the day's end                                                                                                                  |
| `capacityHeadroomPercent` | the smallest free share of any measured volume                                                                                                                   |
| `classification`          | `outage` (gate closed, or over 30 minutes down), else `use` (a successful machine read or an owner's change), else `blocked` (refusals only), else `no activity` |

**What is never in it:** a secret name or value, a project, environment, credential or user id, an address, a request id. A credential appears as `credential-A`, `credential-B`, and so on. The mapping is `/var/lib/mykey/field/labels.json`, which stays on the host and is never pulled.

## A day by hand

A day the timer missed (the timer catches up only its last run) is recomputed on the host:

```sh
sudo /opt/mykey/hosts/field/field-day.sh 2026-11-24
```

The API's journal goes back as far as journald keeps it.

## A week's report

Week 1 starts on the clock start of Run 9.2, kept in the field evidence folder as `clock.json`, `{ "start": "YYYY-MM-DD" }`.

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts prod field-pull
node scripts/field-report.ts prod --week 1
```

`field-pull` copies the day records to `~/.mykey/field/prod/`, outside the repository. It checks each one against the record's exact shape and refuses a key it does not know. `field-report.ts` writes `docs/evidence/field/week-<n>.md`: the daily table, the week's figures, and a line saying so when the week is partial. Read the page before committing it.

## What the server cannot see

- **The consumer's CLI errors:** the server sees refusals only, so a category such as "service unavailable" on the consumer's side is "not measured".
- **Costs:** the owner's invoice lines, entered by hand in the dossier.
- **Operator minutes:** these come from the run notes.

The owner's consumer should start or read at least once a day, or the day counts as `no activity` (P-168).
