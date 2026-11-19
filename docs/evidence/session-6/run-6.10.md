# Run 6.10 — Runbooks and honest limits (D08-S43)

**Date:** 18 Nov 2026. **Branch:** `session-6`. **Plan items:** P-130 (FR-1.75, AC-1.33).

## What was done

- **`docs/runbooks/alerts.md`:** one section per probe condition (15). Each has `Means`, `Check` (with a fenced command), `Fix` (the first action, and when to close the gate) and `Confirm` (the `resolved` message and the status line).
- **`docs/runbooks/known-limits.md`:** what the service does not do, each item with where it was measured or decided. It covers:
  - requests and errors;
  - alerts and the probe;
  - backups and restore (the drill's 42 minutes, the per-environment reconcile, the spike leftovers, the OpenBao lockout);
  - operations (the borrowed server, the ops image's two host names, the deploy's root token, one operator).
- **Three tests that keep runbooks true** (`tests/unit/runbooks/`):
  - `alerts.test.ts`: the sections equal `CONDITIONS`; each has the four headings and a command; each condition has a dated delivery line in `docs/evidence/session-6/alerts.md`.
  - `links.test.ts`: every relative link and every repository path a runbook names exists.
  - `commands.test.ts`: every `host.ts`, `probe.ts` and `ops` command in a fenced block exists (in `host.ts`'s `USAGE`, `probe.ts`'s usage line, `ops`'s `COMMANDS`).
- **What the tests found in the existing runbooks:**
  - `db-globals-inventory.md` cited `tests/staging/pair.staging.test.ts`, removed in Run 6.5; it now cites the drill.
  - `operator-accounts.md`'s `ops <command>` is a template, which the test skips.
- **One reading of `restore.md` against `drill.json`.** Every command the drill ran is in "Before" or the steps, in that order. Added: `acme production` and `ops-secrets`.

## Commands and results

| Command                                     | Result                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `vitest --project unit tests/unit/runbooks` | RED first (no `alerts.md`; a removed test file named; an `ops` template read as a command) → 7/7 green |
| `pnpm test`                                 | green                                                                                                  |
| `pnpm run check`                            | green                                                                                                  |

## Deviations

- **The evidence lines of Run 6.4 carry no alert-log row ids.** They carry the date, the condition, and "delivered" with the delay. `alerts.test.ts` requires those three, not a row id. The probe's log keeps the rows (`probe.ts state <host>`, last 20 alerts).
- **No `scripts/runbook-coverage.ts`.** The three tests read the lists directly (`CONDITIONS`, `USAGE`, `COMMANDS`), so a separate script would only repeat them.

## Registry

- FR-1.75 SPIKE_PASS
- AC-1.33 SPIKE_PASS
