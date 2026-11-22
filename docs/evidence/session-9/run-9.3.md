# Run 9.3 — The agent runner

**Date:** 22 Nov 2026. **Branch:** `session-9`. **Requirement:** FR-1.98. **Plan item:** P-164. **Decision:** D-71.

The runner is a **test harness** of the agent experiment, never part of a release (`docs/runbooks/agent-experiment.md`). Doc 06 §19's limit stands: a malicious arbitrary-code executor with legitimate environment access can read and exfiltrate secrets. So the agent gets no token and no shell, only one request it may send to the runner.

## What was done

- **`tools/agent-runner/runner.ts`,** run by Node's type stripping:
  - `parseRequest` accepts exactly `{ action: "fixture-check", requester }`, a plain object with a safe requester id. Anything else is `request_refused` before the token file is opened.
  - `handle` reads the token, then spawns the fixed argv `secrets run -- node /fixture/fixture-check.mjs` without a shell. The runner's own scope and the token go in `SECRETS_MACHINE_TOKEN`, the CLI's documented input for `run`.
  - `categoryOf` maps the exits: 0 `ok`; 77 `credential_refused`; 69 `service_unavailable`; 65 `incomplete`; 1 `child_failed`; a signal `child_lost`; anything else `internal`.
  - The answer is exactly `{ status, category, correlationId }`. The child's output and the exit go to the runner's private log, with the correlation id.
  - The HTTP face takes `POST /`, a body of at most 1 KiB, one request at a time. A second request is refused, not queued.
- **`fixture-check.mjs`:** checks the expected names and their SHA-256 digests against `/fixture/digests.json`. It prints nothing.
- **`Dockerfile`:** from the pinned `node-glibc` digest.
  - It checks the CLI release's sums and installs `cli-v0.1.2` with `install.sh`, as `consumer-deploy.md` does, then removes npm and corepack.
  - It runs as uid 1000. `pins-verify` now checks the Dockerfiles under `tools/` (`toolDockerfiles`).
- **`prepare.ts`:** writes the build context from the public release and nodejs.org, each file checked against its sum. The context and `digests.json` are in `.gitignore`.
- **`tests/staging/agent-runner.staging.test.ts`:** the seed and the happy path once.
- **`tsconfig.root.json`** includes `tools/**/*.ts`.

## Staging (synthetic data)

`docs/evidence/session-9/run-9.3-staging.json`:

- **The seed:** the project `agent-fixture-3aee59` (`ccffbded-69a8-4232-aa7d-32aa6c0fbc9a`), environment `development` (`15e848a4-30c6-4519-8b02-f5cce248f9a4`), with five canary secrets and one prompt-injection value carrying a canary. The values were assembled at run time.
- **The credential:** `agent-runner` (`58870f5f-2567-4bf0-8ec9-1bfc888d958f`), 14 days. Its token is in `~/.mykey/secrets/agent-runner/machine-token` (0600, outside the repository), and nowhere else.
- **The image:** `mykey-agent-runner:local`, built on this workstation.
- **The results:**
  - a request with an `argv` key answered `refused/request_refused`;
  - the request answered `succeeded/ok`;
  - staging's audit shows exactly one machine read by that credential since the start (`machine.resolve`);
  - the runner's log holds none of the six values and not the token.

The project, its secrets and the token stay for Run 9.4.

## Commands and results

| Command                                                                                 | Result                                                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `vitest --project unit tests/unit/agent`                                                | RED (no module); GREEN 6/6                                                                                         |
| `vitest --project unit tests/unit/pins tests/unit/agent`; `node scripts/pins-verify.ts` | GREEN 28/28; `pins: ok`                                                                                            |
| `pnpm run check`                                                                        | First red: `fixture-check.mjs` used `process` without importing it, and had a useless first assignment. Then GREEN |
| `pnpm run test:staging tests/staging/agent-runner.staging.test.ts`                      | GREEN 1/1, first run                                                                                               |

## Rulings

They are in the ledger:

- `runner.ts` by type stripping rather than `.mjs` files;
- 65 `incomplete`, every other CLI code `internal`;
- a staging project per run (`agent-fixture-<hex>`);
- the token as a read-only bind mount;
- one request at a time.

## Limits

- **The token file:** Docker Desktop's bind mount does not enforce its owner inside the container. The runner and its child are the only processes there.
- **What the experiment shows:** what one agent did with this boundary, not that no agent could do more.
