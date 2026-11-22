# Session 9 — requests to the owner

Written at the session start (22 Nov 2026). No value appears in this file. Five answers are asked now; four sittings are announced.

## Now: five answers

1. **May the new workspace go to production after Gate R (D-69)?** It may if its changes are limited to the page, its two new page paths, the restore code, host files, tools and documents; full CI, the canary scan and a fresh review are green; and the owner's task test passes. With "no", production opens on `host-v0.8.1` (valve 0).

   **Answered: yes** (the owner, 22 Nov 2026).

2. **May production get a field-report timer** (counts and timings only) and the deploys of this session?

   **Answered: yes** (the owner, 22 Nov 2026).

3. **Run 9.7's server:** staging's own, reinstalled by the owner on 24 Nov, or a temporary server.

   **Answered: staging's own** (the owner, 22 Nov 2026). D-73.

4. **The first real consumer:** which non-critical application, and where it runs. It should start or read its secrets at least once a day (P-166). It is called `consumer-1` in every file.

   **Answered: this workstation's WSL** (the owner, 22 Nov 2026). The connect panel's local tab is the one used.

5. **The Anthropic API key** for the agent experiment's container: a key with a spending limit of a few dollars, saved as `C:\Users\gmpar\.mykey\secrets\anthropic\api-key`, never pasted into the chat. Reply "key saved".

   **Done:** the key was saved before Run 9.4 (22 Nov 2026), and the experiment ran with it (`agent-experiment.md`).

## Sittings, announced

- **(b) The task test** (15 min, on staging): after `host-v0.9.0` is on staging. Seven tasks, one at a time (P-163).
- **(c) OWN-8** (about 75 min, the phone and the application at hand): production's bootstrap, enrolment and opening, then `consumer-1`, its rotation, its revocation and the leak check.
- **(d) Staging's reinstall** in the OVH console (about 15 min, plus the `ubuntu` password and the tunnel restart), on 24 Nov.
- **(e) Gate F:** read the exit dossier and sign ADVANCE, HARDEN, PIVOT or STOP.

## Gate F (OWN-9)

**Asked:** 22 Nov 2026, with `gate-f.md` and the corrected exit dossier: ADVANCE, HARDEN, PIVOT or STOP, and the merge of PR #23.

**Answered:** "HARDEN, and yes merge" (the owner, 22 Nov 2026, 21:12 UTC). D-74. Stage 1 stays open on the hardening list, and Gate F is decided again at W-2 (20 Dec 2026). PR #23 is merged.

**Sitting (d), staging's reinstall,** did not happen on 24 Nov: the re-drill is deferred to before 31 Dec 2026 (D-73).

## Also

GitGuardian's check on PR #23 is red on two synthetic test fixtures, not credentials:

- incident 40835003: a made-up OpenBao token shape in `tests/unit/web/copy.test.ts`, the input that the copy linter must flag;
- incident 40837234: hand-patterned UUIDs in `tests/unit/hosts/field-day.test.ts`.

Neither matches any host's id or token. The owner may dismiss both in the GitGuardian dashboard, with incident 39994924; nothing depends on them.
