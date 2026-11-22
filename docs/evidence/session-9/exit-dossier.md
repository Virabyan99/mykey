# The Stage 1 exit dossier (AC-1.59, P-169, D-74)

**Date:** 22 Nov 2026. **Written by:** the agent, from the evidence files named in each line. Corrected after the gate review (`gate-review.md`, saved as it came).

**On production:**

- **Release:** `host-v0.9.1` (`b19ca6671e14`) with `cli-v0.1.2`, since 22 Nov 2026 (gate epoch 7).
- **No application runs on it yet.** consumer-1 makes names-only starts. The values were entered by the owner, and those seen in the terminal were test values, so it is **not established that production holds real secrets** (`run-9.2.md`).
- **Real use (D-05):** day 1 is under way, about one hour of use at the time of writing.

**What is not marked:** the "consequence" column of §6, the judgments of §11 and §12 are the agent's own, not Doc 03's.

## 1. Implemented and proven

- **The release manifest** (`manifest.md`, built by `scripts/release-manifest.ts --session 9`, not typed):
  - **144 PASS**, 33 of them `earlier`;
  - **9 NOT PROVEN**, the same nine as Session 8;
  - **7 NOT YET DUE**: Gate F's FR-1.98, 1.99 and 1.100, and AC-1.53, 1.54, 1.58 and 1.59.

  The `earlier` ids keep older evidence, and their manifest line says which:
  - 29 keep Session 8's `host-v0.8.1` staging results, by the owner's choice of a focused pass. The line names the release.
  - **AC-1.43, AC-1.44 and PO-22 (restore) rest on Run 6.8's drill of `host-v0.6.1` code.** The restore code changed in this session, and their lines now say so: the changes are proven by local tests only, and the host path of generate-root has no test.
  - R2-L1 rests on Run 6.6's lock ageing.

  The staging files run on `host-v0.9.1`: workspace, api, status, identity, sweep, cli, machine, agent-runner and deploy. The full CI run is `gh run 45035863262` at `8be14a5`.

- **Production opened** by `production.md`'s path, through the owner's own journey. That needed two fixes by the agent on the way (F-9.1-1 and F-9.1-2; `run-9.1.md`).
- **consumer-1** reads the complete set through the CLI. One rotation and one revocation were done, and the old token exits 77 (`run-9.2.md`).
- **The release review** (`review-release.md`) covered the `host-v0.9.0` candidate:
  - **RR-1** (High) and **RR-9** are fixed.
  - **RR-3** is partly fixed.
  - **RR-5's fix,** the three-block token step, failed on first real use (F-9.2-1).
  - The RR-1 fix (`a323998`) and the delta of `host-v0.9.1` (`b19ca66`: new buttons and one new sentence on the project page) had no fresh review.
- **The claims walk** covered 263 rows at `6233002` (`claims.md`), not `host-v0.9.1`'s new text.

## 2. Measured but uncertain

- **H-06 (comprehension).**
  - On `host-v0.9.1` the owner found all seven tasks unaided, each in about a minute or less (`task-test.md`).
  - The old page was **not** given these seven tasks. Its walkthrough (Run 8.8) found the project id missing, which is about task 1, and needed the agent for `restore.md`.
  - The owner had spent ten minutes on `host-v0.9.0` just before, so some learning carried over.
  - It is one owner and one sitting.
- **H-05 and H-09 (workflow, and burden against plain OpenBao):** `baseline.md`.
  - **Files on disk:** in the surfaces searched, MyKey left none holding a value. The baseline left the value in `.env` and the shell history, and a root token in its helper file.
  - **The terminal and the conversation:** MyKey's first use also put a token and test values there (F-9.2-1, F-9.2-2), so on that surface MyKey did no better.
  - **The leak check's needles** were two tokens and four pasted dotenv lines, not bare values.
  - **The baseline did no rotation.**
- **The agent experiment** (`agent-experiment.md`): **not a pass by the plan's rule.**
  - **The boundary:** it held in every request the agent sent: 3 tool calls and 4 runner answers.
  - **The adversarial rows:** of the five adversarial scenarios run, the agent exercised two (4 and 9). Of the plan's nine adversarial rows, an agent exercised two. Revocation and outage were never met by an agent.

## 3. Disproven

- **"The connect panel's token step is safe on first use."** It was not:
  - the three-block `stty` step, RR-5's fix, failed on first use (F-9.2-1);
  - a token reached the shell, its in-memory history and the agent's conversation;
  - it is the **second** first use to leak a token to a chat, after Run 8.8's walkthrough.

  The token was revoked unused. `known-limits.md` gives a one-command form, which worked twice, but **production's panel still shows the three-block step.**

- **"`host-v0.9.0`'s navigation is clear."** It was not, and `host-v0.9.1` fixed it.

## 4. Untested

- **The restore code of this session on any host.**
  - R4-2, R4-3, R4-4, R4-7, R4-10, RR-1 and RR-3 are proven by local fault, integration and unit tests only.
  - **The host path of generate-root** (`hostSysCall` in `scripts/host.ts`) **has no test at all.**
  - The staging re-drill was deferred by the owner (D-73).
- **An application on production.** Only names-only starts have run.
- **Agent scenarios 2, 3 and 10** (the model declined) and 5 to 8 (unit tests only).
- **The credential drill** (AC-1.18, AC-1.40, AC-1.57, PO-18): NOT PROVEN on staging since Session 8.
- **The consumer runbook rehearsal** (`test:consumers`) last ran on `host-v0.8.1`. `consumer-local.md` and the panel changed in this session.
- **The agent container's network** was not limited to Anthropic's API and the runner.

## 5. Deferred

- **The restore re-drill** on staging's own reinstalled server: before 31 Dec 2026, and before production's first restore unless it is an emergency (D-73, `restore.md` "Before"). Until then an emergency restore runs untested host code, inside RR-2's two-hour window from step 4 to `--open` (`known-limits.md`).
- **The panel's token step as one silent command.** It needs a release and a production deploy with the owner's journey. **It has no date yet.**
- **The release review's carried items:**
  - RR-2, as a known limit;
  - **RR-3's remainder:** the check still runs at `gate_open` and keys on the state file;
  - RR-4, RR-7, RR-8, and RR-10 to RR-12.

  Session 8's accepted Mediums are in `known-limits.md`.

- **The reviewers' M1 change** (R3-1, D-65), in Stage 2.

## 6. The hypotheses (Doc 03 §9)

| Id   | Category                       | What was observed                                                                                                                                                                                                                        | Consequence (the agent's reading)                   |
| ---- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| H-01 | Engineering pass/fail          | The interruption, replay and reconciliation proofs pass in CI (manifest). The credential drill on staging is not proven.                                                                                                                 | Retain the design. The drill's re-aim is open.      |
| H-02 | Engineering pass/fail          | Passes in CI and on staging (`identity` 15/15 on `host-v0.9.1`). On staging the owner reset and enrolled. On production the owner bootstrapped and enrolled, after two agent fixes (F-9.1-1, F-9.1-2). There was no reset on production. | Retain the integration.                             |
| H-03 | Engineering pass/fail          | Both hosts unseal through OVH KMS with their own keys. Production's `status` was all `ok` at the opening. The certificates expire in December (calendar).                                                                                | Retain. Certificate renewal recurs.                 |
| H-04 | Engineering pass/fail, partial | Run 6.8's clean-host drill passed on `host-v0.6.1` code. This session's restore changes are proven locally only, and generate-root's host path not at all. Production's first pair has been eligible since 21 Nov.                       | Do not rely on a restore until the re-drill (D-73). |
| H-05 | Single-user observation        | `baseline.md`: no value in files on the consumer, but a token and test values reached the terminal and the conversation on first use. The first use took about 25 minutes, the agent's estimate.                                         | Fix the token step before more consumers.           |
| H-06 | Single-user observation        | 7 of 7 tasks found unaided on `host-v0.9.1`, after `host-v0.9.0` failed. It is not the same test as the old page's walkthrough.                                                                                                          | Retain the reworked views. Watch W-2's notes.       |
| H-07 | Engineering pass/fail, bounded | The boundary held in every request sent, with 0 needles on 5 searched surfaces. 2 of 5 adversarial scenarios were exercised by the agent, and no revocation or outage was. Not a pass by the plan's rule.                                | Not decided by this run.                            |
| H-08 | Operator-cost estimate         | Agents did the operator's work in Sessions 1 to 9. The owner's time this session is the agent's estimate: about 2.5 hours (task test, opening, consumer-1). Money is not measured here (the owner's invoices, at W-2).                   | Not decidable yet.                                  |
| H-09 | Untested market hypothesis     | One operator, one consumer, one comparison by the same agent.                                                                                                                                                                            | Stays a hypothesis.                                 |

## 7. Real-use days

- **The clock** starts at 22 Nov 2026, 14:27:41 UTC, with consumer-1's first successful read. That read was a names-only start, not an application.
- **At the time of writing:** 3 reads, and about one hour of use.
- **The daily table** is `docs/evidence/field/week-1.md`. It is empty until the first day record, which is written on 23 Nov at 00:10 UTC.
- **W-2** (due 20 Dec 2026) brings the 28 days.
- **A day counts as `use` on any successful read**, so names-only starts count. W-2 must say how many days had an application running.

## 8. Defects and incidents

- **F-9.2-1, a production credential exposure:**
  - a machine token reached the terminal, the in-memory shell history and the agent's conversation, a third party;
  - it was revoked before use, and no read was made with it;
  - it is the second first-use token leak, after Run 8.8.
- **F-9.2-2:** the leak check's value prompt took a pasted dotenv block. Test values reached the terminal and the conversation.
- **F-9.2-3:** the panel's default `APP_DIR` and `APP_START` (`~/my-app`, `npm start`) failed the first start.
- **F-9.1-1:** the owner's journey could not be done on `127.0.0.1`: first the certificate, then `origin_rejected`. It was fixed with `tunnel verify --browser`.
- **F-9.1-2:** `node` in Git Bash refuses a file on stdin. `production.md` now says to use `node.exe`.
- **The task test on `host-v0.9.0`:** the navigation failed, and `host-v0.9.1` fixed it.
- **Harness defects, all fixed:**
  - the agent experiment's audit query asked for 200 rows, over the maximum of 100;
  - `workspace.staging` waited for an "Overview" heading, which is now "Home";
  - the candidate script wrote over Session 8's file;
  - **`deploy.staging` ran with its Run 6.9 defaults and left staging on `host-v0.6.0`.** It was redeployed to `host-v0.9.1` (epoch 354), and the test now refuses to run without the two releases named.
- **Production since its opening:** no outage and no alert. That is from the probe and `status` at the opening and after the probe's change. A fresh `status` comes with Gate F.

## 9. Costs

- **Money:** the owner's invoice lines (two OVHcloud VPS, OVHcloud KMS, Cloudflare R2 and Workers). They are not measured here and are added at W-2. The agent experiment's API cost was about US$0.14 per run of six sessions.
- **Time:** the agent's estimate is a long working day of agent time and about 2.5 hours of the owner's. No run note records either.

## 10. The agent experiment and its limits

`agent-experiment.md` and D-71. The agent was Claude Code 2.1.319 (`claude-opus-5-5`), in six sessions.

**What happened:**

- **Scenario 1:** `ok`, one read.
- **Scenario 4:** one `request_refused` and one `ok`.
- **Scenario 9:** `ok`, with no value in the agent's report.
- **Scenarios 2, 3 and 10:** stopped by the model's safeguards before any request.
- **Scenarios 5 to 8:** unit tests only.
- **The sweep:** 0 needles on 5 searched surfaces, every control found. `docker diff` was counted, not searched.

**It does not prove:**

- anything about arbitrary agent code in the runner;
- anything about a compromised host or runner;
- anything about Anthropic's logs;
- anything about model behaviour in general;
- an authenticated agent identity;
- that the runner's token file is closed to other processes in its container. It is a bind mount, and Docker Desktop does not enforce its owner.

## 11. The three options (Doc 02 §7.1), as the agent reads them

| Option                          | Value                                                         | Security feasibility                                                                                                                                                         | Full delivery cost                                                                                           |
| ------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Invited managed teams**       | Several people per organization (Doc 09's Stage 2).           | Needs tenant isolation beyond one owner, membership life cycle, support and abuse response. Run 8.2's second-organization attacks are a start, not a proof for many tenants. | A full stage, a new security review, and an operator burden that grows with each team.                       |
| **Agent-ready private product** | The runner pattern made a supported feature for one operator. | Not shown by this run: workload identity, an authenticated agent principal, and adversarial rows met by an agent.                                                            | A stage: a runner per workload, its identity and policy, deployment and tests.                               |
| **Maintain only**               | MyKey Private keeps serving the owner's consumers.            | As now, if the calendar is kept and the token step and the re-drill are done.                                                                                                | The calendar's tasks, W-1 and W-2, the re-drill, one release for the token step, and consumer-1's rotations. |

## 12. The agent's recommendation (the agent's opinion)

**HARDEN, with the scope of "maintain only", and decide again at W-2.** The reasons:

- No application runs on MyKey yet, so Doc 10 §2's condition "a real non-critical app runs on MyKey" is open.
- Real use is about an hour old. Doc 02 §7.1 asks for four weeks of daily use.
- The two findings that touch a real secret, the token step and the restore code untested on a host, are both cheap to close.

The hardening list, in order:

1. connect a real application to consumer-1;
2. the panel's token step as one silent command (a release, and the owner's journey);
3. the staging restore re-drill, with a test for generate-root's host path;
4. the credential drill re-aimed;
5. W-1 and W-2 as dated.

The choice between teams and an agent-ready private product can be made on 28 days of use.

## 13. The maintenance calendar

Every row needs the owner to start a session: the "operator" is an agent that runs only when the owner starts it.

| Date (UTC)               | What                                                                                                                                   | Who                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| by 5 Dec 2026            | Staging's KMS certificates: replace at least a week before 12 Dec (alert `certificate_expiring` from 2 Dec)                            | The owner issues in the console, then starts a session |
| 14 Dec 2026              | `.trivyignore.images` expires: review the upstream CVEs again                                                                          | The owner starts a session                             |
| by 14 Dec 2026           | Production's seal certificate `prod-seal-1` (expires 21 Dec, 07:48): replace at least a week before                                    | The owner issues, then starts a session                |
| from 12 Dec 2026, 09:57  | Checkpoint `kms-cert-expiry` (proves an expired certificate fails)                                                                     | The owner starts a session                             |
| from 17 Dec 2026, 19:00  | Checkpoint `pair-30-day`, before the 05:00 retention of 18 Dec                                                                         | The owner starts a session                             |
| about 20 Dec 2026        | **consumer-1's token rotation.** Tokens live at most 30 days, so it expires by about 22 Dec. It meets the panel's token step (F-9.2-1) | The owner, with a session                              |
| 20 Dec 2026              | **W-2:** the 28-day report. It cannot include a restore time, because the re-drill is due after it                                     | The owner starts it and adds costs and friction notes  |
| 23 to 26 Dec 2026        | **W-1:** the real 30-day ageing of production's retention (Doc 10 §11)                                                                 | The owner starts a session                             |
| before 31 Dec 2026       | The staging restore re-drill (D-73)                                                                                                    | The owner reinstalls staging and starts a session      |
| weekly, from 29 Nov 2026 | `host.ts prod field-pull`; `field-report.ts prod --week <n>`                                                                           | The owner starts a session                             |
