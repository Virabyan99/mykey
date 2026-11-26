# Run 11.9 — The gate

**Date:** 26 Nov 2026. **Branch:** `session-11`, PR #27 (ready). P-195, P-197.

## Result

The gate is run. The session's result is PASS WITH ISSUES (`report.md`). The owner said "merge" on 26 Nov 2026 (`owner-requests.md`).

## What was done

- **The pull request was marked ready** once the session's code was in. The full suite is green at `be03675` (run 45815246889) and at `a2028c2`, the manifest fix (45818123575): check, secret scan, scans, both integration shards, browser.
- **The CI sweep (S11-13):** `node scripts/sweep-ci.ts` over the logs of the full run at the candidate's source (45720586150), the full run at `be03675` and the `cli-matrix` run of `cli-v0.2.0` (45723155073): 0 canary-shaped, 0 token-shaped in 3 files.
- **The consumer rehearsal, second run:** `pnpm run test:consumers` against staging on `host-v0.10.0`, alone, on mains power, 12:54 to 13:06 UTC: 2 files, 7 of 7, 731 s. Its deploy half uses runtime credentials. The owner's "continue" was read as the word for it (`owner-requests.md`).
- **The acceptance items** (`acceptance.md`): 14 items, 10 PASS and four with a remark.
- **The manifest** (`manifest.md`, applied): 161 PASS (7 `earlier`), 7 NOT YET DUE, 5 NOT PROVEN.
  - `proof-map.json` and `results.json` come from Session 10's. Every run on `host-v0.10.0` is a result, the red ones too.
  - 28 ids are no longer `earlier`.
  - It was built once before the second rehearsal, with the red run only: 159 PASS, AC-1.20 and PO-20 NOT PROVEN, AC-1.42 and AC-1.50 kept `earlier`.
  - `candidate.json` lists `tools/agent-runner/` and `.gitleaksignore` as tooling.
- **`report.md`** and **`CLAUDE.md`**.

## A defect of the manifest tool, found and fixed

- **What was wrong.** `scripts/release-manifest.ts` compared the release of a staging and a cli result, and never of a consumers result. A green rehearsal of any earlier release counted for every later candidate.
- **How it showed.** The rehearsal was red on `host-v0.10.0` and recorded so, and the manifest still said PASS for AC-1.20, AC-1.42, AC-1.50 and PO-20.
- **The fix.** A consumers result is a result of the host release, as a staging file's is; an `earlier` entry that names its release keeps it.
- **The test first.** `tests/unit/registry/release-manifest.test.ts`, "a consumer rehearsal counts on the candidate's host release only": red with "expected '' to match … the consumers result ran on host-v0.7.0", then green. Registry unit tests: 31 of 31.
- **What it says of earlier sessions.** Session 9's manifest (candidate `host-v0.9.1`) counted AC-1.20 and PO-20 on the rehearsal of `host-v0.8.1`. Session 10 ran the rehearsal on its candidate. Session 8's is unaffected. No earlier file was changed.

## Two fault tests were red once on CI

The full run at `d856896` (45820861908) had integration shard 1 red. That commit differs from the green `a2028c2` in documents and evidence files only.

- `tests/fault/audit/exhaustion.test.ts`, "after space is freed both succeed again": a reveal answered 503 `quarantined` where 200 was expected.
- `tests/fault/capture/compete.test.ts`, "every eligible pair restores whole; every crossed pair is ineligible; no 5xx but busy": one answer of forty captures was a 5xx that is not `busy`. The test took 444 s.

The same shard, run again on the same commit, was green. Both tests depend on the runner's speed. The cause was not looked for: an open issue.

## GitGuardian on the pull request

The check failed with seven findings in 29 commits (it is not a required check). Read before the merge, by commit and file:

- `603fe27`, `tests/unit/cli/validate.test.ts`: the synthetic literal of a token's shape (Run 11.4), assembled at run time since the next commit.
- `0770d9a` and `d093e4c`, `docs/evidence/session-11/staging-automation.json`, three lines each: two credential ids, catalog row ids, one of them written twice (Run 11.8).

They are the seven lines `.gitleaksignore` records for this session, each reviewed there. No secret is among them. The incidents (41121353, 41140388, 41140389, 41141567 and 41141568) are the owner's to dismiss.

## The registry

`--apply` sets PASS and never lowers one. While the manifest stood at 159, the registry kept 161 PASS. With the second manifest both say 161.

## Commands and results

| Command                                                      | Result                                              |
| ------------------------------------------------------------ | --------------------------------------------------- |
| `gh pr ready 27`, full CI at `be03675`                       | green (45815246889)                                 |
| full CI at `a2028c2`                                         | green (45818123575)                                 |
| full CI at `d856896`                                         | shard 1 red once (two fault tests), green on rerun  |
| `node scripts/sweep-ci.ts` over three logs                   | 0 found                                             |
| `vitest --project unit tests/unit/registry`                  | 31 of 31 (the new test red first)                   |
| `pnpm run test:consumers` (second run)                       | 2 files, 7 of 7, 731 s                              |
| `node scripts/release-manifest.ts --session 11 --apply`      | 161 PASS, 7 NOT YET DUE, 5 NOT PROVEN               |
| `node scripts/release-manifest.ts --session 9` (not written) | refused: AC-1.20 and PO-20, the rehearsal's release |
| `pnpm run check`                                             | green                                               |

## Open issues

- **The two fault tests** that were red once on CI.
- **GitGuardian's five incidents** of this pull request: the owner's dismissal.
- Everything else is in `report.md`, "Open issues".
