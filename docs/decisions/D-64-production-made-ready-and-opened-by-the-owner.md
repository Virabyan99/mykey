# D-64 — Production is made ready to open, and a host with a real owner is opened by the owner's own journey

**Date:** 2026-11-20

**Status:** DECIDED (plan P-146, P-147; the owner said yes to changing production on 20 Nov 2026). Built in Run 8.0 Task B. Evidence:

- `tests/integration/deploy/first-opening.test.ts` (five tests: the zero-secret rule, the owner-confirmed journey, the standalone open);
- `tests/unit/hosts/deploy.test.ts`, `tests/unit/hosts/host-cli.test.ts` (production's commands, `--owner-confirmed`), `tests/unit/release/deploy-plan.test.ts` (an owner-confirmed deploy is of the running build);
- `docs/evidence/session-8/run-8.0.md`; the path itself in `docs/runbooks/production.md`.

## Context

Gate R authorizes real, non-critical secrets on production from Run 9.1. Three things of the operator tool would have stopped that opening, and each fix would have changed the build the owner had just signed:

1. `scripts/host.ts` refused every KMS and OpenBao command for `prod` (a rule of Session 2, when production was to hold nothing). Production could not get an OpenBao.
2. The deploy's journey signs in as the synthetic `owner@mykey-<host>.invalid` with a password and an authenticator seed kept on the workstation, and needs a secret to reveal. A host with a real owner, or with no secret yet, could not produce the report that opens its gate.
3. A standalone `gate open --report` did not re-check anything, while `service-gate.md` and D-54 said it did.

## Decision

- **Production's commands.** Production accepts every KMS and OpenBao command of the tool (`kms-install`, `kms-csr`, `kms-cert`, `kms-use`, `kms-remove`, `kms`, `env`, `bao-init`, `quiesce`, `resume`). Only `kms-import` stays refused: it installs a key made on the workstation, which is for a test; production's keys are made on the host. Production gets its own KMS domain, user, policy, key and certificate (D-23), OpenBao, custody, backup material and timers in this session, and the release candidate with `--stay-closed`. It gets no account, no organization and no data, and it is not opened (rule 10).
- **`deploy --owner-confirmed`.** The owner does the journey in their own browser through `tunnel verify`, on the build that runs, and says so. The deploy then records the three journey checks as `owner confirmed (--owner-confirmed)` and reads no owner secret. It excludes `--install-only` and `--stay-closed`, and it refuses a release that is not the running build: the path is `--stay-closed`, the owner's journey, then `--owner-confirmed`. For `prod` the scripted journey is refused when the command is parsed: production never holds a workstation copy of the owner's password or authenticator. A synthetic account with a stored authenticator on production would be a standing way in to real secrets.
- **A host with no secret.** In both forms, when `app.secret_index` holds no row, the report's `journey_reveal_digest` is `ok` with `observed: "no secret in the index"`. The rows are counted by the report itself, never assumed; with one row or more the reveal must have happened, or the check is not `ok` and the gate stays closed.
- **The standalone open.** `gate open --report` takes a deploy report only. A restore report is refused, and names `restore-verify --open`. Before it writes, it runs the four store checks of a deploy report again (the schema revision the report saw, OpenBao readable, the incarnation in three places, the control row idle); a check that is not `ok` now refuses. The code and `service-gate.md` now say the same, on the stricter side.

## Consequences

- Production's first opening (Run 9.1) uses only commands that were tested before Gate R: bootstrap in the owner's own terminal, enrolment through `tunnel verify`, `provision-organization`, the owner's journey, `deploy --owner-confirmed` (`production.md`).
- Every later deploy of production costs the owner one journey of a few minutes between two commands.
- The three journey checks of production's reports are the owner's word, not a measurement. The store checks and the previous gate's state are still measured, and a failed one keeps the gate closed whatever the owner confirmed.
- Staging keeps the scripted journey with its synthetic owner.
