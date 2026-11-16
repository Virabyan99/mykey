# Owner requests for Session 5

Sent 2026-11-15 in the Session 5 execution chat. Run 5.1 starts without waiting.

1. **One thing to decide, about GitHub Actions minutes.** The four-platform proof of the CLI needs real macOS runners, whose minutes count ten times; this session needs about 160 billed minutes at its gate and November has fewer than 200 left. Either set a spending limit for Actions of a few dollars (GitHub → Settings → Billing and plans → Budgets and alerts), or tell the agent the number under "Actions minutes used" on that page. Default when there is no answer: the matrix and the pull request's CI each run once, and anything that does not fit is reported as not proven.
2. **Expect Telegram alerts from staging** during three deploy windows (Runs 5.2, 5.4, 5.10 — staging starts closed after every deploy) and during two deliberate drills (Run 5.2 and the gate): an issuance is made uncertain on purpose, which raises `operations_unresolved`, and staging is then closed for about ten minutes of maintenance while the operator command settles it. Each window is announced in its run note; an alert outside those windows is real.
3. **One yes/no, needed only at the gate:** may the gate run bring production to the current migrations and API image, with its gate still not open? Default when there is no answer: **no**.
4. **For information:** `pnpm run test:cloud` fails on purpose from 15 Nov 2026 09:42 UTC (the R2 fixture guard) until Run 6.6; all KMS certificates expire on 12 Dec 2026 and `.trivyignore.images` on 14 Dec 2026.

5. **Added 2026-11-15 (Run 5.7), the same question made concrete.** The matrix ran once (about 64 billed minutes). Linux passed. Both macOS runners failed on the test suite's own certificates, which is now fixed and proven on Linux and under LibreSSL. One more dispatch (about 64 minutes again, most of it macOS) would close FR-1.51, AC-1.37, PO-8 and AGENT-B1. Default when there is no answer: it does not run, and the four items stay `OPEN` (`cli-matrix.md`).

## Answers

Given 2026-11-16 in the Session 5 execution chat:

- **Items 1 and 5 (Actions minutes):** the owner made the repository public, so Actions minutes no longer count.
- **Item 3 (production):** yes.
- **Merge:** the owner asked for PR #12 to be merged.
