# Run 3.1 — API skeleton and persistence layer

**Result: DONE on 12 Nov 2026.** The API now has one contract-driven request pipeline (request id, gate, body limits, strict validation, error mapping, output validation, typed and redacted log), an audit append path, transactions and the first repositories, the job queue (pg-boss in schema `jobs`) with a transactional outbox and an in-process dispatcher, and an external service gate. Staging runs the new image behind the gate. No registry item moves in this run (the requirement ids are proven with the features that use the frame).

## What was done

- **Migration `0004_operator_and_jobs`** (hand-written): the `maintenance` rights of P-45; pg-boss 12.38.1's construction plan without its own BEGIN/COMMIT (`pnpm run jobs:check`, now part of `pnpm run check`, fails when the migration no longer holds it); the job-queue grants found by test. `tests/harness/privilege-matrix.ts` and `docs/runbooks/db-globals-inventory.md` list every new table and grant.
- **`@mykey/db`**: `withTransaction` (READ COMMITTED, one attempt, rollback on throw, broken clients not reused), scope types, `insertOperation` / `findOperationByKey` / `findOperation`, `enqueueOutbox` / `claimOutbox` (`FOR UPDATE SKIP LOCKED`) / `markOutboxDelivered`.
- **`@mykey/audit`**: `appendAudit` over the closed list `operator.bootstrap`, `auth.sign_in`, `access.denied`, each with a strict details schema; envelope ids must be UUIDs; a failed insert is `AuditUnavailable`.
- **`@mykey/operations`**: `JOB_KINDS`, `jobPayloadSchema` (exactly `{ operationId }`), `ensureQueues`, `createSender`, `createWorker`, `dispatchOutbox`, `jobSchemaSql`.
- **`apps/api`**: `mountRoute` from the contract for all 41 routes (terminal 404 for routes without a handler); `body.ts` (the only body reader), `validate.ts`, `respond.ts` (one envelope builder and message table), `log.ts` (typed entries, second-pass redaction), `gate.ts` (record v1), `/health` reporting the gate, `version.get`, the outbox dispatcher; `server.ts` exports `listen` and `startServer` and never sets the test hooks; start-up refusals are one `startup_refused` line naming the setting.
- **Contract**: `version.get` body; the OpenAPI cookie name `__Secure-better-auth.session_token` (pending list shrank by one).
- **Hosts**: `host.ts <host> gate open|close|status` (atomic replacement, epoch + 1), `host.ts up` writes `MYKEY_HOST_INSTANCE_ID` once and `MYKEY_BASE_URL`, creates `/etc/mykey/gate` and never writes a record; `db-init` runs `ensureQueues`; `status.sh` reports `gate`; Compose mounts the gate directory read-only and passes the new settings; the image bakes `MYKEY_BUILD` and copies the packages the API depends on (`.dockerignore` opened for them).
- **Harness**: `tests/harness/api.ts` (`startTestApi` over HTTPS on a fresh database, gate file outside the repository, test routes, a relay option for suites that restart PostgreSQL, `close()` fails on an unconsumed `unlisted_error`).
- Docs: `docs/runbooks/service-gate.md`, `docs/decisions/D-26-api-pipeline-and-gate.md`.

## Commits

- `a6a1c50` feat(db): transactions, operator grants, job schema and outbox
- `5d00d02` feat(audit): append path with closed actions and strict details
- `8f94a1f` contract: version.get body and the real cookie name
- `f291c95` feat(api): contract-driven pipeline frame, envelope, limits and logger
- `4c4d3f2` feat(api): external service gate, closed by default
- `3f8ede2` feat(api): outbox dispatcher
- `2c10210` feat(hosts): API image with the gate on staging
- `7090541` build(api): the image context holds the packages the API depends on
- this commit: docs: run 3.1 note, service-gate runbook, D-26

## Commands and results

| Command                                                                                    | Result                                                                                               |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `vitest --project integration tests/integration/jobs tests/integration/database`           | 130 passed                                                                                           |
| `vitest --project unit tests/unit/audit` · `--project integration tests/integration/audit` | 6 passed · 4 passed                                                                                  |
| `vitest --project integration tests/integration/api tests/integration/jobs`                | 89 passed (pipeline 22, routes-mounted 42, gate 5, health 9, jobs 11)                                |
| `pnpm test` (whole unit project)                                                           | 45 files, 696 passed                                                                                 |
| `pnpm run check`                                                                           | exit 0                                                                                               |
| `docker run --rm mykey-api:7090541f6647` (no settings)                                     | `{"event":"startup_refused","missing":"MYKEY_BASE_URL"}`, exit 1                                     |
| `host.ts staging push` · `image api` · `db-init` · `up`                                    | pushed; `API_IMAGE=sha256:defacccd…`; applied `0004_operator_and_jobs.sql`, job queues present; up   |
| `curl https://mykey-staging.nomikey.com/v1/version` (gate absent)                          | `503` `quarantined`; `host.ts staging status` → `"gate": "absent"`                                   |
| `node scripts/probe.ts state staging`                                                      | `health_failing` opened at 16:09:26 UTC (failing since 16:06:26) — the announced deploy-window alert |
| `host.ts staging gate open`                                                                | epoch 1; `/v1/version` → `{"apiMajor":1,"build":"7090541f6647"}`                                     |
| `vitest --project staging tests/staging/api.staging.test.ts`                               | 6 passed (after one fix of the test, below)                                                          |

**Alert window:** staging's `health_failing` alert of 12 Nov 2026 16:09 UTC came from this deploy (gate absent between `up` at 16:06 and `gate open` at 16:10); it resolved when the gate opened.

## Deviations and decisions

- **Job-queue grants** (Task A) were found by removing each one and watching the job tests fail: `api_runtime` needs `SELECT, INSERT` on `jobs.job`/`job_common`, `SELECT` on `jobs.version`/`queue` and `EXECUTE` on `jobs.job_now()`; `provisioner_runtime` needs no `INSERT`. `DELETE` for the provisioner is kept for its supervisor's clean-up, which no test exercises yet. No runtime role needs DDL.
- **pg-boss creates daily `jobs.queue_stats_YYYYMMDD` partitions** at installation (today and tomorrow). The matrix treats them as `jobs.queue_stats` (`matrixName`); queue statistics stay off, so none is created at run time.
- **The outbox send is part of the row's transaction** (pg-boss `send` with the transaction as its database): a crash before commit leaves no job, rather than the duplicate the plan allowed. The worker's conditional claim (Run 3.8) still covers duplicates.
- **`ensureQueues`, `createSender`, `createWorker` take a pg pool**, not a connection string, so the TLS-verifying pool of `@mykey/db` is reused.
- **An oversized declared body is refused from the header, then up to 4 MiB of it is read and dropped** before the 400 goes out: otherwise a peer that is still uploading sees a TCP reset instead of the envelope (observed on 524,289 bytes over HTTPS). Chunked bodies stop within one chunk of the limit (test: at most limit + 64 KiB read).
- **The request log keeps the field `path`** (a Session 2 staging test reads it), now holding the route pattern; `forwardedFor`/`forwardedProto` stay, cut to 256/16 characters, until Run 3.3 decides the request source.
- **The dispatcher-restart test is its own file with its own stack** (`tests/integration/jobs/dispatcher.test.ts`): restarting PostgreSQL on the shared stack would break the suites running beside it.
- **`MYKEY_BUILD` is a build argument**; an image built without it refuses to start.
- **Staging test fix:** the first version proved the gate file unwritable with a write as uid 1000, which the file mode alone refuses; the test now writes as root inside the container (`Read-only file system`) and checks the mount's `RW: false`.

## Open issues

- **Finding for Run 3.2:** `api_runtime` holds `INSERT` on `auth.user` and `auth.account` (Session 2 grants), so "`api_runtime` cannot run the bootstrap" does not hold today. Run 3.2 removes those two rights in a new migration (`0005`), since no API path creates an account (FR-1.01). Later migration numbers of the plan shift by one.
- Production is untouched (migration `0002`, Run 2.5 image).
