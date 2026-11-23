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
