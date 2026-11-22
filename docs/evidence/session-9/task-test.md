# Task test — the owner on the new workspace (OWN-UX, P-163, H-06)

_On staging, on the release Run 9.0 Task I deployed there, with synthetic data only. The agent sends the seven tasks one at a time and runs nothing on staging during the test. Each task is timed from the message to the owner's answer, and marked "found unaided", "found with help search" or "not found", in the owner's own words._

The baseline is Run 8.8's walkthrough on the old page (`docs/evidence/session-8/walkthrough.md`): there, task 1 failed (the project id was only in the address) and task 6 needed the agent. This is a single-user usability observation (Doc 03 §9): one owner, one sitting.

## Staging

- Release: (filled in at the test)
- Start: (UTC)

## The tasks

| #   | Task                                                           | Time | Result | The owner said |
| --- | -------------------------------------------------------------- | ---- | ------ | -------------- |
| 1   | Copy the project's id.                                         |      |        |                |
| 2   | Get the commands to connect an application to `development`.   |      |        |                |
| 3   | Find what "uncertain" means.                                   |      |        |                |
| 4   | Revoke a machine credential.                                   |      |        |                |
| 5   | Find who revealed a secret today.                              |      |        |                |
| 6   | Find what to do after losing the phone with the authenticator. |      |        |                |
| 7   | Find what the service does not do (the known limits).          |      |        |                |

## Findings

A task that is "not found" is fixed before production, in `host-v0.9.1`, which is then built once and deployed to staging, with `workspace` run again.

## Production, first visit

(Run 9.1: the owner's words on the first visit to production's workspace, if any of them is like a failure above.)
