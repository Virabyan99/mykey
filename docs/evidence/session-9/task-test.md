# Task test — the owner on the new workspace (OWN-UX, P-163, H-06)

_On staging, on the release Run 9.0 Task I deployed there, with synthetic data only. The agent sends the seven tasks one at a time and runs nothing on staging during the test. Each task is timed from the message to the owner's answer, and marked "found unaided", "found with help search" or "not found", in the owner's own words._

The baseline is Run 8.8's walkthrough on the old page (`docs/evidence/session-8/walkthrough.md`): there, task 1 failed (the project id was only in the address) and task 6 needed the agent. This is a single-user usability observation (Doc 03 §9): one owner, one sitting.

## Staging

- Release: `host-v0.9.1` (`b19ca66`), gate epoch 336, after the owner's journey (`--owner-confirmed`)
- Start: 22 Nov 2026, after the v0.9.1 opening (task 1 restarted)

## The tasks

| #   | Task                                                           | Time        | Result        | The owner said                                           |
| --- | -------------------------------------------------------------- | ----------- | ------------- | -------------------------------------------------------- |
| 1   | Copy the project's id.                                         | about 1 min | found unaided | "done, found it in about a minute" (pasted the right id) |
| 2   | Get the commands to connect an application to `development`.   | about 30 s  | found unaided | "done, found it in about 30 seconds"                     |
| 3   | Find what "uncertain" means.                                   | about 1 min | found unaided | "done, found it in about a minute"                       |
| 4   | Revoke a machine credential.                                   | about 1 min | found unaided | "done, found it in about a minute"                       |
| 5   | Find who revealed a secret today.                              | about 1 min | found unaided | "done, found it in about a minute"                       |
| 6   | Find what to do after losing the phone with the authenticator. | about 1 min | found unaided | "done, found it in about a minute"                       |
| 7   | Find what the service does not do (the known limits).          | about 1 min | found unaided | "done, found it in about a minute"                       |

## Result

On `host-v0.9.1`, all seven tasks were found unaided, each in about a minute or less, with no help asked for. On the old page (Run 8.8) task 1 failed and task 6 needed the agent. OWN-UX: met on `host-v0.9.1`. It was not met on `host-v0.9.0`, whose finding is below.

## Findings

- **22 Nov 2026, about 07:40 UTC, on `host-v0.9.0`, before task 1.** The owner, after the reset and the first sign-in, said: "UI of the project got even worse, now i barely found how to create secret for my project and i am searching for 10 minutes and i cant even find how to create machine identity, all functionalities we had before is lost i cant find anything it so confusing".
  - **Cause, as the screens show:** the secrets, machine credentials and Connect live inside an environment. Their sidebar entries appear only once an environment is open, and the project page offers only "New environment", "Rename" and "Archive". The environment's name is a small link in a table, and nothing says that secrets and credentials are found there.
  - **The baseline was better on this point:** the old page reached them through one select.

A task that is "not found" is fixed before production, in `host-v0.9.1`, which is then built once and deployed to staging, with `workspace` run again.

## Production, first visit

22 Nov 2026, on `host-v0.9.1`. After enrolment, before the organization was provisioned, the page answered "Not possible in the current state". That was expected: the organization was still `provisioning`. The owner then created the first project and environment, entered the secret set and issued credentials with no question about where things are. The difficulty of the visit was the connect panel's token step (`run-9.2.md`, F-9.2-1), not the navigation.
