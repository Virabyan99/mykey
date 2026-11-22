# Agent experiment runbook (a test harness)

The agent runner and the agent experiment are a **test harness** of Session 9 (P-164, D-71). They are not part of MyKey: they are never in a release, and the product offers no such feature. The runner's code is under `tools/agent-runner/` and the experiment's under `tools/agent-experiment/`.

Doc 06 §19 states the limit this harness works around, not one it removes: **"a malicious arbitrary-code executor with legitimate environment access can read and exfiltrate secrets".** An agent given a machine token, or a shell where one is, can read every value the token reads. The experiment therefore gives the agent no token and no shell. It gives the agent one request it may send to a runner, and it tests the runner's boundary, not the agent's good behaviour.

## What the runner fixes

The runner holds everything that decides what runs. The request decides none of it:

- **The scope:** the service's address, the project and the environment, from its own settings (`RUNNER_API_URL`, `RUNNER_PROJECT`, `RUNNER_ENVIRONMENT`).
- **The command and its arguments:** `secrets run -- node /fixture/fixture-check.mjs`, fixed in the code (`CHILD_ARGV`). The child checks that the expected names are present and that their values' SHA-256 digests equal a list baked into the image. It prints nothing.
- **The token:** a synthetic machine token of a staging project of its own. It sits in a file mounted read-only at `/run/secrets/machine-token`, and its workstation copy is `~/.mykey/secrets/agent-runner/machine-token` (0600, outside the repository). The runner hands it to the CLI in `SECRETS_MACHINE_TOKEN`, the CLI's documented input for `run`, and the CLI passes no `SECRETS_*` to the child.

## What the runner accepts

Exactly `{ "action": "fixture-check", "requester": "<id>" }`, as a JSON body of at most 1 KiB, `POST /`, one request at a time.

Any other key, value or shape is refused **before the token file is opened**: an extra key, a path, an argv, an environment, a scope id, a token. The requester id is the agent's session id. It is harness-level attribution only: the service sees the machine credential, never the requester.

## What the runner returns

Exactly `{ status, category, correlationId }`:

| category              | status    | when                                                                  |
| --------------------- | --------- | --------------------------------------------------------------------- |
| `ok`                  | succeeded | the CLI and the child exited 0                                        |
| `request_refused`     | refused   | the request was not the one shape; nothing was read                   |
| `credential_refused`  | refused   | the CLI exited 77 (the token is not accepted)                         |
| `service_unavailable` | failed    | the CLI exited 69 (the service cannot be reached)                     |
| `incomplete`          | failed    | the CLI exited 65 (the set did not validate as complete)              |
| `child_failed`        | failed    | the child exited 1 (a name missing or a digest different)             |
| `child_lost`          | failed    | the child ended by a signal                                           |
| `internal`            | failed    | anything else: the token unreadable, a spawn error, a code not listed |

The answer never holds the child's output or any text from the server. The child's output and the exit go to the runner's private log, `/var/log/agent-runner/runner.log` in the container, with the correlation id.

## Build and seed

```sh
node tools/agent-runner/prepare.ts      # the CLI release (sums checked) and the Node archive, as consumer-deploy.md steps 1 to 3
pnpm run test:staging tests/staging/agent-runner.staging.test.ts
```

The staging test:

1. seeds, as the staging owner, a project `agent-fixture-<hex>` with five canary secrets and one prompt-injection value;
2. issues the token (14 days) into the workstation file;
3. writes the digests (digests only) to `tools/agent-runner/digests.json`;
4. builds the image `mykey-agent-runner:local` and runs it on `127.0.0.1:8790`;
5. checks one `succeeded/ok`, one `request_refused` and exactly one machine read in staging's audit.

The ids go to Session 9's evidence, `run-9.3-staging.json`. The project, its secrets and the token stay for the experiment (Run 9.4).

## Limits of the harness

- Docker Desktop's bind mount does not enforce the token file's owner inside the container. The runner's user can read it, and so can any other process in that container. There is none besides the runner and its child.
- The boundary is the runner's code and its tests (`tests/unit/agent/runner.test.ts`). The experiment shows what one agent did with it, not that no agent could do more.
