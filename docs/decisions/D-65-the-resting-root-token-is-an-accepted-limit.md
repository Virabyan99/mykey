# D-65 — The resting root token (M1) is an accepted limit of Stage 1, unless a reviewer rates it high

**Date:** 2026-11-20

**Status:** DECIDED (plan P-148), pending one input: reviewer 3's rating in Run 8.5. If that rating is high or critical, the "If the reviewer rates it high" section below applies, and this record is amended in Run 8.6. Evidence:

- the sweep, `tests/staging/sweep.staging.test.ts`: the root token is one of its needles on every surface of the staging host;
- `docs/evidence/session-8/run-8.4.md` and `run-8.4-sweep.txt`.

## Context

Session 6's review found M1, a Blocker candidate: the file `openbao-init.json` in the workstation's custody (`~/.mykey/custody/<host>/`) holds OpenBao's root token, which never expires. Session 6's Step 5 stopped for want of a design. Two designs are possible:

1. **Revoke the root token and make one per use** with `generate-root`. The recovery key would still rest in the same file, and the recovery key makes a root token whenever it is wanted. The workstation's custody stays the root of trust, as `known-limits.md` already says of one operator and one workstation. The design changes `opsRootToken`, the deploy's `withAdmin` and the restore. That is two days before the gate, and the restore is frozen (P-150).
2. **Keep the token, and prove where it is not.** It must not be on any surface of a host, in a log, a dump, a backup, a process's arguments or environment, an operator's view or a shell history.

## Decision

- **The resting root token is an accepted limit of Stage 1.** It lives only in workstation custody (the file and the owner's password manager, OWN-4) and is read only by the operator tool, which sends it on stdin or through a tunnel's header.
- **The sweep searches for it everywhere.** The root token is a needle of Run 8.4's sweep, on every surface of the staging host and of the workstation, with a control on each surface that travels as the needles do. The sweep runs again on the candidate (Run 8.7). A root token found on any surface is a finding of Run 8.6, and this record no longer holds.
- **Reviewer 3** (Run 8.5) is asked whether this blocks real, non-critical secrets.
- **Gate R's report** names the limit above the signature line.

## If the reviewer rates it high or critical

In Run 8.6:

- `opsRootToken` and the deploy's `withAdmin` take a root token made per use with `generate-root` and revoke it at the end of the command;
- the restore keeps its own token (P-150);
- the recovery key stays in custody.

## Consequences

- **Who holds the root of trust:** anyone who holds the workstation's custody, or the owner's password manager, holds OpenBao's root on that host. This was true before this decision and stays true after either design: the recovery key alone is enough.
- **What the sweep shows:** it shows where the token is not. It cannot show the workstation's own exposure (its disk, its backups, OneDrive). Custody lives outside OneDrive (CLAUDE.md), and that is the protection.
- **Revocation:** a token made per use (the design above) remains the step to take before anything more than non-critical secrets is stored. That is Stage 2's to decide.
