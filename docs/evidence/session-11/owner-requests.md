# Session 11 — requests to the owner

Written at the session start (25 Nov 2026). No value appears in this file. Eight answers were asked with the plan (`docs/plans/session-11-plan.md`, "The owner's decisions"); one sitting and a sign-off are announced.

## The eight questions

Each was asked with its options, what each costs, and a recommendation. "All as recommended" was offered as a complete answer.

1. **Where does this work sit?** Recommended: now, as a Stage 1 amendment, on staging only; production after W-2 (20 Dec 2026).
2. **The runtime credential's longest lifetime.** Recommended: 365 days, default and maximum; no "no expiry".
3. **The automation credential's lifetime, and bound addresses.** Recommended: 1 hour to 365 days, default 7 days; 1 to 8 CIDRs, mandatory.
4. **Automation updates an existing secret now, or later?** Recommended: later.
5. **Where the credential material lives.** Recommended: verifiers (keyed digests) in PostgreSQL, nothing new in OpenBao.
6. **Does production get this in the session?** Recommended: no.
7. **Four cuts:** no update by automation; no assigning an existing project; no staging restore drill of the new kinds; the workspace checks a CIDR only when the server answers. Recommended: all four.
8. **The postgres pin first, alone, as `host-v0.9.3`, on both hosts?** Recommended: yes.

## Sittings, announced

- **Production's journey for the pin** (question 8): about 10 minutes of yours inside about 20, by `production.md` (`--stay-closed`, your journey in the `tunnel verify --browser` window, `--owner-confirmed`). It is asked again before its first command.
- **The sign-off:** about 10 minutes of reading, after the gate.

## The answers given in the session

| Date        | Question          | Answer                                                                                                                                                                            |
| ----------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 25 Nov 2026 | 1 to 8, all eight | "Start executing session 11". No recommendation was changed. **The agent reads this as "all as recommended"**; the owner did not say those words. An answer may still be changed. |
| —           | 8, production     | The deploy itself waits for the owner's explicit yes before its first command.                                                                                                    |

## Asked during Run 11.8 and at the gate (26 Nov 2026)

| Date        | Asked                                                                                                                       | Answer                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 26 Nov 2026 | Claude Code stopped the staging pass for low memory: may it go on?                                                          | Yes. The laptop had shut down on low battery; Docker Desktop may be stopped, and the owner will close VS Code if asked.                                                            |
| 26 Nov 2026 | Plug the laptop in, and say "go" for `pnpm run test:consumers` (stopped for memory; about 15 minutes, alone, with Docker).  | "continue", with the laptop on mains power. **The agent reads it as the word for the rehearsal;** it is not read as a yes to the merge. The rehearsal ran: 2 files, 7 of 7, 731 s. |
| 26 Nov 2026 | The sign-off: merge PR #27, yes or no?                                                                                      | Not answered yet. Nothing is merged without it.                                                                                                                                    |
| 26 Nov 2026 | Two design questions the review left: a bound on what one automation credential makes; an audit row for `machine.metadata`. | Not answered yet. Both are lines of `known-limits.md`.                                                                                                                             |
