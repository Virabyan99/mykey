# Run 11.9 — The gate

**Date:** 26 Nov 2026. **Branch:** `session-11`, PR #27 (ready). P-195, P-197.

## Result

The gate is run, with one part open: the consumer rehearsal was red on the candidate and waits for the owner's word. The session's result is PASS WITH ISSUES (`report.md`).

## What was done

- **The pull request was marked ready** once the session's code was in. The full suite is green at `be03675` (run 45815246889: check, secret scan, scans, both integration shards, browser).
- **The CI sweep (S11-13):** `node scripts/sweep-ci.ts` over the logs of the full run at the candidate's source (45720586150), the full run at `be03675` and the `cli-matrix` run of `cli-v0.2.0` (45723155073): 0 canary-shaped, 0 token-shaped in 3 files.
- **The acceptance items** (`acceptance.md`): 14 items, 9 PASS and five with a remark.
- **The manifest** (`manifest.md`, applied): 159 PASS (9 `earlier`), 7 NOT YET DUE, 7 NOT PROVEN.
  - `proof-map.json` and `results.json` come from Session 10's. Every staging run on `host-v0.10.0` is a result, the red ones too.
  - 26 ids are no longer `earlier`.
  - AC-1.20 and PO-20 are NOT PROVEN for the rehearsal. AC-1.42 and AC-1.50 keep `earlier` on `host-v0.8.1` for it.
  - `candidate.json` lists `tools/agent-runner/` and `.gitleaksignore` as tooling.
- **`report.md`** and **`CLAUDE.md`**.

## A defect of the manifest tool, found and fixed

- **What was wrong.** `scripts/release-manifest.ts` compared the release of a staging and a cli result, and never of a consumers result. A green rehearsal of any earlier release counted for every later candidate.
- **How it showed.** The rehearsal was red on `host-v0.10.0` and recorded so, and the manifest still said PASS for AC-1.20, AC-1.42, AC-1.50 and PO-20.
- **The fix.** A consumers result is a result of the host release, as a staging file's is; an `earlier` entry that names its release keeps it.
- **The test first.** `tests/unit/registry/release-manifest.test.ts`, "a consumer rehearsal counts on the candidate's host release only": red with "expected '' to match … the consumers result ran on host-v0.7.0", then green. Registry unit tests: 31 of 31.
- **What it says of earlier sessions.** Session 9's manifest (candidate `host-v0.9.1`) counted AC-1.20 and PO-20 on the rehearsal of `host-v0.8.1`. Session 10 ran the rehearsal on its candidate. Session 8's is unaffected. No earlier file was changed.

## The registry

`--apply` sets PASS and never lowers one. The registry keeps 161 PASS: AC-1.20 and PO-20 are PASS there by Session 10's manifest (`host-v0.9.2`), while this session's manifest holds them NOT PROVEN for `host-v0.10.0`.

## Commands and results

| Command                                                      | Result                                              |
| ------------------------------------------------------------ | --------------------------------------------------- |
| `gh pr ready 27`, full CI at `be03675`                       | green (45815246889)                                 |
| `node scripts/sweep-ci.ts` over three logs                   | 0 found                                             |
| `vitest --project unit tests/unit/registry`                  | 31 of 31 (the new test red first)                   |
| `node scripts/release-manifest.ts --session 11 --apply`      | 159 PASS, 7 NOT YET DUE, 7 NOT PROVEN               |
| `node scripts/release-manifest.ts --session 9` (not written) | refused: AC-1.20 and PO-20, the rehearsal's release |
| `pnpm run check`                                             | green                                               |

## Open issues

- **`pnpm run test:consumers` on `host-v0.10.0`:** not run again. With a green run the manifest is rebuilt: 161 PASS, 5 NOT PROVEN.
- Everything else is in `report.md`, "Open issues".
