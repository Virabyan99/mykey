# The Stage 1 exit dossier (AC-1.59, P-169, D-74)

**Date:** 22 Nov 2026. **Release serving real data:** `host-v0.9.1` (`b19ca6671e14`) with `cli-v0.1.2`, on production since 22 Nov 2026 (gate epoch 7). **Real-use days so far:** 1, starting on 22 Nov 2026 (D-05). **Written by:** the agent, from the evidence files named in each line. Where the agent gives an opinion, it is marked as the agent's.

## 1. Implemented and proven

- **The release manifest** (`docs/evidence/session-9/manifest.md`, built by `scripts/release-manifest.ts --session 9` and not typed) gives **144 PASS**, 33 of them `earlier`; **9 NOT PROVEN**, the same nine as Session 8; and **7 NOT YET DUE**, Gate F's FR-1.98, 1.99 and 1.100 and AC-1.53, 1.54, 1.58 and 1.59, which Gate F decides on this dossier.
  - The ids not run again on `host-v0.9.1` keep Session 8's `host-v0.8.1` staging results, marked `earlier` with that release on their line. That was the owner's choice of a focused pass.
  - The staging files run on `host-v0.9.1`: workspace, api, status, identity, sweep, cli, machine, agent-runner, deploy (`results.json`).
  - CI: the full run of the ready pull request #23 (`results.json`, `ci`).
- **The product in real use:** production opened by `production.md`'s path, through the owner's own journey (`run-9.1.md`). consumer-1 reads the complete set through the CLI. One rotation and one revocation were done, and the old token exits 77. The leak check found 0 on every surface (`run-9.2.md`).
- **The workspace's rework** (D-70): the owner's seven tasks were found unaided, each in about a minute or less, on `host-v0.9.1` (`task-test.md`). On the old page, task 1 failed and task 6 needed the agent (`session-8/walkthrough.md`).
- **The release review** (`review-release.md`) found one High, RR-1, and fixed it before the release.
- **The claims walk:** 263 rows (`claims.md`).

## 2. Measured but uncertain

- **H-06 (comprehension):** one owner, one sitting. The first build of the rework (`host-v0.9.0`) failed the owner's first look, because machine credentials could not be found. `host-v0.9.1` passed the tasks the same day. One user is an observation, not a study.
- **H-05 and H-09 (developer workflow, burden against plain OpenBao):** `baseline.md`. On disk, MyKey left no value where the leak check looks. The baseline left the value in 3 files and a root token in a fourth. But MyKey's first use was slower and had one serious mistake, F-9.2-1.
- **The agent experiment** (`agent-experiment.md`): the runner's boundary held in every request the agent sent. Three of the six adversarial rows were not exercised (below).

## 3. Disproven

- **"The connect panel's token step is safe on first use."** It was not. The three-block `stty` step failed, and a token reached the shell, its history and the conversation (F-9.2-1). The token was revoked unused. `known-limits.md` gives the one-command form, which worked twice. The panel itself has not been changed yet.
- **"`host-v0.9.0`'s navigation is clear."** It was not (`task-test.md`, finding before task 1). It was fixed in `host-v0.9.1`.

## 4. Untested

- **The restore fixes on a real host.** R4-2, R4-3, R4-4, R4-7, R4-10, RR-1 and RR-3 are proven by local fault and integration tests only. The staging re-drill (Run 9.7 Task B) was deferred by the owner (D-73).
- **Agent scenarios 2, 3 and 10** (another scope; `env` and the token file; ten attempts at a value). The model's own safeguards stopped those sessions before any request. The runner's refusal of those shapes is proven by its unit tests and its staging seed test, not by an agent. Scenarios 5 to 8 ran as unit tests only.
- **The credential drill** (AC-1.18, AC-1.40, AC-1.57, PO-18): NOT PROVEN on staging since Session 8. A pause sent over SSH cannot hit the one-call window. It stays in the manifest's NOT PROVEN list.
- **The agent container's network** was not limited to Anthropic's API and the runner.

## 5. Deferred

- **The restore re-drill on staging's own reinstalled server:** before 31 Dec 2026, and before production's first restore (D-73, `restore.md` "Before").
- **The panel's token step as one silent command:** in the next release.
- **The reviewers' Mediums carried from Session 8** (`known-limits.md`), and the release review's RR-2, RR-4, RR-7, RR-8 and RR-10 to RR-12 (`review-release.md`, "Disposition").
- **The reviewers' M1 change** (R3-1, D-65): a dated root token, and the recovery share out of the workstation's file (Stage 2).

## 6. The hypotheses (Doc 03 §9)

| Id   | Category                       | What was observed                                                                                                                                                                                                               | Consequence (Doc 03 §9)                                           |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| H-01 | Engineering pass/fail          | The operations engine's interruption, replay and reconciliation proofs pass in CI (manifest). The credential drill on staging is not proven.                                                                                    | Retain the design. The drill's re-aim is open.                    |
| H-02 | Engineering pass/fail          | Sign-in, two factors, resets, step-up and sessions pass in CI and on staging (`identity` 15/15 on `host-v0.9.1`). The owner enrolled, reset and signed in on both hosts without help.                                           | Retain the integration.                                           |
| H-03 | Engineering pass/fail          | Both hosts unseal through OVH KMS with their own keys. Production opened and reports every status check `ok`. The certificates expire in Dec 2026 (calendar).                                                                   | Retain. Certificate renewal is a recurring operator task.         |
| H-04 | Engineering pass/fail, partial | Run 6.8's clean-host drill passed on the earlier code. Session 9's restore fixes are proven locally only. Production's first pair has been eligible since 21 Nov. W-1 checks the real 30-day ageing.                            | Keep the mechanism. Re-drill before relying on it (D-73).         |
| H-05 | Single-user observation        | `baseline.md`: no value left on the consumer, against 3 files for plain OpenBao. The first use took about 25 minutes, with one token exposure (F-9.2-1).                                                                        | Improve the token step. The launch workflow stays.                |
| H-06 | Single-user observation        | 7 of 7 tasks found unaided on `host-v0.9.1`, after `host-v0.9.0` failed the owner's first look.                                                                                                                                 | Retain the reworked views. Watch for friction in W-2's notes.     |
| H-07 | Engineering pass/fail, bounded | The runner's boundary held. 0 needles on 6 surfaces. Three adversarial rows were not exercised (the model declined).                                                                                                            | The runner pattern stands. Workload identity is not shown (D-71). |
| H-08 | Operator-cost estimate         | Operator time: Sessions 1 to 9 by agents. In Session 9, the owner spent about 2.5 hours: the task test, the opening and consumer-1. Hosting, KMS and R2 costs are the owner's invoice lines, not measured here (W-2 adds them). | Not decidable yet. W-2.                                           |
| H-09 | Untested market hypothesis     | One operator, one consumer, one comparison by the same agent. No market evidence.                                                                                                                                               | Stays a hypothesis.                                               |

## 7. Real-use days

The clock starts at 22 Nov 2026, 14:27:41 UTC, with consumer-1's first successful read (`machine.resolve success`, 3 reads on day 1). The daily table is `docs/evidence/field/week-1.md`, built from the host's day records. The first record is written on 23 Nov at 00:10 UTC, so the table is empty at this writing. W-2 brings the 28 days (due 20 Dec 2026).

## 8. Defects and incidents

- **F-9.2-1 (Medium, by effect):** a machine token was exposed on first use: in the terminal, the in-memory shell history and the agent's conversation. It was revoked before use, and no read was made with it.
- **F-9.2-2:** the leak check's value prompt took a pasted dotenv block. Test values reached the terminal and the conversation, and the history was cleared.
- **F-9.1-1:** the owner's journey could not be done on `127.0.0.1`: certificate, then `origin_rejected`. It was fixed with `tunnel verify --browser`, which production then opened through.
- **F-9.1-2:** `node` in Git Bash refuses a file on stdin (winpty). Nothing was created, and `production.md` now says to use `node.exe`.
- **The task test on `host-v0.9.0`:** navigation failed; it was fixed in `host-v0.9.1`.
- **The release review:** RR-1 (High) and RR-3, RR-5, RR-9 fixed; the rest carried (`review-release.md`).
- **Harness defects:**
  - the agent experiment's audit query asked for 200 rows, over the maximum of 100;
  - `workspace.staging` waited for an "Overview" heading that is now "Home";
  - the candidate script wrote over Session 8's file.
    All three are fixed.
- **No incident on production** since its opening: `status` all `ok`, and the probe has nothing open.

## 9. Costs

- **Money:** the owner's invoice lines (two OVHcloud VPS, OVHcloud KMS, Cloudflare R2 and Workers, and the API key for the experiment, about US$0.14 per run of six sessions). These are entered by the owner at Gate F and are not measured here.
- **Operator time:** this session took about 10 hours of agent time and about 2.5 hours of the owner's (the run notes).

## 10. The agent experiment and its limits

`agent-experiment.md` and D-71.

**What happened:** six sessions of Claude Code 2.1.319 (`claude-opus-5-5`) against a runner that holds the token.

- Scenarios 1, 4 and 9 reached the runner. Their four requests got four enum answers, and the machine reads matched the `ok` answers exactly.
- Scenarios 2, 3 and 10 were stopped by the model's safeguards before any request.
- The sweep found 0 needles, and every control was found.

**What it does not prove:**

- anything about arbitrary agent code in the runner;
- anything about a compromised host or runner;
- anything about Anthropic's own logs;
- anything about model behaviour in general;
- an authenticated agent identity: the requester id is the harness's attribution.

## 11. The three options (Doc 02 §7.1)

| Option                          | Value                                                                                  | Security feasibility                                                                                                                                                                                       | Full delivery cost                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Invited managed teams**       | Several people per organization. Doc 09's Stage 2.                                     | Needs tenant isolation beyond one owner, membership life cycle, support and abuse response. The second-organization attacks of Run 8.2 are a start, not a proof for many tenants.                          | A full stage: roles and invitations end to end, per-tenant operations, support, and a new security review. The operator's burden grows with each team. |
| **Agent-ready private product** | The runner pattern of Run 9.4 made a supported feature, for one operator's own agents. | The boundary held for the requests made. Workload identity, an authenticated agent principal and the adversarial rows by an agent are not shown. The runner would become product code with its own review. | A stage: a runner per workload, its identity and policy, its deployment and its tests, plus the D-71 limits closed.                                    |
| **Maintain only**               | MyKey Private keeps serving the owner's consumers.                                     | As now. The calendar below must be kept, and the deferred re-drill and the token step must be done.                                                                                                        | The calendar's tasks (certificates, scan exceptions, checkpoints), W-1 and W-2, the re-drill, and one small release for the token step.                |

## 12. The agent's recommendation (the agent's opinion)

**Maintain only, with a short hardening list, and decide at W-2 rather than today.** The reasons:

- Real use is one day old, and Doc 02 §7.1 asks for four weeks of daily use before Gate E1.
- The two findings of this session that touch a real secret (F-9.2-1, and the restore fixes proven locally only) are both cheap to close.
- Neither the teams option nor the agent option has the evidence its stage would need: one tenant user, and an agent experiment with half its adversarial rows not exercised.

The hardening list:

1. the panel's token step as one silent command;
2. the staging restore re-drill;
3. the credential drill re-aimed;
4. W-1 and W-2 as dated.

At W-2 the choice between teams and an agent-ready private product can be made on 28 days of use.

## 13. The maintenance calendar

| Date (UTC)               | What                                                                                          | Who                                             |
| ------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| from 12 Dec 2026, 09:57  | Staging's KMS certificates expire on 12 Dec (seal at 10:50): replace (`kms-and-unseal.md`)    | The owner issues, the operator installs         |
| 14 Dec 2026              | `.trivyignore.images` expires: review the upstream CVEs again                                 | Operator                                        |
| from 17 Dec 2026, 19:00  | Checkpoint `pair-30-day`, before the 05:00 retention of 18 Dec                                | Operator                                        |
| 20 Dec 2026              | **W-2:** the 28-day report (four weekly reports, the daily table, incidents, costs, friction) | Operator builds; the owner adds costs and notes |
| 21 Dec 2026, 07:48       | Production's seal certificate `prod-seal-1` expires: replace before                           | The owner issues, the operator installs         |
| 23 to 26 Dec 2026        | **W-1:** the real 30-day ageing of production's retention (Doc 10 §11)                        | Operator; the owner reads                       |
| before 31 Dec 2026       | The staging restore re-drill (D-73), on staging's own reinstalled server                      | The owner reinstalls; the operator runs it      |
| weekly, from 29 Nov 2026 | `host.ts prod field-pull`; `field-report.ts prod --week <n>`                                  | Operator                                        |
| 17 Feb 2027              | Production's public certificate (renewed by the edge automatically; watched by `status`)      | Automatic; the probe alerts                     |
