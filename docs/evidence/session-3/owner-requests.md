# Owner requests for Session 3

Sent 2026-11-12 in the Session 3 execution chat. Run 3.1 starts without waiting.

1. **Nothing to buy and nothing to click in this session.**
2. **Expect Telegram alerts from staging** during three deploy windows — Runs 3.1, 3.8 and 3.10. After every deploy staging starts with its service gate closed until the gate is opened, so `/health` reports down for a few minutes. There is also one deliberate drill in Run 3.8: a policy is removed on staging to prove the `review_open` alert. Each window is announced in its run note; an alert outside those windows is real.
3. **One yes/no, needed only at the gate:** may the gate run bring production to the current migrations and API image, with its gate closed (production `/health` then reports down until a later session opens it)? Default when there is no answer: **no** — production stays as it is and the item is carried to Session 4.
4. **For information:** the staging seal certificate still expires on 12 Dec 2026; `.trivyignore.images` expires on 20 Nov 2026 and the image scan in CI turns red that day unless it is reviewed again (proposed for the Session 4 gate).

## Answers

_None yet._
