# Session 8 report — Security review and controlled-use release

_20–21 Nov 2026. Plan: `docs/plans/session-8-plan.md`. Branch `session-8`, pull request #22._

## Result

**There is one candidate, and Gate R is asked.** The candidate is `host-v0.8.1` with `cli-v0.1.2`.

- **Staging** runs it open.
- **Production** runs it closed, with its own OpenBao and KMS key, backup and timers, and no account, organization or data.
- **The release manifest** passes without force: **144 PASS** (9 of them `earlier`), **9 NOT PROVEN**, **7 NOT YET DUE**.
- **Reviews:** six fresh-context reviews and a re-read of the fixes found **no Critical and no High**. Their 15 Mediums are fixed or accepted, each in the reviewer's own words in Gate R.
- **Sweep:** the canary sweep finds nothing on 18 surfaces, every control found.
- **The owner's hour** on staging reached a delivered environment with no `.env`, and a denial after revocation.

What is not proven is listed in `gate-r.md` above the signature line. The weightiest item is the staging drill of an issuance left unknown. It was red on the candidate, and its fault is proven on CI only. So AC-1.57, and with it FR-1.101, is not PASS.

**Gate R is signed.** The owner answered "approved, merge" on 21 Nov 2026, 19:25 UTC (D-67).

## What ran where, once

The hours are taken from commit times, so they are approximate.

| Run                | What                                                                                                          | Box         | Real                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------- |
| 8.0                | the known changes: hosts and AppRole lockout, production's path (D-64), the page's uncertain count and limits | 3 h         | 1 h                          |
| 8.2                | the second organization attacks every route and both stores; one finding (`health.get`) fixed                 | 2 h         | 0.5 h                        |
| 8.4 Task A         | the canary sweep, written and green on staging                                                                | 2 h         | 0.5 h                        |
| 8.5 (+ 8.7 Task A) | six reviews (each sent back once for unread paths); the manifest's tool, during the wait                      | 1 h         | 0.7 h                        |
| 8.6                | the fixes (R1-1, R1-2/R4-1, R5-1..4, R6-6, the statements), the fixes review and its Lows                     | 2 h + fixes | 2.2 h                        |
| 8.1 Task B         | full CI, pins, `cli-v0.1.2`, `host-v0.8.0` (one build stopped for memory), staging and production deploys     | 1.5 h       | 1.7 h                        |
| 8.1 Task A         | production's KMS domain (two owner sittings), OpenBao, custody, first pair                                    | 1.5 h       | about 2.5 h                  |
| 8.8                | the owner's hour, five document fixes, the staging owner re-established                                       | 1.5 h       | about 2 h                    |
| 8.7 Task C         | the claims walk (265 rows, 13 corrections); `host-v0.8.1`, released and deployed                              | in the pass | 1.7 h                        |
| 8.3, 8.4 B, 8.7 B  | the pass on `host-v0.8.1`: 33 staging runs, consumers, cloud, cli-matrix, two full CI runs; four test repairs | 6 h         | 6 h of staging, 6.5 h in all |
| 8.9                | Gate R, this report, D-63, D-67, CLAUDE.md                                                                    | 1 h         | about 1 h                    |

**Did "fix first, freeze once" keep it to one candidate?** Nearly. Every fix of the reviews went in before the freeze. The one later product change was the page's texts, which the claims walk found after the freeze. That made `host-v0.8.1`, and Group A ran twice. Doing the claims walk before the freeze would have saved about 40 minutes of staging.

## Findings, and what became of each

- **The attacks (Run 8.2):** one finding. `health.get` could answer an error its contract did not list; it was fixed in that run. Nothing crossed organizations through any route, selector, cursor or aggregate.
- **The sweep (Run 8.4):**
  - on `host-v0.8.0` and again on `host-v0.8.1`: 0 needles found on 18 surfaces, every control found;
  - its blind spots are listed in Gate R, section 8;
  - two canaries were in lower case, which the secret scan does not match; both were made upper case.
- **The reviews (Run 8.5):** 15 Mediums, 44 Lows, and no Critical or High.
  - **Fixed in Run 8.6:**
    - R1-1 (failed attempts count when they are admitted);
    - R1-2/R4-1 (after a restore, a reset never trusts the pair's factor);
    - R5-1 to R5-4 (the CLI, now `cli-v0.1.2`, D-68);
    - R6-6 (an old heartbeat shape leaves its checks unknown);
    - false statements corrected (R4-12, R6-1).
  - **Accepted with a known-limits line**, quoted in Gate R: R2-1, R3-1 (M1, D-65), R3-2, R4-2, R4-3, R4-4, R4-5, R4-10 and R6-1.
  - **The fixes review:** 11 Lows. F-1, F-3, F-4a, F-8, F-10 and F-11 were fixed; the rest have known-limits lines.
- **The claims walk:** 13 corrections, all made. Four were texts of the page, which made `host-v0.8.1`.
- **The owner's hour (Run 8.8):** five findings, all closed by documents (`run-8.8.md`). The project id appears only in the address. That is a page behaviour, and it goes to Session 9.
- **The pass:** four red staging files, each diagnosed first.
  - Three were stale or too tight as tests, and are repaired: `probe` on production, the `unseal` window, the blackout's bound.
  - The fourth is the credential drill's aim (below).
  - The manifest's tool had one defect, found by its own test and fixed.

## Was `host-v0.8.1` needed?

Yes. The page said:

- that an export is recorded "with its names" (it records their number);
- that values are read only on Reveal (export and the import's preview read them too);
- that the installer checks what it installs (it checks the CLI and the Node runtime it downloads);
- three error explanations that promised more than the product does.

FR-1.102 forbids a claim the product does not keep. A page's text is part of the build, so P-145 made it a new candidate.

## Deviations

- **The order:** Run 8.1 Task A came after Task B, because the owner's first KMS sitting was answered on 21 Nov. Task A touched neither the build nor the freeze.
- **Root `.md` files** count as allowed changes for a ci result (ruling of Run 8.7).
- **The credential drill** was not tried a third time, after 20 failed attempts (the owner asked for speed). It was given its own file, so that AC-1.42 stands on the journey. Its four ids are NOT PROVEN.
- **Three staging tests** were repaired as tests: `probe` (production now has OpenBao), the `unseal` window (410 s inside a 420 s block), and the blackout's bound (360 s, Doc 06 §12's worst case).
- **The owner's edit of `consumer-local.md`** was committed by mistake and turned the secret scan red. It was reverted, and its id (a staging UUID, not a credential) went into `.gitleaksignore` with the reason.
- **`backup-night`** did not run on the candidate: the night of 21–22 Nov comes after the pass.

## Open issues

1. **The credential drill's aim.** The same SSH-timed pause also failed `reconcile` once. The pause should be triggered on the host, by the API's dispatch marker, not sent over SSH.
2. **The nine NOT PROVEN items** (Gate R, section 4), each with its reason.
3. **The accepted Mediums.** The four restore items (R4-2, R4-3, R4-4, R4-10) are in the restore code, which stays as proven (P-150).

## What Session 9 must know

- **The first opening** of production is `production.md`'s path, and only after "approved":
  1. bootstrap in the owner's own terminal;
  2. enrolment through the operator's private link;
  3. `provision-organization`;
  4. the owner's journey through `tunnel verify`;
  5. `deploy --owner-confirmed` (D-64).
     Production holds no workstation copy of the owner's password or authenticator.
- **Run 9.7** (the restore drill after Gate R, P-150) is due in Session 9. The restore code is unchanged since Run 6.8.
  - **R4-10:** a restore onto the same host name needs a fresh custody copy first.
  - **R4-2:** after `--open`, a restored host has no root token until one is made with the source's recovery key.
- **The owner's request: rework the workspace's UI and UX.** The owner said it is hard to navigate and understand on a first visit. Start from `walkthrough.md`, and show the project id on the page (today it is only in the address, and the wrong segment gave a 404).
- **Re-aim the credential drill** (`credential-drill.staging.test.ts`). Until then AC-1.18, AC-1.40, AC-1.57 and PO-18 are NOT PROVEN on staging.
- **The dated items:**
  - **12 Dec 2026:** staging's KMS certificates expire.
  - **14 Dec 2026:** `.trivyignore.images` (53 entries) expires.
  - **17 Dec 2026, 19:00 UTC:** checkpoint `pair-30-day` is due.
  - **21 Dec 2026, 07:48 UTC:** production's `prod-seal-1` expires.
- **Staging tests found stale this session:**
  - one that assumed production had no OpenBao;
  - two timing windows too tight for the probe's one-minute cron.

  Each repaired test says why in its comment.
