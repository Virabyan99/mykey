# Session 10 — requests to the owner

Written at the session start (23 Nov 2026). No value appears in this file. Seven answers are asked; one block and a sign-off are announced.

## First, two things for today

- **F-10.0-1.** On consumer-1, the names-only start prints the later lines of any value that has more than one line (`env | cut -d= -f1` prints a line with no `=` whole). Until production has `host-v0.9.2`, start it with `secrets-launch.sh -- sh -c 'awk "BEGIN { for (k in ENVIRON) print k }" | sort'`, and do not copy an older terminal into a chat.
- **Until production has `host-v0.9.2`,** store a token only with the form in `known-limits.md`, and only in `bash`.

## Now: seven answers

1. **May production get `host-v0.9.2`?** It holds changes to the page only: the token step, the names-only command and their help texts. It goes by `production.md` §4 (`--stay-closed`, your journey in the `tunnel verify --browser` window, `--owner-confirmed`), and only after full CI and a fresh review are green.
2. **May staging be reinstalled and restored onto itself** (D-73's drill)? In the same sitting you issue one new KMS certificate for staging, which is the replacement due by 5 Dec 2026.
3. **The CLI gets no token-store command** (ruled, P-171, D-76): agree, or overrule.
4. **The shape of the days:** (a) a day and a morning, recommended; or (b) one long day.
5. **The Anthropic API key** at `C:\Users\gmpar\.mykey\secrets\anthropic\api-key`: is it still valid, with about US$5 left? Reply "key ok". Never paste it.
6. **Which coding agent will you use for the real project?** The proof uses Claude Code; another agent is not proven, and the report will say so.
7. **When can you sit?** One block of 45 to 60 minutes, with the phone, the OVH console and an admin PowerShell at hand.

## Sittings, announced

- **The block:** production's journey (about 10 minutes of yours, inside about 20), then staging's reinstall: about 15 minutes in the console, the `ubuntu` password in a terminal, the tunnel restart, and the new certificate (about 5 minutes).
- **The sign-off:** about 10 minutes of reading, after the gate; and the deletion of the two old certificates in the console.

## The answers given in the session

| Date        | Question                                       | Answer                                         |
| ----------- | ---------------------------------------------- | ---------------------------------------------- |
| 23 Nov 2026 | 1, production on `host-v0.9.2`                 | "lets do it"; then "i allow production deploy" |
| 23 Nov 2026 | 2, staging reinstalled and restored            | "we can do it as well"                         |
| 23 Nov 2026 | 5, the API key                                 | "key is ok to use"                             |
| 23 Nov 2026 | (not numbered) the field-day fix on production | "push the fix"                                 |
| 24 Nov 2026 | (Run 10.6) the 16 spike organizations          | "Retire them"                                  |
| —           | 3, no token-store command in the CLI           | not answered: the ruling P-171 stands          |
| —           | 4, the shape of the days                       | not answered: it ran as a day and a morning    |
| —           | 6, the coding agent for the real project       | not answered: only Claude Code is proven       |
| —           | 7, the sitting                                 | the sittings took place on 23 and 24 Nov       |

## The gate's message (24 Nov 2026)

Asked: **"merge", yes or no.** The answer is recorded here with its date.

**Answer, 25 Nov 2026:** "merge it". PR #24 merged into `main` by a merge commit. Gate F is not asked: it is decided at W-2.
