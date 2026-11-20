# Session 8 — requests to the owner

Written at the session start (20 Nov 2026). No value appears in this file. One answer is asked now; four moments are announced.

## 1. Now: may production be changed in this session?

**Answered: yes** (the owner, 20 Nov 2026, at the session start).

With "yes", production gets its corrected host files, its own KMS domain, user, policy, key and certificate, OpenBao initialised and unsealed by that key, its custody set, its backup material and timers, and the release candidate deployed with `--stay-closed`. It gets no account, no organization and no data, and it stays `inService: false` in the probe (plan P-146, decision record D-64). With "no", production is not touched, scope valve 1 is taken, and Gate R says so above the signature line.

## 2. Today or tomorrow morning: the KMS console for production (about 20 minutes, twice)

A domain, a user, a policy, and a certificate from a request the agent prints; later, two rights (`create`, `activate`) removed from the policy. The agent sends the exact steps of `kms-and-unseal.md` when the operator tool can do production's part (Run 8.0 Task B). Afterwards: production's custody files (`~/.mykey/custody/prod/`) copied into the password manager, as OWN-4 was for staging.

## 3. After the freeze: one hour (OWN-6)

The first-run walk of Run 8.8 on staging, with an authenticator application and WSL at hand. The agent says when staging is ready and runs nothing on staging during that hour.

## 4. At the end (OWN-7)

Read `docs/evidence/session-8/gate-r.md`, answer "approved" or not, and say "merge".

## 5. Only if the agent says so

The repository secret `PROBE_READ_TOKEN`, needed again only when `probe.ts secrets` has to run.

## Also

GitGuardian's false positive (incident 39994924) may be dismissed by the owner at any time; nothing depends on it.
