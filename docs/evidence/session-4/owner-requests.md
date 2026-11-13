# Owner requests for Session 4

Sent 2026-11-13 in the Session 4 execution chat. Run 4.1 starts without waiting.

1. **Nothing to buy and nothing to click in this session.**
2. **Expect Telegram alerts from staging** during four deploy windows (Runs 4.2, 4.5, 4.9 and 4.10 — staging starts with its gate closed after every deploy) and during two deliberate drills (Run 4.5 and the gate): a write is made uncertain on purpose, which raises the new alert `operations_unresolved`, and staging is then closed for about ten minutes of maintenance. Each window is announced in its run note; an alert outside those windows is real.
3. **One yes/no, needed only at the gate:** may the gate run bring production to the current migrations and API image, with its gate still not open? Default when there is no answer: **no**.
4. **For information:** from 15 Nov 2026 09:42 UTC `pnpm run test:cloud` fails on purpose (the R2 fixture guard) until Run 6.6; `.trivyignore.images` expires on 20 Nov 2026 and is reviewed again at this session's gate; all KMS certificates expire on 12 Dec 2026.

## Answers

_None yet._
