# D-66 — The carried findings: fixed or accepted

**Date:** 2026-11-20

**Status:** DECIDED (plan P-149). Built in Run 8.0 Tasks A and C. The owner signs the accepted list with Gate R (`docs/evidence/session-8/gate-r.md`). Evidence: `docs/evidence/session-8/run-8.0.md`, the tests named below, and one line per accepted item in `docs/runbooks/known-limits.md`.

## Context

Sessions 6 and 7 left Minor findings, two questions and three carried items for Session 8 (their reports). Doc 10's Run 8.6 fixes what is High or Critical; these are all Minor. Each is fixed where the fix is cheap and removes a false statement or a false alert. The rest are availability or defence in depth, and are written where an owner can notice them.

## Fixed (Run 8.0)

| Item                     | What was wrong                                                                       | Proof (failing first)                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Session 6, F             | `status.sh` counted an absent OpenBao container as audit-healthy                     | `tests/unit/hosts/status.test.ts` (the audit block run in a shell, with a control)                 |
| Session 6, G             | `mykey-backup` failed on exit 75, a busy drain                                       | `tests/unit/hosts/units.test.ts`                                                                   |
| Session 6, H             | `mykey-capture-recover` failed at boot before PostgreSQL answered, and stayed failed | `tests/unit/hosts/units.test.ts` (bounded retries)                                                 |
| The OpenBao user lockout | Five wrong secret ids locked the role id out for 15 minutes, the right one included  | `tests/integration/openbao/lockout.test.ts` (403 before, 200 after); `openbao-config.test.ts`      |
| Session 7, 5             | The import's sentence counted uncertain entries as "not written"                     | `tests/browser/import-export.test.ts`                                                              |
| Session 7, 6             | After "the outcome is not known" the form's button stayed enabled                    | `tests/browser/secrets.test.ts` (`useAction().held` on every form and dialog of a change)          |
| Session 7, 8 and 13      | The API decoded a path before matching the page table; the page's router did not     | `tests/integration/web/shell.test.ts` (seven paths through the HTTP server)                        |
| Session 7, 10            | The content policy named `img-src 'self'` and `font-src 'self'`, which nothing uses  | `tests/unit/api/web-shell.test.ts` (each source against what the build uses)                       |
| Session 7, 11            | The two GETs of the auth module were not in the "a GET changes nothing" comparison   | `tests/integration/browser-security/origin.test.ts` (a coverage gap: the test passed when written) |
| FR-1.102                 | The Help screen named `known-limits.md` by its path only                             | `tests/browser/shell.test.ts` (every heading and item of the file is on the page)                  |

The lockout is switched off for AppRole only (`user_lockout "approle" { disable_lockout = true }`, on the hosts and in the test stack). The secret ids are random and OpenBao is reachable only from the product's own containers, so the lockout protected nothing and turned one mistake into fifteen minutes without secrets. Reviewer 3 of Run 8.5 is asked what switching it off exposes.

## Accepted

| Item                                                       | Why it is accepted                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session 6, C (a reduction just before a capture)           | A restore resets every account and revokes every token anyway (D-55), and members are confirmed by count. The fix is a migration.                                                    |
| Session 6, D (any signed `eligible.json`)                  | Restore code: it stays as Run 6.8's drill proved it (P-150). With `--pair` the operator chooses the pair; with `--newest` the bucket's newest signed pair is taken (R4-12, Run 8.6). |
| `reconcile-credentials --all`                              | Restore code (P-150). 27 minutes on staging's data is slow, not wrong; Run 9.7's drill measures again.                                                                               |
| Session 6, E (the listener's own slots)                    | The verification listener serves only during a deploy or a restore, on the operator's tunnel.                                                                                        |
| Session 6, I (no `lock_timeout` in the drain)              | The capture runs once a night, at 03:00 UTC; the stall lasts as long as the one writer it waits behind. The fix is a timeout in the coordinator, worth it only with real traffic.    |
| `credential_expiring` for a credential under 7 days        | It warns early: the safe side.                                                                                                                                                       |
| The probabilistic staging drill                            | `tests/fault/credentials/issuance.test.ts` places the same fault exactly; the staging drill tries up to ten times.                                                                   |
| Session 7, 1 to 4 (things the page holds longer than 30 s) | Each is in the tab's own memory, gone with the screen or the page; nothing is written to any storage.                                                                                |
| Session 7, 7 (`HEAD` answers 404)                          | Only a checker that uses `HEAD` sees it.                                                                                                                                             |
| Session 7, 9 (`no-store` on the script)                    | A cost of 216 kB compressed per load, for a page that never comes from a cache.                                                                                                      |
| Session 7, 12 (the canary cannot see the query cache)      | The source search stays the proof; the reviewers of Run 8.5 read the page's code.                                                                                                    |

`CVE-2026-97054` is settled at the freeze (Run 8.1 Task B). The two questions Session 7's reviewer declined go to reviewers 2 and 6 of Run 8.5.

## Consequences

- `known-limits.md` loses the lockout line and the line of finding 6, corrects "the page names runbooks by their path", and gains one line for each accepted item that had none. The Help screen shows the file, so the owner reads every accepted item in the page.
- None of the accepted items is a High or Critical of Session 8's reviews unless a reviewer rates it so; then Run 8.6 fixes it.
