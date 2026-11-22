# Agent runner (test harness)

A test harness of the Session 9 agent experiment (P-164, D-71). It is not part of MyKey: never in a release, never a product feature. What it is for, what it fixes and what it returns: `docs/runbooks/agent-experiment.md`.

- `runner.ts`: the HTTP face and the order of one request. Run by Node's type stripping.
- `fixture-check.mjs`: the fixed child, which checks names and digests and prints nothing.
- `Dockerfile`: the image. Its build context needs `mykey-release/` and `digests.json`, neither of which is in Git (`.gitignore`).
- The unit tests: `tests/unit/agent/runner.test.ts`. The staging seed and the happy path: `tests/staging/agent-runner.staging.test.ts`.
