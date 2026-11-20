# Run 8.0 — What was already known to change the build

**Date:** 20 Nov 2026. **Branch:** `session-8` (draft PR #22). **Decisions:** D-64, D-66 (P-146, P-147, P-149). Not in Doc 10 (P-143).

## What was done

- **Task A (host files, OpenBao):** Session 6's F (`status.sh` reads an absent OpenBao as audit unknown), G (`SuccessExitStatus=75`), H (`mykey-capture-recover` retries every 20 s, at most 15 times in 10 min); AppRole's user lockout switched off on the hosts and in the test stack. Production showed F live before its push: `auditFailing false` with no OpenBao.
- **Task B (the operator tool):** production accepts every KMS and OpenBao command but `kms-import`; `deploy --owner-confirmed` (refuses a release that is not the running build; production refuses the scripted journey when parsed); the zero-secret rule counted in `app.secret_index`; a standalone `gate open --report` takes a deploy report only and re-runs its four store checks (`openWithDeployReport`). Runbook `production.md`; `service-gate.md`, `deploy.md`, `kms-and-unseal.md` corrected.
- **Task C (the page):** Session 7's Minors 5, 6, 8+13, 10, 11 and the known limits in the Help screen (FR-1.102). `known-limits.md` gains a line per accepted finding (D-66).
- Run 8.1 Task A began: `prod push`, `prod kms-install` (pinned checksum), `prod kms-csr prod-seal-1` (key on the host; the CSR at `~/.mykey/kms/prod-seal-1.csr`). The owner's console sitting 1 is asked (`owner-requests.md`).

## Commits

- `f471a53` docs: Session 8's requests to the owner
- `f100a5c` fix(hosts): status says unknown, two units stop alerting falsely, AppRole has no lockout
- `2a4d66c` feat(host): production can get its OpenBao, and a host with a real owner can be opened
- `cf68d55` fix(web): uncertain is counted as uncertain, and the page shows its own limits

## Commands and results

| Command                                                                                | Result                                                                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `vitest --project integration tests/integration/openbao/lockout.test.ts`               | RED: the right secret id after 20 wrong ones answered 403; GREEN after the stanza: 1/1 |
| `vitest --project unit tests/unit/hosts` (F, G, H, the stanza)                         | RED 4 (the control passed); GREEN 228/228                                              |
| `vitest --project unit tests/unit/hosts tests/unit/release` (Task B)                   | RED 4 (three parse rules, the owner-confirmed plan); GREEN 256/256                     |
| `vitest --project integration tests/integration/deploy` (with `first-opening.test.ts`) | RED 5/5 (the functions did not exist); GREEN 12/12 in 5 files                          |
| `vitest --project unit tests/unit/api/web-shell.test.ts`                               | RED 2 (the policy); GREEN 41/41                                                        |
| `vitest --project integration tests/integration/web/shell.test.ts …/origin.test.ts`    | RED 3 (`/%68elp`, `/sign%2Din`, `/%61ccount` answered 200); GREEN 20/20; origin 5/5    |
| `vitest --project browser` the three new tests, with the page's fixes stashed          | RED 3/3 ("2 were not."; Save enabled; no "Known limits" region)                        |
| `vitest --project browser import-export, secrets, shell`                               | GREEN 28/28                                                                            |
| `pnpm run check`                                                                       | green after each task; the draft runs of Tasks A and B green (2 min 19 s each)         |

## Deviations and decisions

- The standalone-open tests live in `first-opening.test.ts`, not `restore/gate.test.ts`: they need a private stack with OpenBao, because the store checks read every namespace.
- `--owner-confirmed` also refuses a release that is not the running build (`deployPlan`): the owner's journey must be of the build that opens. The path is `--stay-closed`, the journey, `--owner-confirmed`.
- Finding 11 was a coverage gap: its test passed when written (`disableSessionRefresh` is set), and stays as the proof.
- Finding 8's proof is the HTTP test: the decoding was `c.req.path` in `app.ts` (now `shellPathOf(c.req.url)`), so a unit test of `shellAnswer` could not fail.
- The hold of finding 6 lifts when the form is closed or the page leaves; the operation's state is read on its own screen (the panel's link). It covers every form and dialog that uses `useAction`; the import's Resume button keeps its own `busy`.
- The browser tests were written before the fixes but first run after them; the fixes were stashed and the three tests run RED, then GREEN.
- Earlier unit tests that asserted production refuses KMS and OpenBao commands were rewritten to P-147 (a).

## Open issues

- The deploy's scripted journey with no secret (a fresh staging) is reasoned, not run: `firstSecret` now returns no path, `deployJourney` makes no reveal, and the report counts the index. Staging always has secrets; production refuses the scripted journey.
- Staging gets the new host files and OpenBao's configuration at the freeze (Run 8.1 Task B Step 5).
