# D-80 — Session 11: automation access and long-lived runtime credentials, as a Stage 1 amendment

**Date:** 2026-11-25

**Status:** DECIDED by the owner on 2026-11-25, as read by the agent (see "Answer"). Evidence:

- `docs/plans/session-11-plan.md` ("The owner's decisions", P-183);
- `docs/mykey-automation-credential-spec.md` (the input specification);
- `docs/evidence/session-11/owner-requests.md`.

## Context

On 25 Nov 2026 the owner asked for a change of direction: MyKey gains an automation credential, a long-lived runtime credential that is exchanged for short-lived read tokens, and a metadata route for machines.

Stage 1, as it is written, excludes this work:

- Doc 10 §4.2 and Doc 04 FR-1.39 say a machine token is "default and maximum 30 days, non-renewable";
- Doc 02's Stage 1 exclusions name "autonomous credential mutation/delegation".

Stage 1 is open under Gate F HARDEN (D-74). Gate F is decided again at W-2 (20 Dec 2026), on 28 days of real use of the release production runs. The session is not one of Doc 10's nine and is not on D-74's hardening list.

## Decision

**Session 11 runs now, as an amendment of Stage 1, on staging only.** The eight answers:

1. **Placement:** now; staging only; production gets the new features after W-2.
2. **Runtime credential:** at most 365 days (default and maximum). There is no "no expiry".
3. **Automation credential:** 1 hour to 365 days, default 7 days. Bound addresses are mandatory: 1 to 8 CIDRs.
4. **`secrets.update` by automation:** not in this session.
5. **Credential material:** keyed verifiers in PostgreSQL. Nothing new is created in OpenBao: no identity, no policy, no right. The design and its hostile-API paragraph are D-81's.
6. **Production:** does not get the new features in this session.
7. **Cuts:** no assigning of an existing project to an automation credential; no staging restore drill of the new kinds (the restore is proven on real stores in the integration suite); the workspace checks a CIDR only when the server answers.
8. **The postgres pin** goes first, alone, as `host-v0.9.3`, to staging and then to production by `production.md`.

**What is amended, narrowly.** No `docs/doc_*.md` file is edited; this record amends them.

- **Doc 10 §4.2 and Doc 04 FR-1.39:** the 30-day machine token stays exactly as it is. A second kind is added beside it: a runtime credential that lives up to 365 days and is exchanged for a non-renewable token of 15 minutes.
- **Doc 02's Stage 1 exclusion** of "autonomous credential mutation/delegation": one exception. An automation credential, issued by a person with a fresh TOTP, may issue and revoke read-only runtime credentials for environments of projects it manages. It can never read a value.
- **Workload-identity federation** stays where Doc 02 puts it. Nothing here blocks it.

## Consequences

- **Gate F's evidence is untouched.** Production keeps the `host-v0.9.x` line it is observed on. A production fix before W-2 is cut from that line, not from `main`.
- **Gate F is not decided in this session.** It is W-2's.
- **The route freeze (D-15) is amended** in the session's one `contract:` commit: 41 routes become 57.
- **Decision numbers:** D-81 (the runtime credential, the exchange, the material), D-82 (the automation credential), D-83 (limits and lifetimes).
- **Carried, not built:** update by automation, assignment of existing projects, a staging restore with the new kinds, production on `host-v0.10.x` (dated: after 20 Dec 2026).

## Answer

"Start executing session 11" (the owner, 25 Nov 2026). The eight questions had been put to the owner with a recommendation each, and with the sentence that "all as recommended" is a complete answer. The owner changed none. **The agent reads the answer as "all as recommended"; the owner did not say those words.** Production's deploy for the pin is asked again before its first command.
