# D-84 — A second agent guide, for provisioning by a script

**Date:** 2026-11-26

**Status:** DECIDED (owner, 26 Nov 2026: "update them"). Amends D-79. Evidence: `llms.txt`, `docs/agents/provision-with-automation.md`, `tests/unit/agents/automation-guide.test.ts`, `README.md`.

## Context

D-79 gave agents two files: `llms.txt` and one guide, which makes an application start from MyKey. Session 11 added a second job an agent can be given: write or run a script that creates projects, environments, secrets and runtime credentials with an automation credential (D-82).

After Session 11 the entry points did not say so. `llms.txt` led only to the first guide, the README described machine credentials as a 30-day token and the project as ten sessions, and `automation.md` is a runbook written for the operator. It names no step as the human's, so an agent that read it would have no rule for the automation secret.

## Decision

1. **A second guide, `docs/agents/provision-with-automation.md`,** for that one job. The first guide is unchanged and still stands alone.
2. **The rule comes first, as in D-79,** and covers three things: an automation secret, a runtime credential's client secret, and a secret value. The agent writes the code that carries them and never sees them.
3. **Two steps are the human's,** each a message with a fixed id: `store-automation-secret` and `replace-automation-secret`. The command that stores the secret is the runbook's block, byte for byte.
4. **`llms.txt` keeps one link under "Guide".** The second guide has a section of its own, "Provisioning by a script", with one link and the words "only if your job is". An agent with the usual job still meets one guide.
5. **The guide is kept equal to the code by a test:** its ten routes with method, path and right are the contract's, its rights are `AUTOMATION_RIGHTS`, its numbers are `LIMITS`', and no block outside "Never" shows a file that holds a secret.
6. **The README says what Session 11 added,** with the contract's numbers, and that production does not have it yet.

## What it does not prove

- **No agent has been run from the second guide.** D-79's guide was proven by one real agent on a staging fixture; this one is proven equal to the code only. Its client rules are those of the reference client (`tests/fixtures/automation/tenant-provisioner.ts`), which ran at integration and on staging.
- **The rule is one the agent keeps,** as in D-79: the agent runs as the human's user, who can read the file that holds the automation secret.

## Consequences

- A change to an automation route, right or limit turns `automation-guide.test.ts` red until the guide follows.
- An agent proof of the second guide, as Run 10.4 C was for the first, is a candidate for a later session.
