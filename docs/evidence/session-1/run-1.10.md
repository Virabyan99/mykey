# Run 1.10 — Registry and session gate

## What was done

- `scripts/registry-build.ts`, `scripts/registry-verify.ts`, `docs/evidence/registry.json` (191 items: 102 FR, 60 AC, 29 proofs), `docs/evidence/registry-overrides.json`, `tests/unit/registry/registry.test.ts`; root scripts `evidence:build` and `evidence:verify`; `check` ends with `evidence:verify`.
- Statuses: PO-24, FR-1.33, FR-1.34 and FR-1.38 are `SPIKE_PASS`, each stated by its run note. Everything else is `OPEN`. Nothing is `PASS`.
- Session gate: full suite, fresh-clone demonstration, one independent review, one fix pass, the session report (`report.md`).

## Commits

- `9bd409b` docs(evidence): requirement, acceptance and proof registry
- `f3f29a1` docs(evidence): dotenv requirements reach SPIKE_PASS
- `a8c98a3`, `9492d28`, `2118131`, `694787b` — the review fix pass
- this commit: the session report and this note

## Commands and results

| Command                                                                                                                       | Exit  | Proof line                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------ |
| `pnpm test`, registry tests written, no script yet                                                                            | 1     | `Cannot find module '../../../scripts/registry-build.ts'`                                              |
| `pnpm test` with the registry                                                                                                 | 0     | `Tests 103 passed (103)`                                                                               |
| `pnpm run evidence:verify` after editing one title in `registry.json` by hand                                                 | 1     | `registry.json differs from a rebuild from the documents and overrides`                                |
| Fresh clone outside OneDrive at `b14a616`: `pnpm install --frozen-lockfile && pnpm run stack:up && pnpm run test:integration` | 0     | `Done in 14.9s`, `stack mykey-dev is up`, `Test Files 10 passed (10)`, `Tests 267 passed (267)`, 106 s |
| CI on `b14a616` (run 42844480904)                                                                                             | —     | all nine jobs green                                                                                    |
| `pnpm run test:cloud`                                                                                                         | 1     | `cloud credentials missing: mykey-fixture-upload, mykey-fixture-cleanup, mykey-r2-admin`               |
| After the fix pass: `pnpm run check`                                                                                          | 0     | `evidence: registry ok (191 items).`                                                                   |
| After the fix pass: `pnpm test`                                                                                               | 0     | `Tests 374 passed (374)`                                                                               |
| After the fix pass: `pnpm run test:integration`                                                                               | 0     | `Test Files 10 passed (10)`, `Tests 270 passed (270)`                                                  |
| `node scripts/ci-scan.ts secrets` in the repository / in an empty repository                                                  | 0 / 1 | `19 commits scanned` / `scan: secret scan read no commit`                                              |

The gate's cloud step did not pass: `test:cloud` fails because Run 1.9 is not done. That is the "ISSUES" in the session result.

## Decisions made while executing

- The "Covers:" lines of Document 10 mark partial coverage with six phrases, not three: "early", "start of", "server side of" (the plan's), and "inventory", "replays of", "rehearsal of". All six make a run a contributing run.
- Two owners were chosen by hand and recorded with reasons in `registry-overrides.json`: PO-24 → Run 1.3, AC-1.58 → Run 9.8. FR-1.100 → Run 9.6 follows from its Covers line.
- Titles: FR titles are the bold lead-in of the Document 04 row; AC titles are the first clause (at most 80 characters); proof titles come from Document 04 §13.4 and Document 08 Part IV G.
- After the review: a claim other than `OPEN` must be stated by its evidence file on one line together with the item id. This is stricter than the plan ("at least one existing evidence path").

## Review

One fresh-context reviewer; no critical finding, six important findings fixed test-first, the rest listed in `report.md` under "Reviewer findings".

## Left for later

- Session 8 removes the "no PASS" rule of `evidence:verify` when the release suite runs.
- `WATCH` is not yet tied to the watch items W-1 and W-2.
