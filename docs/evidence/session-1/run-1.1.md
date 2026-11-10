# Run 1.1 — Decisions and owner kick-off

## What was done

- Created the Git repository; imported `docs/` unchanged on `main`; opened branch `session-1`.
- Wrote decision records D-01 … D-11 from Doc 10 §3 (Decision and What-it-changes text copied verbatim by script). Status of each: `ASSUMED — awaiting owner`. D-01 records Day 1 = 10 November 2026.
- Generated the operations SSH key pair (ed25519, comment `mykey-ops`) outside the repository and outside OneDrive; started `docs/runbooks/credential-custody.md`.
- Sent the owner the kick-off message (text kept in `owner-kickoff.md`) and continued with Run 1.2.

## Commits

- `c6f52f4` docs: import specification documents 01-10 and session 1 plan (on `main`)
- this commit: docs: decision records D-01..D-11 and owner kick-off

## Commands and results

| Command | Exit | Proof line |
| --- | --- | --- |
| `git init -b main` + first commit | 0 | `c6f52f4 docs: import specification documents 01-10 and session 1 plan` |
| `ls docs/decisions` | 0 | eleven files `D-01-fourteen-day-timebox.md` … `D-11-owner-and-agent-duties.md` |
| `ssh-keygen -t ed25519 -C mykey-ops -f ~/.mykey/ssh/mykey_ops_ed25519 -N ""` | 0 | public key ends `…Gly8qBal mykey-ops` |

## Deviations and decisions

- `.gitignore` and `.gitattributes` were committed together with the imported documents in the first commit (the plan lists them in the same step).
- The run note template has one extra companion file, `owner-kickoff.md`, so the exact text sent to the owner is on record.

## Open issues

- OWN-1 reply outstanding: confirmation of D-01…D-11 (D-04 and D-05 by name) and the five questions. Defaults apply from the end of Run 1.2 (repository `mykey`, P-records absent, decisions assumed).
- OWN-2 (two servers) needed by the start of Run 2.5; OWN-3 (KMS activation) needed by Run 2.7.
