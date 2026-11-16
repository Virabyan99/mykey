# MyKey Stage 1 — Session 6 (Audit, limits, backup, recovery, deployment) Execution Plan

> **For the executing agent:** carry this plan out run by run, in the order given in "Run order". If you have the superpowers skills, use `superpowers:executing-plans` (inline execution is the owner's standing preference; one fresh-context review at the gate). Steps use checkbox (`- [ ]`) syntax for tracking. You do not re-decide anything in Doc 10 §3 / §8 or in the "Planner decisions" table below; if one proves wrong, write a one-paragraph decision record and continue (Doc 10 §1). One fallback of Doc 10 §8.1 is open in this session: **backup format** (Run 6.5). The spike of Run 2.9 already restored a Restic pair on staging, so the planner expects the first choice to hold; the fallback is another maintained encrypted archive format, never a shared mutable repository.

**Goal:** By the end of Day 10 (19 November 2026): staging is declared lost and rebuilt on a clean server from R2 and the custody set alone, starts closed, proves that every credential of the lost host is dead, and is reopened deliberately with a verification report; a verified pair is captured every day at 03:00 UTC and becomes eligible only after it was downloaded and checked; an owner or admin reads the audit trail and the activity of their organization, and nobody else does; every limit of Doc 06 §11 refuses before exhaustion and fails closed; and every alert of FR-1.63 has been seen to arrive off-host and has one runbook.

**Architecture:** Nothing new runs beside the two stores. PostgreSQL stays the one place for audit, counters, the capture state and the pair catalog; OpenBao stays the one place for values and tokens; R2 holds what must survive the host: one locked bundle per pair and the audit segments. Three things are added to the host, each started by systemd and none of them a long-running service: an **ops image** (the operator commands of `apps/ops`, run as short containers on the host network, the only way a job on the host reaches PostgreSQL, OpenBao and R2 together), a **capacity record** written every minute beside the gate file, and timers for the backup, the audit archive and the sweeps. A capture is a coordinator outside the API: it closes admission (`draining`), waits for admitted work, closes writing (`capturing`, enforced by a trigger on every authority table, so a write path nobody remembered is refused too), takes the three artifacts, releases, and only then packs, uploads, downloads again, checks and signs. An access-reducing action is never refused by a capture: it marks the candidate ineligible and proceeds. The gate record grows from "this host" to "this host, this backend incarnation, this origin, this release, this verification report"; the expected values live in the host's own configuration, outside anything a restore brings back. A restore is the reverse of a capture followed by one deliberate invalidation of every credential the pair could carry, and the product stays closed until a report says so. The API gains one private listener that is reachable only through the operator's tunnel and admits verification, never an effect; a deployment and a restore are verified through it before the gate opens. Limits are counters in `app.rate_limit` on the pipeline's own steps; the limiter, the capacity record and the audit probe all answer "refuse" when they cannot answer.

**Tech stack:** everything pinned in Sessions 1–5. Planned additions, each pinned in the run that adds it after the advisory check of Run 1.3 Step 2: `@aws-sdk/client-s3` (already pinned for the fixture) as a dependency of `@mykey/ops` (Run 6.2); the ops image on the pinned Node base (Run 6.2); the pinned Restic and PostgreSQL images used as tools on the host (already pinned). No new service, no second queue, no `rclone`, no pre-release version.

**Spec:** `docs/doc_10_mykey_stage_1_compressed_implementation_plan_v1.0.md` §1–§5, §7 "Session 6", §8, §9, §10 (item 5), §11 (W-1). Behaviour: Doc 04 §8 (FR-1.56–1.59, FR-1.80, FR-1.81), §9 (FR-1.60–1.63, FR-1.66–1.69, FR-1.78, FR-1.86, FR-1.87 and the binding recovery interpretation), §10 (FR-1.73–1.75), FR-1.95; acceptance AC-1.18, 1.23, 1.24, 1.25, 1.27, 1.28, 1.32, 1.33, 1.36 (per D-04), 1.43, 1.44, 1.49. Design: Doc 06 §3, §9 (the audit route), §11, §12, §13, §14, §15.2b, §18.1, §18.3. Previous sessions: `docs/evidence/session-5/report.md` ("What Sessions 6 and 7 must know"), `session-4/report.md` (M-1, M-3, M-4, M-5, M-7), `session-3/report.md`, `session-2/report.md` (what Session 6 owes), `session-1/run-1.9.md`, `session-2/run-2.9.md`; D-04, D-16, D-18, D-22, D-23, D-25, D-26, D-28. Old runbooks for ideas only: D08-S38, S40–S43.

**Provider facts used here** come from executed tests: Run 1.9 on Cloudflare R2 (a locked object answers 409 `ObjectLockedByBucketPolicy`; a bulk delete answers HTTP 200 with the refusal per object; several lock rules per bucket, one per prefix, set through the REST API); Run 2.9 on staging (the freeze takes about 40 s over SSH; a Raft snapshot is restored into a new OpenBao instance on the same seal key with HTTP 204; on another key a forced restore seals, so readability is the check, never the status; Restic 0.19.1 `check --read-data` on a per-pair repository); Run 2.6 (the probe Worker and its sink); Run 2.7 (key loss). Nothing was executed for this plan. Eight facts are **source or documentation reading** only, and the test named beside each is the first real evidence — when the observation differs, the observation wins and goes into the run note:

- PostgreSQL: `SELECT … FOR SHARE` needs the `UPDATE` privilege on at least one column of the table, so `api_runtime` keeps one column grant on `app.service_control` although it may change nothing there (Run 6.5 Task A);
- PostgreSQL: `pg_restore` creates triggers after it loads the data, and the dump of a capture holds the control row in `capturing`: a restored database is frozen until the restore resets the row (Run 6.7 Task B);
- OpenBao 2.7.2: the file audit device reopens its file on `SIGHUP`, so a rename followed by the signal loses no record (Run 6.2 Task C);
- OpenBao 2.7.2: with an auto-unseal seal, `sys/generate-root` takes the recovery keys of the instance the snapshot came from (Run 6.7 Task B; the fallback there is the custody root token, revoked at the end);
- R2: one `PutObject` accepts a body up to about 5 GiB and a SHA-256 checksum header; a larger bundle would need a multipart upload, which this session does not build (Run 6.5 Task C measures the real bundle; the limit goes into the runbook);
- systemd: `OnCalendar=*-*-* 03:00:00 UTC` with `Persistent=true` runs a missed job after a boot (Run 6.5 Task D);
- GitHub: a scheduled workflow of a public repository may start late and is disabled after 60 days without repository activity (Run 6.4 Task D; the limit goes into the runbook);
- OVHcloud KMS: whether a certificate requested with a CSR through `okms` can live longer than the console's 30 days was not read for this plan (Run 6.4 Task B reads the pinned tool's help and tries it once on staging).

---

## Global constraints

Every run's requirements include this section and the "Global constraints" of the plans of Sessions 1–5 (synthetic data only, real stores for proof, a skipped test is not a pass, the forbidden components, pins, limits live once in `@mykey/contracts`, remote work through `scripts/host.ts`, secrets only on stdin, one pipeline, contract commits, a denial must be a denial, database time, values in code and in tests, no retry of an effect, the lock connection, the invariant check, tokens in code and in tests, closed first).

- **Doc 10 §4.1 is at stake in every run of this session.** Read the eleven rules before starting. The ones this session can break: rule 1 (a value, a token, a backup password or a signing key in PostgreSQL, in a manifest, in an audit segment or in a heartbeat), rule 2 (a secret in a log line, a unit's journal, a status view, an alert text, a process argument or the transcript), rule 3 (a timed-out upload or revocation called a failure or a success), rule 8 (a value released while audit cannot record it; an audit row deleted before its archive was verified), rule 11 (`eligible`, `revoked`, `invalidated`, `restored` or `open` written without the verification that proves it).
- **Host secrets.** The backup password, the manifest signing key, the R2 credentials and the role passwords exist on the host under `/etc/mykey/secrets/` (root only, mounted read-only into the one container that needs them) and in custody under `~/.mykey/`. They are generated on the host or cross on stdin; no command prints one; a command that names `/etc/mykey/secrets` or `/root/mykey-custody` passes `secretOutput`. A unit's `ExecStart` never carries a secret: units name files.
- **The repository is public.** A manifest, a report, a run note and a runbook may hold ids, digests, object keys, sizes, times and public keys. They never hold a password, a token, a private key, an accessor, an R2 secret or a real value.
- **Eligible means verified.** A pair is `candidate` until the bundle was uploaded, downloaded again, digest-compared, checked with `restic check --read-data` on the downloaded copy and its manifest signed. No code path writes `eligible` on the strength of an upload's status. A pair that misses the two-hour deadline, or whose capture an access-reducing action crossed, is `ineligible` for ever.
- **Deletion in R2.** Only `deleteObjectsChecked` deletes, and its per-object outcome is compared with a `HEAD` afterwards. The newest eligible pair of a host is never deleted, whatever its age. Touch only the four `mykey-*` buckets. Never restart a lock clock: `upload.ts` of the fixture is not run again, and no object under a 30-day or 365-day rule is written by a test (tests write under `probe/`, 600 s).
- **Access reduction is never refused by this session's machinery.** Sign-out, session revocation, credential revocation, archive and `gate close` work during a capture, under disk pressure, over the rate limits of their own class and with the gate closed where they did before. They still need a durable outcome: when the write fails they say so.
- **Fail closed, by test.** Every new check has a test for "the check itself cannot answer": the counter table refuses, the capacity record is missing, stale or not JSON, the audit probe fails, the heartbeat field is null, the report is absent. The expected answer is a refusal or an open alert, never a pass.
- **Statuses.** Session 6 proves product code against real stores and on staging, not on the frozen release candidate: the registry moves an item to `SPIKE_PASS` or `FAIL`, never to `PASS` (P-104). A `SPIKE_PASS` needs a run note that states the id and the status on one line.
- **Migrations.** Session 6 owns `0015`–`0019`; Session 7, should it need one, starts at `0020` after this branch is merged. One migration per run that needs one; never edit a merged migration. **Every migration of this session is expand-only**: the release now on staging and production (`45b5c1f3cc3a`) must run on the new schema (P-131; proven in Run 6.9). Every new table, column, index, function, trigger or grant extends `tests/harness/privilege-matrix.ts` and `docs/runbooks/db-globals-inventory.md` in the same commit. Read the generated SQL (CLAUDE.md "New migration"); functions and triggers are written by hand into the generated file.
- **Staging.** A staging test begins by asserting its target, creates its own project and environments with fresh names and undoes every state change in `finally` (a frozen capture, a closed gate, a stopped unit and a filled volume above all). Inside a run, execute one file: `node scripts/require-staging-env.ts && pnpm exec vitest run --project staging tests/staging/<file>`. A staging run rewrites committed evidence files of earlier runs: restore them before committing.
- **Session 7 runs beside this session.** It uses staging and the workstation too. Before a step that makes staging unavailable (Run 6.5 Task D for minutes, Run 6.8 for hours), write the window into `docs/evidence/session-6/staging-windows.md` and commit it. Heavy jobs of both sessions are serialized by the lock directory `C:/Users/gmpar/mykey-wt/heavy.lock` (`mkdir` to take it, `rmdir` to release it; a lock older than three hours whose owner process is gone may be removed). The session that starts second works in a worktree under `C:/Users/gmpar/mykey-wt/`.
- **Production is not touched** before the gate run, and there only with the owner's word. Production holds no OpenBao and no owner; nothing of Runs 6.2, 6.5 and 6.6 is installed there in this session.
- **Alerts are real.** The probe's sink is the owner's Telegram chat. Drills open and close real alerts; every drill names its alerts in `owner-requests.md` beforehand or in the run note afterwards, and leaves none open.
- **The workstation.** One heavy job at a time: the integration suite (`--maxWorkers=2`), a staging file, a Docker build and the cloud suite never run together, and no agent runs beside them. Regexes and escapes are written with the editor tools, never through the shell. `MSYS_NO_PATHCONV=1` before `host.ts` commands with remote absolute paths.
- **CI** runs on the pull request and by hand only. Prove every run locally; open the pull request at the gate; after every push to it: `gh run list --branch session-6 --limit 3`.
- **Every run ends with:** `pnpm run check` green, the run's tests green, a commit on branch `session-6`, and a run note `docs/evidence/session-6/run-6.N.md` (template of Run 1.1: `What was done`, `Commits`, `Commands and results`, `Deviations and decisions`, `Open issues`).
- **Git.** Never commit on `main`. Worktrees and clones live under `C:/Users/gmpar/mykey-wt/` and `C:/Users/gmpar/mykey-gate/` (outside OneDrive). The pull request to `main` is merged only when the owner says so.

## Review focus

Five conditions the specifications imply but do not spell out, most likely to bite first. Each has a test pinned in the run named.

1. **A pair is called eligible and its two halves disagree.** A write path nobody listed (a sign-in, a session touch, a provisioner job, a tick of the sweep, an operation that was between its marker and its last transaction) lands between the PostgreSQL dump and the Raft snapshot; the pair restores without an error and holds a credential row without a token, or a token without a row. → P-118: writing is closed by a trigger on every authority table, not by a list of call sites. Run 6.5 Task B runs every kind of writer against forty captures, restores each eligible pair into scratch instances and compares the catalog with the backend there (`expectCatalogMatchesBackend`, the invariant check); a pair whose capture was crossed by a revocation is `ineligible` and the revocation succeeded.
2. **A restore gives a dead credential its life back.** The pair is days old: it holds the session that was signed out since, the TOTP secret and recovery codes that were replaced, a reset link that was used, the machine token that was revoked, the AppRole secret ids of the lost host, a root token. → P-124: the restore invalidates by class, not by list, and Run 6.7 Task C presents each of nine old credentials to the restored product and to the restored OpenBao directly; each is refused, and the gate cannot be opened while one check of the report is not `ok`.
3. **A limit fails open.** The counter table cannot be written; the capacity record is missing, old or half-written; two scopes share a counter key; `X-Forwarded-For` moves a client to a fresh counter; an unauthenticated machine request buys an OpenBao lookup at no cost; a body is read before the refusal. → Run 6.3 Tasks A–C: each of these has a test whose expected answer is 429, 503 or 507 with nothing done behind it, and the lookup count in OpenBao's audit device is the proof for the machine case.
4. **The audit trail loses or leaks a row.** An event committed late with an old timestamp misses its segment and is purged a year later as archived; a purge runs after an upload that was never read back; a row of the infrastructure is shown to an organization; a detail field passes through unvalidated on the way out. → Run 6.2 Task B (a transaction held open across a segment boundary; a purge with the object deleted from R2) and Run 6.1 Task C (every action of the closed list written once with a canary in every free field of its row, then read through the route by an owner, an admin, a member and a foreign owner).
5. **An alert that cannot fire, or cannot stop.** A null field clears an open alert (M-4); the Worker rejects the new heartbeat shape while host and Worker are deployed minutes apart, and every host goes `heartbeat_missing`; a certificate that lives 30 days is "within 30 days of expiry" on its first day; the Worker itself stops and nobody is told. → Run 6.4 Task A (unknown is not healthy; both heartbeat shapes are accepted), P-116 (a threshold a short certificate can meet), Task D (a watcher outside Cloudflare), and Run 6.10 Task A, which refuses a condition that has no evidence line of a real delivery.

## Planner decisions

Settled here so the executor does not have to choose. Each one marked **DR** gets a decision record in the run shown. Numbering continues from Session 5 (P-103, D-45).

| # | Decision | Why | Run |
| --- | --- | --- | --- |
| P-104 | The registry ceiling in Session 6 is `SPIKE_PASS` (as P-38, P-61, P-84). "Staging was rebuilt from R2 on a clean server" and "every alert was seen to arrive" are sentences of the session report with test names and timings, not `PASS`. Items that are `SPIKE_PASS` from a spike (PO-13, PO-14, PO-21, KMS-L1, DB-G1) keep the status and gain the product's evidence file. | Gate R counts scenarios on one frozen build; `registry-verify.ts` lifts the rule in Run 8.7. | all |
| P-105 | **Audit coverage is a table, checked both ways.** `packages/audit/src/coverage.ts` exports `AUDIT_COVERAGE`: one entry for every route id of `ROUTES`, every path the auth module mounts, every command of `apps/ops`, every timer of the API and the provisioner and every host job — either `{ actions: [...] }` or `{ none: "<reason>" }`. A unit test fails for an id without an entry and for an action of `AUDIT_ACTIONS` that no entry names. Reads of metadata (lists, history, operation status, the reference, `session.activity`) are `none`: FR-1.56 does not list them and a row per list request would bury the trail. Writers added in Run 6.1: `auth.sign_out` (`POST /sign-out`), `auth.session_revoke` (`/revoke-sessions`, `/sessions/revoke`; detail `revokedSessions`), `import.resume` (the resume route writes it instead of `import.apply`), `operator.auth_cleanup`. Requests refused before a principal is known (401, malformed, origin, quarantined, rate limits) stay log lines (FR-1.81 "operational denial logs are best-effort"); only `auth.throttled` and `access.denied` are rows, as today. **DR D-46.** | FR-1.56. A list in a document rots; a table that fails the build does not. An unattributable refusal must not be a way to fill the audit table (P-93). | 6.1 |
| P-106 | **Tenant and global rows.** Every action carries `scope: "tenant" \| "account" \| "global"` in `AUDIT_SCOPE` beside its details schema. `appendAudit` refuses a `global` action with an organization id and a `tenant` action without one (`AuditEventInvalid`). Global: every action of the infrastructure — gate, backup, restore, audit archive and purge, `operator.bootstrap`, `operator.auth_cleanup`, `operator.operations_expire`, `auth.throttled`. Account: the `auth.*` actions and `operator.reset_initiate`, written without an organization as today. The view of an organization shows its tenant rows plus the account rows whose **subject user** (the actor when it is a user, else the target when it is a user) is a member of the organization now; rows with an anonymous actor and no user target, and every global row, are never served by the API. Migration `0015`: `audit.event.subject_user_id text GENERATED ALWAYS AS (…) STORED` and the partial index `event_subject_occurred_idx (subject_user_id, occurred_at, id) WHERE organization_id IS NULL`. **DR D-46.** | FR-1.58 ("global infrastructure events remain operator-only"). The owner must see sign-ins to their own account; a failed sign-in for an unknown address belongs to nobody. | 6.1 |
| P-107 | **`audit.list`.** Query: `limit`, `cursor`, `from`, `to` (RFC 3339; default the last 30 days; `to − from` at most 92 days), `action` (one of the served actions), `outcome`, `actorKind`, `actorId`, `projectId`, `environmentId`, `operationId`, `requestId`; unknown keys are `422`. A project filter covers the project and its environments, resolved to ids at request time. Order `occurred_at DESC, id DESC`. The first page fixes `anchor = now()` on database time and serves only rows with `occurred_at <= anchor`; the signed cursor (`signCursor`) carries the anchor, the last `(occurred_at, id)` and a digest of the filters, and a cursor with other filters is `409 listing_changed`. Body: `{ items, nextCursor, anchor }`; an item is `{ id, occurredAt, actor: { kind, id }, source, action, target, outcome, requestId, operationId, details }`, and `details` is parsed with the action's own schema again on the way out — a row that fails it is served with `details: {}` and logged as `output_invalid`. The statement runs with a 5 s timeout; a timeout is `503 busy`. **DR D-46.** | Doc 06 §9 ("bounded filters and keyset cursor"); FR-1.58. An anchor keeps pages stable while events arrive. | 6.1 |
| P-108 | **`activity.list`** is the same rows for the workspace's timeline: only the product's actions (`project.*`, `environment.*`, `secret.*`, `import.*`, `credential.*`, `machine.*`, `system.operation_stuck`, `system.drift_detected`, `system.environment_provision`), filters `projectId`, `environmentId`, `limit`, `cursor`, the same anchor and cursor, and each item gains `operation: { id, state, action } \| null` read from `app.operation` at request time and `targetName` (the current name of the project or environment, or null). It never groups: the workspace groups by `operation.id`. Both routes keep the action `audit.view` (owner and admin). The contract commit is `contract: audit and activity`; after Run 6.1 the tag `session-6-run-6.1` is what Session 7 merges for Run 7.8. | Doc 06 §18.3; AC-1.48 needs an operation's current state beside its events. Grouping in SQL would break the keyset. | 6.1 |
| P-109 | **Correlation and diagnostics.** The request id stays the API's own UUID; an incoming `x-request-id` is never read (test). A response generated by the proxy carries no id; that is an honest limit for Run 6.10. FR-1.80 is proven by three things: the typed logger's entry list (a unit test builds every `LogEntry` kind from fixtures holding a canary in every string field and finds none in the output); the entrypoints of the three images and the compose files carry none of `--inspect*`, `--heapsnapshot-signal`, `--report-on-fatalerror`, `--report-uncaught-exception`, `--cpu-prof`, `--heap-prof`, and the containers run with `ulimits: core: 0`; and the canary sweep at the end of Task C over every container's log, the audit table and both audit segments. | FR-1.59, FR-1.80. | 6.1 |
| P-110 | **OpenBao's audit device.** Proven in Run 6.1 on the local stack: with the device unable to write (its directory on a full 1 MiB tmpfs in a compose override), a reveal, an export and a machine resolve answer `503` without a value, and nothing claims an audit row that was not stored. Rotation is a host job (Run 6.2): rename `audit.log` to `audit-<UTC>.log`, `SIGHUP`, wait until the new file exists and the old one stopped growing, check that the old file's last line parses, then compress, hash and ship it as a segment. `/health` learns of a dead device through one audited call with the runtime identity (`auth/token/lookup-self`), reused for 15 s (P-114). | FR-1.57. | 6.1, 6.2 |
| P-111 | **The ops image.** `apps/ops/Dockerfile` (the pinned Node base, production dependencies of `@mykey/ops` only, user 1000, no shell tools beyond the base). The host runs it through one wrapper `/opt/mykey/hosts/ops-run.sh <job> -- <command…>`: `docker run --rm --network host --read-only --cap-drop ALL --add-host postgres:10.78.2.2 --add-host openbao:10.78.3.2`, plus exactly the secret files of `<job>` from the table `infra/hosts/ops-jobs.json` (which also names the database role, the unit and its schedule). `host.ts <host> image` accepts it as a third image and writes `OPS_IMAGE` into `host.env`; `scripts/ci-scan.ts` scans it. Two role passwords come to the host for it, on stdin, into `/etc/mykey/secrets/ops/`: `maintenance` and `backup_reader`. The firewall already lets the host itself reach PostgreSQL, OpenBao and the `r2` set; containers on the bridges still reach none of R2. **DR D-47.** | A job on the host needs PostgreSQL, OpenBao and R2 in one process, and the workstation must not be part of a daily backup. `okms` already runs on the host network (D-23). The host is root over both stores already; a role password there adds no authority the host lacks. | 6.2 |
| P-112 | **The audit archive.** Table `audit.archive_segment (sequence bigint PK, stream text, host text, from_at, to_at, row_count, sha256, previous_sha256, object_key, uploaded_at, verified_at)`, streams `app` and `openbao`. `ops audit-archive` (daily 01:30 UTC, role `maintenance`): for stream `app`, one segment per closed UTC day, cut 15 minutes after the day ended; gzip of NDJSON, one event per line in `(occurred_at, id)` order; manifest `mykey-audit-segment/1` `{ stream, host, sequence, from, to, rows, sha256, previousSha256 }`; `PutObject` of segment and manifest under `<host>/<stream>/<yyyy>/<mm>/segment-<sequence>…`, then both are read back and compared before `verified_at` is set. Each run first recounts every archived interval that is not yet purged; a count that grew produces a supplementary segment for the late rows. A gap or a repeat in `sequence`, or a `previous_sha256` that does not match, stops the job with exit 1 (the failed unit is an alert, P-115). Purge: only through `audit.purge_archived(before timestamptz)` — `SECURITY DEFINER`, `EXECUTE` for `maintenance` only — which deletes rows older than `LIMITS.audit.retentionDays`, only inside intervals whose segments are verified and whose recount equals the manifests, and writes `system.audit_purge` in the same transaction; `maintenance` loses its direct `DELETE` on `audit.event`, and a trigger refuses `UPDATE` and `TRUNCATE` on it for every role. Local rotated OpenBao files are removed only after `verified_at`. Bucket rules, set through the REST API as in Run 1.9: prefix `prod/` 365 days, `staging/` 30 days, `probe/` 600 s. Migration `0016`. **DR D-48.** | FR-1.81, Doc 06 §12 ("keep local until off-host verify, audited purge"). A year-long lock on synthetic staging rows would hold the bucket for a year for nothing; the purge rule is the same code with the same 365 days and is proven with aged rows. | 6.2 |
| P-113 | **Rate limits** are pipeline steps on `bumpCounter` (D-28), 60-second windows, scopes of their own (`rl:source`, `rl:session`, `rl:credential`, `rl:reveal`, `rl:import`, `rl:export`, `rl:issue`, `rl:machine-miss`), keys of the `rate-limit` ring. Order: gate → **source** (300; before the body is read) → headers → body → … → authentication → **session** (120) or **credential** (60) → validation → authorization → the route's own class (`secrets.reveal` 30; `import.preview\|apply\|resume` together 5; `export.create` 5; `credentials.issue` 5) → the rest as today. A machine request whose token nobody can attribute bumps `rl:machine-miss` for its source **after** the failed lookup; a source at 30 misses in the minute is refused **before** the lookup. Two values are new in `LIMITS.rate` and marked "not in Doc 06 §11; Session 6 plan": `machineMissesPerSourcePerMinute: 30`, `credentialIssuePerMinute: 5`. A refusal is `429 rate_limited` with `retry-after` (the seconds left of the window) and a log line `rate_limited { scope }`, no audit row. A counter that cannot be bumped is `503 dependency_unavailable`; no path skips a step. Sign-out, session revocation, `credentials.revoke` and the archive routes are exempt from the session limit (not from the source limit). The auth module's throttle is unchanged. **DR D-49.** | Doc 06 §11; FR-1.60 ("auth limits apply before expensive work", "limiter failure cannot bypass"); Session 5 review Important 3. | 6.3 |
| P-114 | **Concurrency and order of work.** An in-flight gate of `LIMITS.concurrency.httpPerProcess` (64) is the first middleware after the request id: the 65th request is `503 busy` with `connection: close`, its body unread. For the large routes (`import.*`, `export.create`, `machine.resolve`) authentication, the session or credential limit and the large slot come **before** the body is read (M-5); a refused body is drained as today. `server.requestTimeout` is `LIMITS.deadlines.requestMs` and `headersTimeout` 10 s. The provisioner's pool and the ops pool take their sizes from `LIMITS.db`; a unit test adds every pool of two API processes, the provisioner, ops and the superuser reserve and requires at most `LIMITS.db.maxConnections`, and the host's PostgreSQL configuration holds that number. `machine.keys` and `machine.resolve` run one at a time per credential (a transaction-level advisory try-lock on the credential id; busy → `503 busy`). Whether one credential reading a large environment back to back starves a human write is **measured** (Run 6.3 Task B); the pass line is "a write succeeds within three attempts 1 s apart", and a failure adds a fairness rule with a decision record. `archive.ts` reuses one issuer session for as many environments as fit in 45 s. **DR D-49.** | Doc 06 §11; M-5; Session 5 report (a live token can starve writes; the 60 s issuer session). | 6.3 |
| P-115 | **Disk pressure is a record, written by the host.** `status.sh` (already run every minute) measures the filesystems of the PostgreSQL data, OpenBao data, OpenBao audit and Docker root and writes `/etc/mykey/gate/capacity.json` atomically: `{ "version": 1, "observedAt", "state": "ok" \| "low", "volumes": { "<name>": { "freeBytes", "sizeBytes", "freeInodesPercent" } } }`. `low`: a volume with free bytes under 15 % of its size, or under `minFreeBytes + auditReserveBytes` (4 GiB), or free inodes under 10 %. The API reads the record afresh per mutation (as the gate). `low` → every state-expanding mutation (secret create, update, restore, undelete and delete, the imports, project and environment create and rename, issuance, reactivation, password change, enrolment) is `507 capacity_exceeded` with details `{ limit: "disk" }`; reads continue; sign-out, session revocation, credential revocation and archive continue. A record that is missing, unreadable or older than 180 s → the same routes are `503 dependency_unavailable`. Real exhaustion needs no state: the audit insert fails and the answer is `503 audit_unavailable` (a fault test fills the volume). `disk_low` is a heartbeat field and an alert. **DR D-49.** | FR-1.61; AC-1.24. The API cannot see another container's volume; the host can. The 2 GiB audit reserve is what is left when mutations stop. | 6.3 |
| P-116 | **Health, heartbeat, alerts.** `/health` is down also when the audit probe fails (`BEGIN; INSERT` of a fixed row into `audit.event`; `ROLLBACK`) or the audited OpenBao call fails; both reused for 15 s. Heartbeat version 2: `{ v: 2, bootId, observedAt, checks: { sealed, kmsReachable, reviewOpen, operationsUnresolved, firewallLoaded, diskLow, auditFailing, captureSince, backup: { expected, newestEligibleCaptureAt }, certificates: [{ name, notAfter }], credentialExpiring, unitsFailed: [..] } }`; the Worker accepts the three old key sets and version 2 until every host sends version 2. New conditions: `disk_low`, `audit_failing` (the probe, the device, a failed archive unit, or an unarchived closed day older than 48 h), `capture_frozen` (`captureSince` older than 600 s), `backup_stale` (`expected` and the newest eligible capture older than 93,600 s or absent), `certificate_expiring`, `credential_expiring` (an `active` credential within 7 days of its expiry), `firewall_unloaded`, `unit_failed`, `checks_unknown`. **A null or missing field is unknown, never healthy**: it leaves an open condition open, and after the reported grace it opens `checks_unknown`. A failed `resolved` delivery is tried again at the next evaluation (D-22's open point). `operations_unresolved` counts a provisioning operation only after the queue's retry horizon (600 s) (M-3). `certificate_expiring` opens at 30 days for a certificate that lives longer than 60 days and at one third of its lifetime otherwise — a console KMS certificate lives 30 days and would be in alarm from its first hour. **DR D-50.** | FR-1.62, FR-1.63; AC-1.25; Session 2 and Session 4 reports (M-3, M-4). An alert that is always open is no alert; the deviation from "≤ 30 days" is forced by the provider and recorded. | 6.4 |
| P-117 | **Operator status and the watcher.** The private status view is `node scripts/host.ts <host> status` over the VPN: `status.sh`'s JSON, the capacity record, the backup and audit-archive facts from PostgreSQL, the certificates, and the probe's state (`probe.ts state`), each with its observation time; a check older than 180 s or absent is printed as `unknown`. `--json` prints the object. The API has no diagnostic route and gets none: a staging test asks, as the owner through the public name, for a fixed list of paths (`/status`, `/v1/status`, `/v1/operator/status`, `/metrics`, `/debug`, `/dashboard/`, `/api/rawdata`, `/v1/health/details`) and gets 404 for each. The Worker gains `evaluatedAt` in `GET /v1/state/<host>` and `POST /v1/test-alert/<host>` (read token; sends `MyKey <host>: test_alert`). Who watches the Worker: a workflow `probe-watch.yml` on a 15-minute schedule reads the state route and sends one Telegram message when `evaluatedAt` is older than 10 minutes or the route does not answer; its two secrets are repository secrets set with `gh secret set` from stdin. **DR D-50.** | FR-1.95, AC-1.49 ("a well-documented operator CLI/status view"); D-22 ("nobody notices when the Worker itself stops"). A scheduled workflow is the one independent party the agents can set up; its lateness is a stated limit. | 6.4 |
| P-118 | **The capture barrier.** `app.service_control` may be changed only by `maintenance` (a trigger checks `session_user`); `api_runtime` keeps `UPDATE (updated_at)` for row locks alone, and `INSERT`/`UPDATE` on `app.backup_pair` are revoked from it. Two closures: **admission** — every mutating route, every auth route that writes, the provisioner before a job, and each tick of the sweeps refuse while the mode is not `idle` (`503 busy`; one pipeline step replaces the six call sites); **writing** — a statement-level `BEFORE INSERT OR UPDATE OR DELETE` trigger on every table of `app` and `auth` except `rate_limit`, `service_control`, `backup_pair` and `backup_invalidation` takes the control row `FOR SHARE` and raises SQLSTATE `MKC01` while the mode is `capturing`. The pipeline maps `MKC01` to `busy`; the two best-effort writes on read paths (deleting an expired session, `last_used_at`) swallow it. `audit.event` and the counters are never closed. The coordinator: `idle → draining` (one commit, waits for every share lock); wait until no operation is `executing` and no effect slot is held, at most 30 s, else `→ idle` and exit 75; `draining → capturing`; artifacts; `→ idle`. **Access reduction**: `app.capture_invalidate(reason text)` (`SECURITY DEFINER`, `EXECUTE` for `api_runtime`) inserts into `app.backup_invalidation` and sets a transaction-local pass that the trigger honours; sign-out, session revocation, credential revocation and archive call it when the mode is not `idle` and proceed. A pair whose capture window holds an invalidation is `ineligible`. Migration `0017`. **DR D-51.** | Doc 06 §13 (the capture boundary). A trigger closes the paths the inventory missed (auth, resources, provisioner); admission keeps a refused request cheap and its answer exact. | 6.5 |
| P-119 | **The pair.** Format `mykey-pair/1`. Artifacts as in D-25: `postgres.dump` (`pg_dump -Fc` as `backup_reader`), `globals.sql` (`pg_dumpall --globals-only --no-role-passwords` on the socket), `openbao.snap` (a 600 s token of the root AppRole `backup`, which `host.ts <host> backup-init` creates). Manifest: `{ format, pairId, host, hostInstanceId, backendIncarnation, captureStartedAt (database time at `capturing`), boundary, schemaRevision, releaseBuild, artifacts: [{ name, bytes, sha256 }], keyRefs: { kmsKeyId, sealName, backupPassword: "<host>/1", signingKeyId }, tools }`. One Restic repository per pair on the tmpfs `/run/mykey-pair/<pairId>` (1 GiB; a pair that does not fit fails the capture, and the limit is in the runbook), encrypted with the host's backup password, packed as `bundle.tar`. Objects: `pairs/<host>/<captureUtc>-<pairId>/bundle.tar`, then, only after verification, `…/eligible.json` = `{ manifest, verification: { bundleSha256, downloadedSha256, resticCheck: "read-data", verifiedAt }, eligibleUntil, signature: { alg: "ed25519", keyId, value } }` over the canonical JSON. A pair without `eligible.json` does not exist for a restore. `host.ts <host> backup-init` generates the backup password and the Ed25519 key **on the host**, installs the R2 upload and read credentials from stdin, and writes the public key to `infra/hosts/backup/trust/<host>-<keyId>.pub` (committed: the independent trust anchor). `host.ts <host> backup-custody` copies password and private key to `~/.mykey/custody/<host>/backup/` without printing them; the owner's offline copy is OWN-4. The staging bucket gets the 30-day rule on `pairs/` after the 11 spike objects are removed. **DR D-52.** | Doc 06 §13; D-25; Session 2 report (manifest signature, password custody). A per-pair repository can be deleted as one object; a shared repository cannot (Doc 10 §8.1). | 6.5 |
| P-120 | **The daily job.** `mykey-backup.timer` (`OnCalendar=*-*-* 03:00:00 UTC`, `Persistent=true`) starts `backup.sh`, generated from the TypeScript step builders of `infra/hosts/backup/steps.ts` (the pattern of the spike's `host-steps.ts`): `ops capture begin` → dumps and snapshot → `ops capture record` (manifest, row `candidate`, release of the freeze) → Restic → `ops pair upload` → `ops pair verify` → `eligible`. `ExecStopPost` and a boot unit run `ops capture abort`, which releases a freeze this host owns, marks the candidate `ineligible`, writes the audit row and removes the tmpfs (Session 2 M2). The frozen part has its own deadline of 120 s. Audit: `system.backup_capture` (intent, success, failure), `system.backup_eligible`, `system.backup_invalidated`. A pair not eligible two hours after its capture is `ineligible`. | Doc 06 §11 (03:00 UTC, two hours), §13. | 6.5 |
| P-121 | **Retention and the first fixture.** `ops pair retention` (daily, after the backup): expired = `eligible_until` in the past; never the newest eligible pair of the host; `eligible.json` is deleted before `bundle.tar`, so a half-deleted pair is no pair; every outcome is checked per object and by `HEAD`; a locked object's 409 is a finding recorded on the row, not an error to retry at once; multipart uploads older than a day are aborted; `system.backup_cleanup` with counts. The first fixture is completed here: `pair-20261111-1` (the oldest eligible) is restored into scratch instances, then the fixture's objects are removed with the verified delete and checkpoint `run-6.6-cleanup-and-restore` is written. `tests/restore/retention/fixture.cloud.test.ts` stops reading dated evidence: its four refusal tests create their own objects under `probe/` (600 s lock) at run time, so `test:cloud` is green on any day. W-1 (a real 30-day pair restored) becomes the dated checkpoint `pair-30-day` from 18 Dec 2026. The cost sheet gets a used product's pair size and the monthly figure for 30 pairs. **DR D-53.** | FR-1.78; AC-1.36 per D-04; PO-9; R2-L1; COST-B1; Doc 10 §11 W-1. A test that fails by the calendar teaches nothing after its date. | 6.6 |
| P-122 | **Gate record v2.** `{ version: 2, state, gateEpoch, hostInstanceId, backendIncarnation, origin: { kind: "fresh_install", id } \| { kind: "restore", pairId }, releaseBuild, reportSha256, phase: "verifying" \| "serving", writtenAt }`. `readGate` admits `all` only for `state: "open"`, `phase: "serving"`, and host id, incarnation and build equal to the process's own; it admits `verification` for `closed` + `verifying` with the same three equal; anything else — a v1 record included — is `none`. Expected values: `MYKEY_HOST_INSTANCE_ID` and `MYKEY_BACKEND_INCARNATION` in `host.env`, `MYKEY_BUILD` in the image. The incarnation is also a column of `app.service_control` and a key in OpenBao's root namespace (`sys/` is not writable: a KV mount `mykey-meta`, key `incarnation`); the API compares the database's with its own at start and at every gate read (reused for 5 s), the provisioner compares OpenBao's. `host.ts <host> gate open --report <file>` refuses unless the report is of this host, incarnation and build, is younger than 30 minutes, has every check `ok` and hashes to what it writes; it appends `operator.gate_open` first and does not open when that fails. `gate close` needs nothing and audits when it can. The first deploy of this release converts each host with `gate close`, then a report, then `gate open`. Migration `0018`. **DR D-54.** | Doc 06 §14; D-26 ("v2 arrives in Run 6.7"). A restored database carries the old incarnation; a host that was not taken through the restore cannot open on it. | 6.7 |
| P-123 | **The verification listener.** With `MYKEY_VERIFY_LISTEN` set, the API listens a second time on an address of the `mk-api` bridge that the proxy does not route; `host.ts <host> tunnel verify` forwards a local port to it. On that listener a gate reading of `verification` passes the gate middleware; every write-time `gateOpen()` still requires `all`, so no effect on OpenBao and no state-changing product route is possible, while the auth routes, the lists, history and reveal work (reveal still audits first). Machine routes answer `quarantined` on it. The public listener is unchanged. `ops verify-journey` drives it (reset completion, enrolment, sign-in, lists, one reveal compared by digest, one mutation that must be refused) and returns its checks for the report. **DR D-54.** | FR-1.72 ("private verification listeners"), FR-1.73 ("smoke and negative tests before public"). One mechanism serves a restore and a deployment. | 6.7, 6.9 |
| P-124 | **Restore, by class.** `host.ts <host> restore --pair <key> \| --newest`: (1) refuse a host that is not closed or holds data; (2) list `pairs/<source host>/`, take `eligible.json`, verify the signature against `infra/hosts/backup/trust/`, download, compare digests, `restic check --read-data`, restore to tmpfs, verify every artifact; refuse a manifest whose KMS key reference this host's KMS identity cannot use; (3) PostgreSQL: a new cluster, `applyRoles` with **new** passwords, `globals.sql` compared with the inventory and never executed, `pg_restore`, the schema revision equal to the release's; (4) OpenBao: a fresh instance on the same seal, snapshot restore, readable; (5) **invalidate**: every `auth.session`, `auth.reset_token` and `auth.verification` row deleted, every `auth.totp_step_used` kept, every account `recovery_pending` with `auth_epoch + 1` (password and factors unusable until the operator's reset); in every namespace of `LIST sys/namespaces` every token accessor revoked and proven absent, every `machine_credential` not `revoked` moved to `revoked`; the secret ids of `runtime`, `issuer`, `provisioner` and `backup` destroyed and issued anew; a new root token by `generate-root`, the pair's root tokens revoked, the new one revoked at the end; (6) the control row `idle` with a new incarnation, the same id in OpenBao and `host.env`, a new host instance id; every operation not terminal → `uncertain`; (7) start closed, `verifying`; `ops verify-organization`, `ops reconcile-credentials` per environment, `ops restore-verify`; (8) the report; (9) `gate open`. Each step writes a line of state on the host, and a restore that stops is continued or started again from step 1: no step is skipped on the word of an earlier run. Memberships and grants are listed in the report and need the operator's `--confirm-members <count>`. Audit: `operator.restore_begin`, `operator.restore_invalidate`, `operator.restore_verify`, written into the restored database (the lost host's own audit is in the archive). **DR D-55.** | FR-1.67–1.69, FR-1.86, FR-1.87 and the binding recovery interpretation; Doc 06 §14 (nine steps); Doc 10 §10 item 5; D-18 (accessors are per namespace). Invalidating by class cannot miss a credential that a list forgot. | 6.7 |
| P-125 | **The drill.** A third host, `drill`, from `~/.mykey/hosts.json` (`HostName` becomes "a name of that file"; `prod` keeps its permission rule). The owner buys it (OWN-5) and issues its KMS certificate from the CSR; the agents give it DNS, VPN, firewall and the probe entry. Staging is fenced first (gate closed, API and provisioner stopped, `inService: false`), and a **stale pair** is the input: after its capture the staging fixture changes a password, replaces TOTP and recovery codes, uses a reset link, signs a session out, revokes a machine token, removes an admin and writes a secret. The drill host writes its own pairs under `pairs/drill/`, so it never becomes staging's newest pair. Timings are taken per step; the sum from "declared lost" to "gate open" is the measured recovery time in the report. At the gate staging is un-fenced and the drill host is deleted. **DR D-56.** | Doc 10 §7 (Run 6.8, 6.11), OWN-5; AC-1.28, 1.43, 1.44; PO-22. | 6.8 |
| P-126 | **Run 6.9 comes before Run 6.8.** The drill needs the owner's server; the deployment work needs nothing, and a drill that installs the host with the release tooling proves the restore-based rollback in the same hours. | Doc 10 marks Run 6.9 parallel. | order |
| P-127 | **A release is built once.** `pnpm run host:release -- --version <v>` on a clean checkout: builds the API, provisioner and ops images with `MYKEY_BUILD`, runs the three scanners against exactly those images (a finding stops it), `docker save`s each, and writes `release.json` `{ version, commit, images: [{ name, imageId, archiveSha256 }], baseDigests, migrations: { last }, scans, builtAt }` and `SHA256SUMS`; `gh release create host-v<version>`. `host.ts <host> deploy --release host-v<version>`: downloads, verifies sums, refuses an image id that is not in the release, loads the same archives on the host, closes the gate, runs `migrate` and `ensureQueues`, starts, runs the verification journey over the listener, writes the report, opens the gate. Staging and production receive the same image ids. A failed migration or journey leaves the host closed on the old images. The API image loses `npm` and `corepack` (Session 2 owed). **DR D-57.** | FR-1.73, FR-1.74; AC-1.32; Doc 06 §14 ("build once, promote the same digest"). There is no registry and none is added: an image id is a digest of the image's content. | 6.9 |
| P-128 | **Rollback.** Supported: redeploy the previous release on the current schema — every migration is expand-only, and `tests/integration/deploy/previous-release.test.ts` runs the previous release's API image against the migrated database through the core journey. Not supported: a schema downgrade; the answer to a migration that must be undone is a restore (Run 6.8 proves it). A migration that fails half-way is rehearsed with a throw-away release whose extra migration raises: the host stays closed, the old release starts again on the untouched schema (each migration is one transaction). | FR-1.74 ("expand/contract or tested restore rollback"). | 6.9 |
| P-129 | **Host timers** (all through `ops-run.sh`, P-111): `mykey-backup` 03:00, `mykey-pair-retention` 04:30, `mykey-audit-archive` 01:30, `mykey-bao-audit-rotate` 01:00, `mykey-operations-expire` 02:00, `mykey-auth-cleanup` hourly, `mykey-sweep` every 5 minutes (`ops sweep`: the PostgreSQL-only sweeps, for the minutes the API is down). A unit that fails is reported as `unitsFailed` (P-116). `operations-expire` no longer strands a resume: an import parent with `awaiting_input` is expired together with its entries, and a later resume answers `409 replay_expired` (M-7). `operation-sweep.ts` catches per archive (Session 5 minor). | Session 4 and 5 reports (timers; M-7). | 6.9 |
| P-130 | **One runbook per condition.** `docs/runbooks/alerts.md` has one section per entry of the probe's `CONDITIONS`, each with the headings `Means`, `Check`, `Fix`, `Confirm`; a unit test compares the two lists and the headings. `docs/evidence/session-6/alerts.md` has one line per condition: the date, the drill and the id of the delivered row of the probe's alert log; the same test refuses a condition without a line. `docs/runbooks/known-limits.md` is the honest list (FR-1.75). | FR-1.75; AC-1.33; Doc 10 §7 ("every alert seen to fire and has a runbook"). | 6.10 |
| P-131 | **Expand-only, stated once.** No migration of `0015`–`0019` drops, renames or narrows anything an older release reads or writes; the rights taken from `api_runtime` (`backup_pair`) and `maintenance` (`DELETE` on `audit.event`) are rights no released code uses — Run 6.5 Task A and Run 6.2 Task A prove that with a search and a test before the migration is written. | P-128 depends on it. | all |

## Carried items

| Item | From | Where it lands |
| --- | --- | --- |
| R2 fixture guard: `test:cloud` fails on purpose since 15 Nov 2026 09:42 UTC | Run 1.9, D-04 | Run 6.6 Task A (P-121) |
| Fixture checkpoint 3, `probe/` and `scratch/` objects left on purpose | Run 1.9 | Run 6.6 Task A |
| 11 spike objects in `mykey-staging-pairs`; no lock rule on that bucket and on `mykey-audit-archive` | Run 2.9, Run 1.9 | Run 6.5 Task C; Run 6.2 Task B |
| Pair manifest signature, Restic password custody, owner of the control row, freeze alert | Session 2 report | P-118, P-119 (Run 6.5); P-116 (Run 6.4) |
| M2: a failed capture leaves artifacts in tmpfs; every pair container mounts all of `in/` | Session 2 report | Run 6.5 Task B (`ops capture abort`; one mount per step) |
| M1: OpenBao root token unrevoked in `/root/mykey-custody` | Session 2 report | Run 6.7 Task B (restore); on staging at the gate, Step 4 |
| M17: `scripts/host.ts` takes SSH and redaction code from `tests/harness/` | Session 2 report | Run 6.9 Task A (moved to `apps/ops/src/remote/`) |
| Heartbeat field for an unloaded firewall; Worker self-monitoring; KMS certificate expiry alert | Session 2 report, D-22 | Run 6.4 |
| `npm` in the API runtime image | Session 2 report | Run 6.9 Task A |
| "A reset test that proves nothing about rights"; Better Auth writes `expires_at` on the API clock | Session 3 report | Run 6.7 Task C (the restore's reset is tested by what the account can do afterwards); Run 6.10 (`known-limits.md`) |
| M-1: a gate closed during an import rejects the remaining entries | Session 4 report | Run 6.7 Task A |
| M-3, M-4: `operations_unresolved` over-counts; a null field clears an alert | Session 4 report | Run 6.4 Task A |
| M-5: a third large request is refused only after its body was read | Session 4 report | Run 6.3 Task B |
| M-7: a resume after `operations-expire` parks on `idempotency_conflict` | Session 4 report | Run 6.9 Task C |
| Rate limits per session, credential and source; unauthenticated machine requests | Sessions 3–5 | Run 6.3 Task A |
| A live token can starve writes through `keys`; the 60 s issuer session per environment | Session 5 report | Run 6.3 Task B |
| `issue.ts` stores no accessor on `needs_review` | Session 5 report | Run 6.7 Task B (the restore revokes by namespace walk, not by stored accessor); otherwise `known-limits.md` |
| `operation-sweep.ts`: no try/catch per `driveArchive`; no host timers | Session 5 report | Run 6.9 Task C |
| After a restore every environment needs `ops reconcile-credentials` | Session 5 report | Run 6.7 Task B, step 7 |
| Two flaky `unseal` staging tests | Session 5 report | Run 6.11 Step 4: each is run three times; a failure is diagnosed, not repeated |
| CLAUDE.md says 21 routes are pending; five are | inventory for this plan | Run 6.11 Step 10 |
| KMS certificates expire 12 Dec 2026; `.trivyignore.images` expires 14 Dec 2026 | CLAUDE.md | not this session's work; Run 6.4 makes the first one an alert, Run 6.11 Step 2 re-reads both dates |

## Session start (before Run 6.1)

- [ ] **Step 1 — Branch.** `git switch main && git pull && git switch -c session-6`. The first commit is this plan: `docs: session 6 plan` (it is already there when the plan's pull request was merged; then start from `main`). If Session 7 already works in the repository's checkout, add a worktree instead: `git worktree add C:/Users/gmpar/mykey-wt/session-6 session-6`.
- [ ] **Step 2 — One message to the owner**, saved as `docs/evidence/session-6/owner-requests.md` (no values in it). It asks for exactly four things and says when each is needed:
  1. **OWN-5, needed before Run 6.8 (Day 10 morning):** one temporary OVHcloud server like staging (same region, same image, hourly billing), its root credential handed over as for staging in Session 2. It is deleted at the gate.
  2. **For the same server, 10 minutes in the OVH console when the agent sends the CSR:** one KMS certificate (as D-23).
  3. **OWN-4, after Run 6.5:** an offline copy of `~/.mykey/custody/staging/backup/` (two files). The agent says when they exist; the owner answers "copied".
  4. **A yes or no for production at the gate:** the new release and migrations `0015`–`0018`; production stays closed and without a gate file.
  It also tells the owner what will arrive in Telegram without action needed: test alerts on Days 9 and 10, each announced in the same file.
- [ ] **Step 3 — Dated items.** Run `pnpm run test:cloud` once and record that it fails with the four guard tests and nothing else (the baseline for Run 6.6). Record the two expiry dates (12 and 14 Dec 2026) in the run note of Run 6.1.
- [ ] **Step 4 — Staging baseline.** `node scripts/host.ts staging status`: gate open, nothing in review, nothing unresolved, API `45b5c1f3cc3a`. `node scripts/probe.ts state staging`: no open condition. Anything else is settled before Run 6.1.

## Run order

```
6.1 audit coverage, audit and activity routes ──► tag session-6-run-6.1 (Session 7, Run 7.8)
 └► 6.2 ops image, audit archive, retention
     └► 6.3 limits and overload            (may be done before 6.2)
         └► 6.4 health, operator status, alerts
             └► 6.5 daily paired backup                 · OWNER OWN-4 afterwards
                 └► 6.6 retention, clean-up, cost
                     └► 6.7 gate v2, verification listener, restore tooling
                         └► 6.9 deployment, rollback, timers          (before 6.8: P-126)
                             └► 6.8 clean-host restore drill          · OWNER OWN-5
                                 └► 6.10 runbooks and honest limits
                                     └► 6.11 session gate
```

- **Dependencies.** 6.2 needs 6.1's actions and scopes. 6.4 needs 6.3's capacity record. 6.5 needs the ops image (6.2) and the heartbeat fields (6.4). 6.6 needs 6.5's objects and catalog. 6.7 needs 6.5's pair and trust anchor. 6.9 needs 6.7's listener and report. 6.8 needs everything. 6.3 depends only on 6.1's log entries and may be done while waiting for anything.
- **Migrations.** `0015` audit view (6.1); `0016` audit archive (6.2); `0017` capture barrier (6.5); `0018` incarnation (6.7); `0019` is spare.
- **Deploys to staging inside the session:** after 6.4 (API, Worker, `status.sh`: the alerts are drilled there), after 6.5 (the barrier and the backup job) and in 6.9 (the first deploy through the release tooling, which also converts the gate to v2). Each is one heavy job; each ends with `status` and `probe.ts state` clean.
- **Scope valves** (Doc 10 §8.2 applies; inside this session, what gives first when Day 10 is short): (1) the rehearsed command blocks of Run 6.10 — the heading and evidence checks stay; (2) the starvation measurement of Run 6.3 becomes a line in `known-limits.md`; (3) the on-staging proof of OpenBao audit rotation — the local proof stays; (4) `probe-watch.yml` — the gap goes into `known-limits.md`. Never cut: Run 6.5 Task B, Run 6.7 Task C, Run 6.8, any fail-closed test, audit before release.

## File map

```
packages/audit/src/           events.ts (actions, AUDIT_SCOPE)  coverage.ts  read.ts
packages/contracts/src/       routes.ts (audit.list, activity.list)  limits.ts (two rate values)  capacity.ts  gate-record.ts
packages/db/migrations/       0015_audit_view.sql  0016_audit_archive.sql  0017_capture_barrier.sql  0018_incarnation.sql
packages/db/src/repos/        audit-read.ts  audit-archive.ts  capture.ts  pairs.ts
packages/operations/src/      gate.ts (v2)  capacity.ts  capture/{barrier,coordinator}.ts
packages/backup/src/          manifest.ts  sign.ts  bundle.ts  r2.ts  retention.ts          (new package @mykey/backup)
apps/api/src/                 pipeline/{rate,inflight,capacity,capture}.ts  routes/{audit,activity}.ts  health.ts  server.ts (verify listener)
apps/ops/                     Dockerfile
apps/ops/src/commands/        audit-archive.ts  capture.ts  pair.ts  restore-invalidate.ts  restore-verify.ts  verify-journey.ts  sweep.ts
apps/ops/src/remote/          ssh.ts  redact.ts (moved from tests/harness)  status-view.ts
infra/hosts/                  ops-run.sh  ops-jobs.json  checks/{status,heartbeat}.sh  systemd/mykey-*.{service,timer}
infra/hosts/backup/           steps.ts  backup.sh.ts  restore-steps.ts  trust/<host>-<keyId>.pub
infra/release/                build.ts  release-schema.ts
workers/probe/src/            evaluate.ts  index.ts (heartbeat v2, test-alert, evaluatedAt)
.github/workflows/            probe-watch.yml
scripts/                      host.ts (restore, deploy, backup-init, backup-custody, tunnel verify, gate v2, status view)  host-release.ts
tests/unit/                   audit/{coverage,scope}.test.ts  api/{rate,capacity,inflight}.test.ts  probe/*.test.ts  backup/*.test.ts  gate/v2.test.ts  runbooks/alerts.test.ts
tests/integration/            audit/{view,activity,journey,diagnostics}.test.ts  archive/*.test.ts  limits/*.test.ts  capture/*.test.ts  restore/*.test.ts  deploy/*.test.ts
tests/fault/                  audit/{device,exhaustion}.test.ts  capture/{crash,compete}.test.ts  restore/interrupted.test.ts
tests/restore/retention/      fixture.cloud.test.ts (rewritten)  cleanup.cloud.test.ts  segment.cloud.test.ts
tests/staging/                audit.staging.test.ts  limits.staging.test.ts  alerts.staging.test.ts  status.staging.test.ts  backup.staging.test.ts  deploy.staging.test.ts  drill.staging.test.ts
docs/decisions/               D-46 … D-57
docs/runbooks/                audit.md  limits.md  alerts.md  operator-status.md  backup.md  restore.md  deploy.md  known-limits.md (+ probe.md, service-gate.md, custody-map.md, credential-custody.md, db-globals-inventory.md updated)
docs/evidence/session-6/      owner-requests.md  staging-windows.md  run-6.1.md … run-6.11.md  alerts.md  drill.json  report.md
```

---

## Run 6.1 — Audit coverage and the audit and activity routes (D08-S38)

**Files:** `packages/audit/src/{events,coverage,read,index}.ts`, `packages/contracts/src/routes.ts` (+ `openapi.json`), `packages/db/migrations/0015_audit_view.sql`, `packages/db/src/repos/audit-read.ts`, `packages/auth/src/{routes,sessions}.ts`, `packages/operations/src/imports/apply.ts`, `apps/ops/src/commands/auth-cleanup.ts`, `apps/api/src/routes/{audit,activity}.ts`, `apps/api/src/app.ts`, `infra/compose/dev/audit-full.override.yml`, `tests/unit/audit/{coverage,scope}.test.ts`, `tests/unit/api/log-entries.test.ts`, `tests/unit/hosts/diagnostics-flags.test.ts`, `tests/integration/audit/{view,activity,journey,diagnostics}.test.ts`, `tests/fault/audit/device.test.ts`, `tests/harness/privilege-matrix.ts`, `tests/unit/contracts/pending-routes.snapshot.json`, `docs/decisions/D-46-audit-coverage-and-view.md`, `docs/runbooks/{audit,db-globals-inventory}.md`.

**Consumes:** `appendAudit`, `AUDIT_DETAILS` (Session 3); `signCursor`, `readCursor`, `pageQuery` (Session 4); the fixtures `createOrgFixture`, `createCredentialsFixture` and the matrix users (`ownerA`, `adminA`, `editorA`, `ownerB`).

**Produces:**

```ts
// @mykey/audit — events.ts
export type AuditScope = "tenant" | "account" | "global";
export const AUDIT_SCOPE: Readonly<Record<AuditAction, AuditScope>>;
export const SERVED_ACTIONS: readonly AuditAction[];        // scope tenant or account
export const ACTIVITY_ACTIONS: readonly AuditAction[];      // P-108
// @mykey/audit — coverage.ts
export type Coverage = { actions: readonly AuditAction[] } | { none: string };
export const AUDIT_COVERAGE: { routes: Record<string, Coverage>; auth: Record<string, Coverage>; ops: Record<string, Coverage>; timers: Record<string, Coverage> };
// @mykey/audit — read.ts
export function servedDetails(action: AuditAction, details: unknown): { details: AuditDetails; valid: boolean };
// @mykey/db — repos/audit-read.ts
export interface AuditFilter { organizationId: OrganizationId; from: Date; to: Date; anchor: Date; after?: { occurredAt: Date; id: string };
  actions: readonly string[]; outcome?: string; actorKind?: string; actorId?: string; targetIds?: readonly string[]; operationId?: string; requestId?: string; limit: number }
export interface AuditRow { id: string; occurredAt: Date; actorKind: string; actorId: string | null; source: string | null; action: string;
  targetKind: string | null; targetId: string | null; outcome: string; requestId: string | null; operationId: string | null; details: unknown }
export function listAuditEvents(db: Queryable, f: AuditFilter): Promise<AuditRow[]>;      // limit + 1 rows; statement timeout 5 s
export function operationStates(db: Queryable, ids: readonly string[]): Promise<Map<string, { state: string; action: string }>>;
// @mykey/contracts — routes.ts
export const auditListQuery: z.ZodType; export const auditListBody: z.ZodType;
export const activityListQuery: z.ZodType; export const activityListBody: z.ZodType;
```

Design fixed here (P-105 … P-110; Doc 06 §9, §12; FR-1.56–1.59, FR-1.80, FR-1.81):

- **Contract commit** `contract: audit and activity`. Both routes gain a query schema (so `validation_failed` joins their errors) and leave the pending snapshot, which shrinks to three ids.
- **Migration `0015`**: the generated column and the partial index of P-106. Nothing else. The privilege matrix does not change; the inventory gains the column.
- **The actions of the whole session are declared now**, with their details and scope, so that Runs 6.2–6.9 only write them: `auth.sign_out {}`, `auth.session_revoke { revokedSessions }`, `operator.auth_cleanup { sessions, tokens }`; global — `system.audit_archive { stream, sequence, rows }`, `system.audit_purge { rows, intervals }`, `system.backup_capture { pairId }`, `system.backup_eligible { pairId }`, `system.backup_invalidated { pairId, reason: "deadline" | "access_reduction" | "verification" | "aborted" }`, `system.backup_cleanup { deleted, kept, refused }`, `operator.gate_open { gateEpoch, origin: "fresh_install" | "restore" }`, `operator.gate_close { gateEpoch }`, `operator.restore_begin { pairId }`, `operator.restore_invalidate { sessions, accounts, credentials, namespaces }`, `operator.restore_verify { checks, failed }`, `operator.deploy { build }`. `pairId` is a UUID; no detail holds a key, a path or a name of a host file. A coverage entry for an action whose writer arrives later names the run (`{ actions: [...] }` with a comment); the "every action has a writer" assertion of the journey test lists those actions in `PENDING_WRITERS`, a list that Run 6.9 must leave empty.
- **The served query** is one statement: tenant rows of the organization, `UNION ALL` account rows whose `subject_user_id` is in the organization's membership, both bounded by `from`, `to`, `anchor` and the keyset, ordered and limited once outside.
- **Runbook** `audit.md`: what is recorded and what is not (the coverage table rendered by a script, so the two cannot differ), the three scopes, how an operator reads global rows (`psql` as `maintenance` through `host.ts … maint`), what an audit outage looks like.

### Task A — the coverage table and the missing writers

- [ ] **Step 1 — Failing tests.**
  - `coverage.test.ts`: `every route id of ROUTES has an entry`; `every path of NATIVE_ALLOWED, PRODUCT_OWNED, PRODUCT_ROUTES and FACTOR_PATHS has an entry`; `every file of apps/ops/src/commands has an entry`; `every action of AUDIT_ACTIONS is named by an entry`; `an entry with none has a reason of at least 20 characters`.
  - `scope.test.ts`: `every action has a scope`; `appendAudit refuses a global action with an organization id` and `a tenant action without one` (`AuditEventInvalid("event")`); `no details schema has a key matching /token|secret|password|accessor|code|link|value|path/i`.
  - `journey.test.ts` (real stores): `sign-out writes auth.sign_out; revoking another session writes auth.session_revoke with revokedSessions 1`; `a resumed import writes import.resume and no second import.apply intent`; `ops auth-cleanup writes operator.auth_cleanup`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** the table, the scopes, the four writers; each writer in the transaction of the change it records (sign-out and session revocation call `appendAudit` with the transaction that deletes the session: no row, no sign-out answer of success). **Step 4 — Run:** PASS. **Commit** `feat(audit): a coverage table, scopes and the missing writers`.

### Task B — the two routes

- [ ] **Step 1 — Contract commit; migration `0015`.** **Step 2 — Failing tests** (`view.test.ts`, `activity.test.ts`; organization A with events of every served action, organization B likewise):
  - `owner and admin of A read A's events; editorA gets 403 action_denied and an access.denied row; ownerB gets the hidden 404`;
  - `no row of B, no global row and no anonymous row is in any page` — the test walks every page with `limit` 7 and collects ids;
  - `a sign-in of ownerA is served to A; a failed sign-in for an unknown address is not`;
  - each filter alone and two together return exactly the rows a direct SQL query returns; `projectId` covers the project's environments;
  - `to − from` of 93 days → 422; an unknown key → 422; `from` after `to` → 422;
  - `pages are stable`: 30 events written between page one and page two do not appear and nothing is skipped or repeated; `a cursor used with another filter → 409 listing_changed`; a cursor with a changed byte → 422;
  - `a row whose details fail its schema` (written by the superuser) `is served with details {} and logged output_invalid`;
  - `activity: an item of a secret write carries operation.state succeeded; after the fixture makes an operation uncertain the same item says uncertain`; `targetName is the current name after a rename`.
- [ ] **Step 3 — Run:** FAIL. **Step 4 — Implement** (`listAuditEvents`, the two handlers; both leave the pending list). **Step 5 — Run:** PASS; `pnpm run contracts:openapi`; `EXPLAIN` of the served query on 200,000 synthetic rows uses both indexes (the plan's text goes into the run note). **Commit** `feat(api): the audit view and the activity timeline`. **Tag** `session-6-run-6.1` after Task C.

### Task C — nothing leaks, and audit that cannot write stops the work

- [ ] **Step 1 — Failing tests.**
  - `journey.test.ts`: one journey that performs every route and command with a writer; afterwards `every action of AUDIT_ACTIONS outside PENDING_WRITERS has at least one row`, and every row has an actor kind, an outcome and, for a request, the request id the response carried.
  - `diagnostics.test.ts`: the journey runs with run-time canaries as every secret value, password, TOTP code, recovery code, reset link and token; afterwards the canaries' bytes are in no container log, no `audit.event` row and no error body. `an incoming x-request-id is not echoed and is in no log line`. Control: a canary deliberately logged by the test's own fixture process is found.
  - `log-entries.test.ts`, `diagnostics-flags.test.ts`: P-109.
  - `tests/fault/audit/device.test.ts` (stack with `audit-full.override.yml`): fill the audit tmpfs; `reveal, export and machine resolve answer 503 and their bodies hold no value`; `no audit.event row with outcome success exists for those requests`; after space is freed the same requests succeed. Control: with the device writable, the three succeed.
  - `runtime cannot change audit`: `api_runtime` and `provisioner_runtime` get `42501` for `UPDATE`, `DELETE` and `TRUNCATE` on `audit.event` (the privilege matrix; this test names the three statements).
- [ ] **Step 2 — Run:** FAIL where code is missing. **Step 3 — Implement** what fails (flags, `ulimits`, log fields). **Step 4 — Run:** PASS. **Commit** `test(audit): coverage journey, canary sweep, a full audit device`.

**Registry:** FR-1.56, FR-1.58, FR-1.59, FR-1.80 → `SPIKE_PASS` (run note). FR-1.57, FR-1.81 and AC-1.23 wait for Runs 6.2 and 6.4. **Covers:** Review focus 4 (the view). **Done when:** the three tasks are green, the tag exists and is pushed, `pnpm run check` is green.

## Run 6.2 — Ops image, audit archive and 365-day retention (D08-S38)

**Files:** `apps/ops/Dockerfile`, `apps/ops/package.json`, `apps/ops/src/commands/audit-archive.ts`, `packages/backup/{package.json,src/r2.ts,src/index.ts}` (the R2 helpers move here from `infra/backup/retention-fixture/r2.ts`, which re-exports them), `packages/db/migrations/0016_audit_archive.sql`, `packages/db/src/repos/audit-archive.ts`, `infra/hosts/{ops-run.sh,ops-jobs.json}`, `infra/hosts/systemd/mykey-{audit-archive,bao-audit-rotate}.{service,timer}`, `infra/hosts/checks/bao-audit-rotate.sh`, `infra/backup/retention-fixture/provision.ts` (`LOCK_RULES` for the audit bucket), `scripts/{host,ci-scan}.ts`, `infra/dependencies.lock.json`, `tests/unit/hosts/{ops-jobs,units}.test.ts`, `tests/integration/archive/{segments,purge,rotation}.test.ts`, `tests/restore/retention/segment.cloud.test.ts`, `tests/staging/audit.staging.test.ts`, `tests/harness/privilege-matrix.ts`, `docs/decisions/{D-47-ops-image-on-the-host,D-48-audit-archive}.md`, `docs/runbooks/{audit,credential-custody,db-globals-inventory,network}.md`.

**Consumes:** Run 6.1 (actions, scopes); `s3ClientFor`, `loadR2Credentials`, `deleteObjectsChecked` (Run 1.9); `readAuditLog` (harness).

**Produces:**

```ts
// @mykey/backup — r2.ts
export interface ObjectStore { put(key: string, body: Buffer | Readable, opts: { bytes: number; sha256: string }): Promise<void>;
  get(key: string): Promise<Readable>; head(key: string): Promise<{ bytes: number } | null>; list(prefix: string): Promise<{ key: string; bytes: number }[]>;
  deleteChecked(keys: readonly string[]): Promise<DeleteOutcome[]>; abortStaleUploads(prefix: string, olderThanSeconds: number): Promise<number> }
export function r2Store(creds: R2Credentials, bucket: string): ObjectStore;
export function credentialsFromDirectory(dir: string): R2Credentials;          // two files: access-key-id, secret-access-key
// @mykey/db — repos/audit-archive.ts
export interface SegmentRow { sequence: bigint; stream: "app" | "openbao"; host: string; fromAt: Date; toAt: Date; rowCount: number; sha256: string; previousSha256: string | null; objectKey: string; verifiedAt: Date | null }
export function nextSegmentInterval(db: Queryable, stream: "app", now: Date): Promise<{ from: Date; to: Date } | null>;   // null: no closed day left
export function recountIntervals(db: Queryable): Promise<{ from: Date; to: Date; archived: number; present: number }[]>;
export function insertSegment(tx: Queryable, s: Omit<SegmentRow, "verifiedAt">): Promise<void>;
export function markVerified(tx: Queryable, sequence: bigint): Promise<void>;
export function purgeArchived(db: Queryable, before: Date): Promise<{ rows: number; intervals: number }>;                  // SELECT audit.purge_archived($1)
// @mykey/ops — commands/audit-archive.ts
export interface ArchiveResult { segments: number; lateSegments: number; rotatedFiles: number; purgedRows: number }
export function auditArchive(deps: { pool: pg.Pool; store: ObjectStore; host: string; rotatedDir: string | null; now: () => Date }): Promise<ArchiveResult>;
```

Design fixed here (P-110 … P-112, P-131; Doc 06 §12; FR-1.57, FR-1.81):

- **The image** builds from the repository root like the API's; its entrypoint is `node apps/ops/src/main.ts` with the permission model as far as the commands allow (`--allow-fs-read=/app,/run/mykey`, `--allow-fs-write=/run/mykey/*` for the jobs that write a scratch file). `ops-jobs.json` is validated by a unit test: every job names an existing command, a role of `ROLE_NAMES`, only secret files under `/etc/mykey/secrets/`, and a unit file that exists and calls `ops-run.sh <job>`.
- **Migration `0016`**: the table (owned by `migration_owner`; `maintenance` `SELECT, INSERT, UPDATE (verified_at, uploaded_at)`; `backup_reader` `SELECT`; nothing for the runtimes), the function, the revoke, the trigger. Before writing it: search `apps/` and `packages/` for a `DELETE` on `audit.event` and record "none" in the run note (P-131).
- **Late rows.** A row belongs to the interval of its `occurred_at`. `recountIntervals` compares; a difference is exported as a segment with the same interval and the next sequence, holding only ids that no earlier segment of that interval holds (the job reads the earlier segments' ids from its own verified objects, not from memory).
- **OpenBao's stream** has no rows to count: a rotated file is one segment, `row_count` its line count, interval from its first and last entry's time.
- **Purge** is called by the same job after the archive part, with `before = now − LIMITS.audit.retentionDays`. On staging and in tests nothing is that old; the tests age rows as the superuser.
- **Credentials on the host**: `host.ts <host> r2-install audit-archive` reads the S3 pair of the token `mykey-audit-archive-upload` from `~/.mykey/secrets/r2/` and writes it to `/etc/mykey/secrets/r2/audit-archive/` over stdin. The token can write and read objects of that one bucket.

### Task A — the ops image and one job on a host

- [ ] **Step 1 — Failing tests** (`ops-jobs.test.ts`, `units.test.ts`; `scripts/ci-scan.ts` unit tests): the table's rules above; `OWN_SCANNED_IMAGES` holds `ops`; `ops-run.sh` rendered for a job mounts that job's files and no other and carries no value.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** the Dockerfile, the wrapper, the table, `host.ts image` for three images, `host.ts <host> ops-secrets` (the two role passwords, on stdin). **Step 4 — Run:** PASS; `node scripts/ci-scan.ts images` green with the new image; on staging: `host.ts staging image` with the ops image, then `ops-run.sh` with the job `status-check` (`ops operations --organization <id>`) prints the same as the tunnel does. **Commit** `feat(ops): an image and a wrapper for jobs on the host`.

### Task B — segments, verification, purge

- [ ] **Step 1 — Failing tests.**
  - `segments.test.ts` (real PostgreSQL; `ObjectStore` over a local directory — the store's own behaviour is the cloud test's): `one closed day becomes one segment whose lines are the day's rows in order and whose sha256 is the object's`; `today is not archived`; `sequence and previous_sha256 chain over five days`; `a second run archives nothing`; `a row committed late with yesterday's timestamp` (a transaction opened before the cut, committed after the run) `is in a supplementary segment after the next run, exactly once`; `a missing sequence number or a wrong previous hash stops the job with exit 1 and writes nothing`; `an object that reads back different leaves verified_at null and the job fails`.
  - `purge.test.ts`: `rows older than 365 days inside a verified, fully counted interval are deleted and system.audit_purge says how many`; `rows 364 days old stay`; `an interval with an unverified segment keeps its rows`; `an interval whose recount exceeds its manifests keeps its rows`; `maintenance cannot DELETE directly` (`42501`); `UPDATE and TRUNCATE are refused for maintenance and for the owner's own session through the trigger`; `the purge's own audit row is never purged in the same call`.
  - `segment.cloud.test.ts` (R2, prefix `probe/`): `put, read back, compare`; `an overwrite of a segment within its lock is refused 409`; `list returns the manifest and the segment`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement**; set the three lock rules of the audit bucket with `provision.ts` (it never weakens a live rule) and record them in the run note. **Step 4 — Run:** PASS; `pnpm run db:check`. **Commit** `feat(ops): audit segments, verified off-host, purged only then`.

### Task C — OpenBao's file, and the job on staging

- [ ] **Step 1 — Failing tests.**
  - `rotation.test.ts` (local stack): a writer sends 400 audited requests with known correlation ids while `bao-audit-rotate.sh` runs twice; afterwards `every id has exactly one request entry and one response entry across the rotated files and the live file`; `the rotated file's last line parses`; `the live file is a new inode`. Control: the same count without rotation.
  - `audit.staging.test.ts`: `the timer units are enabled and their last run succeeded`; `yesterday's app segment and one openbao segment are in R2 under staging/, verified, and their manifests chain`; `the rotated local file is gone only where verified_at is set`; `the audit route on staging serves today's events of the test's own project`; a canary value written by the test is in no segment (the segment is downloaded and searched on the workstation, digests only in the output).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** the rotation script and both units; install on staging (`host.ts staging push`, `r2-install`). The first rotation ships the existing file of about 500 MB: run it by hand once and record the compressed size and the time. **Step 4 — Run:** PASS. **Commit** `feat(hosts): rotate and archive OpenBao's audit file`.

**Registry:** FR-1.81 → `SPIKE_PASS`; FR-1.57 stays `OPEN` until the alert of Run 6.4. **Covers:** Review focus 4 (late rows, purge). **Done when:** staging archives by timer, both streams verified, `pnpm run check` green.

## Run 6.3 — Limits and overload (D08-S40)

**Files:** `packages/contracts/src/{limits,capacity,routes}.ts`, `packages/operations/src/capacity.ts`, `apps/api/src/pipeline/{rate,inflight,capacity,route,machine,respond}.ts`, `apps/api/src/{app,server,large,log}.ts`, `apps/provisioner/src/worker.ts`, `packages/operations/src/lifecycle/archive.ts`, `apps/api/src/routes/machine.ts`, `infra/hosts/checks/status.sh`, `infra/compose/host.compose.yml` (the gate directory is already mounted), `tests/unit/api/{rate,capacity,inflight}.test.ts`, `tests/unit/contracts/pools.test.ts`, `tests/integration/limits/{rate,machine,large,capacity,starvation}.test.ts`, `tests/fault/audit/exhaustion.test.ts`, `tests/staging/limits.staging.test.ts`, `tests/harness/{api-worker,secrets-fixture}.ts`, `docs/decisions/D-49-limits-and-capacity.md`, `docs/runbooks/limits.md`.

**Consumes:** `bumpCounter`, `throttleDigest`, the `rate-limit` ring (D-28); `requestSource` (P-47); `createLargeGate`; the pipeline's step order (Session 3 report).

**Produces:**

```ts
// @mykey/contracts — capacity.ts
export const capacityRecordSchema: z.ZodType<CapacityRecord>;
export interface CapacityRecord { version: 1; observedAt: string; state: "ok" | "low"; volumes: Record<string, { freeBytes: number; sizeBytes: number; freeInodesPercent: number }> }
export function capacityState(volumes: CapacityRecord["volumes"]): "ok" | "low";            // the thresholds of P-115, from LIMITS.disk
export const EXPANDING_ROUTES: ReadonlySet<string>; export const REDUCING_ROUTES: ReadonlySet<string>;   // every mutating route id is in exactly one
// @mykey/operations — capacity.ts
export type CapacityReading = { kind: "ok" } | { kind: "low" } | { kind: "unknown"; cause: "missing" | "unreadable" | "invalid" | "stale" };
export function readCapacity(path: string, nowMs: number, io?: GateIo): Promise<CapacityReading>;      // stale: observedAt older than 180 s
// apps/api — pipeline/rate.ts
export type RateScope = "rl:source" | "rl:session" | "rl:credential" | "rl:reveal" | "rl:import" | "rl:export" | "rl:issue" | "rl:machine-miss";
export interface RateLimiter { hit(scope: RateScope, subject: string): Promise<void>;        // throws ApiError("rate_limited", …, { "retry-after": n }) or ApiError("dependency_unavailable")
  count(scope: RateScope, subject: string): Promise<number> }                                 // reads without bumping (the machine-miss check)
export function createRateLimiter(deps: { pool: pg.Pool; ring: KeyRing }): RateLimiter;
export const ROUTE_CLASS_LIMIT: Readonly<Record<string, { scope: RateScope; perMinute: number }>>;
// apps/api — pipeline/inflight.ts
export function createInflightGate(max: number): { enter(): boolean; leave(): void; current(): number };
```

Design fixed here (P-113 … P-115; Doc 06 §11; FR-1.60, FR-1.61; AC-1.24):

- **`AppDeps.limiter` and `AppDeps.capacity` are required**; the app refuses to start without them. Tests pass a real limiter on the fixture's database; the harness writes a capacity record and `deps.test.capacityMaxAgeMs` may widen the staleness only in tests.
- **Subjects**: source = `requestSource(…)`; session = the session id; credential = the credential id. Never a token, a cookie or an address in a row (the digest of D-28).
- **Every mutating route is classified**: a unit test fails for a route with `idempotent: true` or a writing auth path that is in neither `EXPANDING_ROUTES` nor `REDUCING_ROUTES`.
- **`status.sh`** computes the record with `df --output` on the four mount points and writes it with `mv` from a temporary file in the same directory; the file is world-readable (it holds sizes only).
- **`DETAILS`** in `respond.ts`: `capacity_exceeded` accepts `limit: "disk"`.
- **Runbook** `limits.md`: every limit, where it is enforced, what the caller sees, what the operator sees.

### Task A — rate limits

- [ ] **Step 1 — Failing tests** (`rate.test.ts` unit and integration; two API processes of the harness):
  - for each scope: `the request at the limit is served and the next is 429 with retry-after between 1 and 60`; `the limit holds across two processes`; `a new window serves again` (the fixture moves `window_start`, not the clock);
  - `the source limit is checked before the body is read`: a 400 KiB body over the limit is refused and the server read at most 64 KiB of it (the test's socket counts what was accepted);
  - `X-Forwarded-For from a peer that is not the trusted proxy does not change the subject`; `two scopes with the same subject string have different rows`;
  - `the counter table refuses` (the superuser revokes `INSERT, UPDATE` on `app.rate_limit` from `api_runtime`): a list, a reveal, a sign-in and a machine read each answer `503 dependency_unavailable` and nothing else happened (no audit row of success, no OpenBao request by correlation id). Control: with the rights back they succeed;
  - `sign-out, session revocation, credential revocation and archive are served at 121 requests in the minute`;
  - `machine.test.ts`: `30 requests with an unknown token cost 30 lookups in OpenBao's audit device; the next 30 cost none and answer 429`; `a valid credential from the same source is refused too until the window ends` (the stated price of the rule; in the runbook); `the 61st request of one credential is 429 while another credential of the same environment is served`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** the limiter, the steps, the two new values with their comment. **Step 4 — Run:** PASS; the route-contract tests still pass (`rate_limited` is already an error of every route). **Commit** `feat(api): rate limits per source, session, credential and action`.

### Task B — concurrency and order of work

- [ ] **Step 1 — Failing tests** (`inflight.test.ts`, `large.test.ts`, `pools.test.ts`, `starvation.test.ts`):
  - `64 requests held open by a handler stub; the 65th is 503 busy with connection: close; after one finishes the next is served`;
  - `a third import while two are running is refused before its body is read` (1 MiB body; the socket count); `an unauthenticated large request never takes a slot`;
  - `a request that sends its headers and then nothing is closed after 30 s and its slot is free`;
  - `the sum of all pools is at most LIMITS.db.maxConnections`; `the provisioner's pool is LIMITS.db.provisionerPool`;
  - `two resolves of one credential at once: one is 503 busy`; `a project archive over five environments logs in to the issuer once` (OpenBao's audit device);
  - `starvation`: an environment of 1,000 × 8 KiB; one credential calls `resolve` back to back for 20 s; a human `secrets.update` every second succeeds within three attempts each time. The measured worst case goes into the run note; a failure is handled as P-114 says.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS. **Commit** `feat(api): an in-flight gate, large slots before the body, pools from the limits`.

### Task C — disk pressure

- [ ] **Step 1 — Failing tests** (`capacity.test.ts` unit and integration; `exhaustion.test.ts`; `limits.staging.test.ts`):
  - `capacityState`: each threshold alone, one byte either side;
  - `readCapacity`: missing, a directory, 5,000 bytes, not JSON, a wrong version, `observedAt` 181 s old → `unknown` with its cause; 179 s old → the stored state;
  - `low`: every route of `EXPANDING_ROUTES` answers `507 capacity_exceeded { limit: "disk" }` and no row, operation or OpenBao request was made; every route of `REDUCING_ROUTES` succeeds with its audit row; a list and a reveal succeed;
  - `unknown`: the expanding routes answer `503 dependency_unavailable`; the reducing ones succeed;
  - `the record is read per request`: flipping the file between two requests flips the answer;
  - `exhaustion.test.ts` (PostgreSQL on a 300 MiB tmpfs in a compose override; the superuser fills it): `a reveal and a machine resolve answer 503 and hold no value; no response claims success`; after space is freed and PostgreSQL is back, both succeed;
  - `limits.staging.test.ts`: `status.sh` writes a record younger than 120 s whose volumes are the four expected; with the record replaced by a `low` one (the heartbeat timer stopped for the test, both restored in `finally`) a secret write on staging is 507 and a credential revocation succeeds.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS (staging after the deploy of Run 6.4; until then the staging file is committed and listed as not yet run in the run note). **Commit** `feat(api): disk pressure refuses growth and keeps reduction`.

**Registry:** FR-1.60, FR-1.61, AC-1.24 → `SPIKE_PASS` (after the staging file ran). **Covers:** Review focus 3. **Done when:** the three tasks are green locally, D-49 is written, `pnpm run check` is green.

## Run 6.4 — Health, operator status and alerts (D08-S40)

**Files:** `apps/api/src/{health,routes/health}.ts`, `workers/probe/src/{evaluate,index,store}.ts`, `workers/probe/wrangler.jsonc`, `workers/probe/migrations/0002_evaluated_at.sql`, `scripts/{probe,host}.ts`, `apps/ops/src/remote/{status,status-view}.ts`, `infra/hosts/checks/{status,heartbeat}.sh`, `.github/workflows/probe-watch.yml`, `scripts/probe-watch.ts`, `tests/unit/probe/{evaluate,heartbeat,watch,format}.test.ts`, `tests/unit/ops/status-view.test.ts`, `tests/integration/health/readiness.test.ts`, `tests/staging/{alerts,status}.staging.test.ts`, `docs/decisions/D-50-alerts-and-operator-status.md`, `docs/runbooks/{probe,operator-status,kms-and-unseal}.md`, `docs/evidence/session-6/alerts.md`.

**Consumes:** Run 6.3 (the capacity record); D-22 (`evaluate`, `recordHeartbeat`, `markDelivered`, the sink test); `hostStatus`, `parseHostStatus`; `LIMITS.monitoring`, `LIMITS.backup`, `LIMITS.machineToken.expiryWarningSeconds`.

**Produces:**

```ts
// workers/probe — evaluate.ts
export type Condition = "heartbeat_missing" | "health_failing" | "openbao_sealed" | "kms_unreachable" | "review_open" | "operations_unresolved"
  | "disk_low" | "audit_failing" | "capture_frozen" | "backup_stale" | "certificate_expiring" | "credential_expiring" | "firewall_unloaded" | "unit_failed" | "checks_unknown";
export interface Checks { sealed: boolean | null; kmsReachable: boolean | null; reviewOpen: number | null; operationsUnresolved: number | null; firewallLoaded: boolean | null;
  diskLow: boolean | null; auditFailing: boolean | null; captureSince: string | null | undefined; backup: { expected: boolean; newestEligibleCaptureAt: string | null } | null;
  certificates: { name: string; notBefore: string; notAfter: string }[] | null; credentialExpiring: number | null; unitsFailed: string[] | null }
export interface HeartbeatV2 { v: 2; bootId: string; observedAt: string; checks: Checks }
export function readHeartbeat(body: unknown): Heartbeat | HeartbeatV2 | null;                 // the three old key sets, or v2, strictly
export function reading(condition: Condition, beat: HeartbeatV2, nowMs: number, limits: ProbeLimits): "bad" | "good" | "unknown";
export function certificateThresholdMs(notBefore: string, notAfter: string): number;           // P-116
// apps/ops — remote/status-view.ts
export interface StatusLine { check: string; value: string; observedAt: string | null; state: "ok" | "bad" | "unknown" }
export function statusView(host: HostStatus, probe: ProbeState | null, nowMs: number): StatusLine[];
// scripts/probe-watch.ts
export function watchVerdict(state: { evaluatedAt: string } | null, nowMs: number): { alert: boolean; text: string };
```

Design fixed here (P-116, P-117; Doc 06 §12, §18.1; FR-1.62, FR-1.63, FR-1.95; AC-1.18, 1.25, 1.49):

- **`captureSince`** distinguishes three things: a string (a capture is running since then), `null` (idle) and absent (the host could not tell → unknown). Every other field uses `null` for unknown.
- **`status.sh`** gains: `firewallLoaded` (it has `firewall.loaded`), `diskLow` (from its own record), `auditFailing` (the API's last `health_down` cause, the device directory's writability, `systemctl is-failed` of the two archive units, and the oldest unarchived closed day from PostgreSQL), `captureSince` and `backup` (from `app.service_control` and `app.backup_pair`; `expected` from `MYKEY_BACKUP_EXPECTED` in `host.env`, which Run 6.5 sets), `certificates` (the public certificate, the internal PKI's, the KMS client certificate: names and dates only), `credentialExpiring` (the count the credential repository already defines), `unitsFailed` (`systemctl list-units 'mykey-*' --state=failed`).
- **Deploy order**: the Worker first (it accepts both shapes), then the hosts. `prod` sends version 2 as well; with `inService: false` its `health_failing` and `backup_stale` stay silent and everything else is live.
- **The watcher** needs `PROBE_READ_TOKEN`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as repository secrets; the workflow has `permissions: {}` and runs `node scripts/probe-watch.ts` on the pinned Node with no install step.
- **KMS certificate lifetime**: Task B reads `okms`'s help for a validity option of a CSR-based certificate and, when there is one, issues one for staging with it; the result — longer certificates, or "30 days is all there is" — goes into `kms-and-unseal.md` and D-50.
- **Runbook** `operator-status.md`: the command, every line of its output, what `unknown` means and what to do first.

### Task A — the evaluator

- [ ] **Step 1 — Failing tests** (`evaluate.test.ts`, `heartbeat.test.ts`, `format.test.ts`):
  - `readHeartbeat accepts the three old key sets and v2, and refuses v2 with an unknown key, a missing check or a wrong type`;
  - for each new condition: `opens on bad after its grace`, `resolves on good`, `a null field keeps it open and sends no resolved` (M-4);
  - `a field that is null for longer than the reported grace opens checks_unknown, which resolves when every field is known`;
  - `capture_frozen`: 599 s → nothing, 601 s → opened; `backup_stale`: `expected: false` → never; a capture 93,601 s old → opened; `newestEligibleCaptureAt: null` with `expected: true` → opened;
  - `certificateThresholdMs`: a 90-day certificate → 30 days; a 30-day certificate → 10 days; `certificate_expiring` names no certificate in its text;
  - `inService: false` silences `health_failing` and `backup_stale` only;
  - `a resolved alert whose delivery failed is in the next evaluation's alerts again; one that was delivered is not`;
  - `formatAlert` for every condition matches `^MyKey [a-z]+: [a-z_]+ (opened|reminder|resolved) \(since [0-9TZ:-]+ UTC\)$`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** (`evaluate.ts`, `index.ts`, the D1 migration, `evaluatedAt`, the test-alert route). **Step 4 — Run:** PASS; `node scripts/probe.ts sinktest up`, post both heartbeat shapes, `rows`, `down`. **Commit** `feat(probe): nine more conditions; unknown is not healthy`.

### Task B — readiness, the host's checks, the status view

- [ ] **Step 1 — Failing tests** (`readiness.test.ts`, `status-view.test.ts`, `status.staging.test.ts`):
  - `/health is 503 {"status":"down"} while api_runtime cannot insert into audit.event, and 200 again afterwards; the probe leaves no row`; `/health is 503 while OpenBao's audit device is full` (the override of Run 6.1); `the body is exactly {"status":"up"} or {"status":"down"} in every case` and carries no other header than today's;
  - `statusView`: every field of `HostStatus` has a line; an `observedAt` older than 180 s → `unknown`; a null → `unknown`; `no line holds a path under /etc/mykey/secrets, a token or an address of a client`;
  - `operationsUnresolved does not count an accepted provisioning operation younger than 600 s and counts it afterwards` (the query of `status.sh`, run against the fixture database) (M-3);
  - `status.staging.test.ts`: `host.ts staging status --json` has every check with an observation time younger than 120 s; KMS reachability and seal state are two lines; the owner's session gets 404 for each path of P-117 through the public name, and the same paths answer nothing on the proxy's dashboard port from the VPN.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement**; deploy to staging (Worker, then API image with `MYKEY_BUILD`, `status.sh`, `heartbeat.sh`), then production's `status.sh` and `heartbeat.sh` only — **no API deploy on production here**. **Step 4 — Run:** PASS; the staging file of Run 6.3 Task C now runs. **Commit** `feat(hosts): readiness covers audit; one private status view`.

### Task C — every alert, seen

- [ ] **Step 1 — The drill file** `alerts.staging.test.ts`: one test per condition. Each announces itself in the log, causes the condition on staging, waits for the row `opened` with `delivered: 1` in the probe's alert log, removes the cause in `finally`, waits for `resolved`, and appends the evidence line to `docs/evidence/session-6/alerts.md`. Causes: `disk_low` — a sparse-free file that takes the audit volume under its threshold; `audit_failing` — the archive unit made to fail (`systemctl start` with a wrong store path through a drop-in); `capture_frozen` — the control row held in `draining` by `maintenance` for 11 minutes (the one long test; no product write is attempted meanwhile, and the window is in `staging-windows.md`); `backup_stale` — `MYKEY_BACKUP_EXPECTED=yes` with no pair, set back to `no` in `finally` (the evidence line gets its second half in Run 6.5, when a real pair keeps the condition closed with the flag set for good); `certificate_expiring` — a certificate entry with `notAfter` in five days injected through the test hook file `/etc/mykey/checks/certificates.extra.json`; `credential_expiring` — a credential issued with a TTL of six days, revoked in `finally`; `firewall_unloaded` — `nft flush ruleset` is **not** used: the check reads a flag file that the test hook sets, and the unit test of `status.sh` covers the real reading; `unit_failed` — a throw-away unit `mykey-drill.service` that exits 1; `checks_unknown` — `jq` removed from the heartbeat's path for four minutes; `heartbeat_missing` — the timer stopped; the six of Session 2 are run again as they are.
- [ ] **Step 2 — Outside the host** (sink-test Worker, three host entries): a name that does not resolve, a name of our zone that points at staging and is not in its certificate, and staging itself with the API stopped → `health_failing` for each (AC-1.25: DNS failure, invalid public certificate, unreachable service). The DNS record is created and removed with the Cloudflare API by the test.
- [ ] **Step 3 — On demand:** `node scripts/probe.ts alert-test staging` → the message arrives; its row is in the log.
- [ ] **Step 4 — Run** the file once, condition by condition. **Commit** `test(staging): every alert opened, delivered and resolved`.

### Task D — who watches the Worker

- [ ] **Step 1 — Failing tests** (`watch.test.ts`): `evaluatedAt 9 minutes old → no alert; 11 minutes → alert; no answer → alert; the text holds no token`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** the script and the workflow; `gh secret set` three times from stdin. **Step 4 — Prove:** `gh workflow run probe-watch` → green and silent; then with the Worker's cron removed for 12 minutes (`probe.ts deploy --no-cron`, restored afterwards) a second manual run sends the message. Record both run ids. **Commit** `feat(ci): a watcher for the probe itself`.

**Registry:** FR-1.57, FR-1.62, FR-1.63, FR-1.95, AC-1.18, AC-1.23, AC-1.25, AC-1.49, PO-23 → `SPIKE_PASS`; PO-14 keeps `SPIKE_PASS` with the new evidence. **Covers:** Review focus 5. **Done when:** every condition has its evidence line, staging and the probe are clean, D-50 is written, `pnpm run check` is green.

## Run 6.5 — Daily paired backup (D08-S41) · OWNER: OWN-4 afterwards

**Files:** `packages/db/migrations/0017_capture_barrier.sql`, `packages/db/src/repos/{capture,pairs}.ts`, `packages/operations/src/capture/{barrier,coordinator}.ts`, `packages/operations/src/{credentials/revoke,lifecycle/archive,secrets/protocol,credentials/issue,lifecycle/reactivate}.ts` (their own capture checks go), `packages/auth/src/{routes,sessions}.ts`, `apps/api/src/pipeline/{capture,route}.ts`, `apps/api/src/{operation-sweep,routes/machine}.ts`, `apps/provisioner/src/worker.ts`, `packages/backup/src/{manifest,sign,bundle,index}.ts`, `apps/ops/src/commands/{capture,pair}.ts`, `infra/hosts/backup/{steps,backup.sh}.ts`, `infra/hosts/systemd/mykey-{backup,capture-recover}.{service,timer}`, `infra/hosts/ops-jobs.json`, `infra/hosts/backup/trust/`, `scripts/host.ts` (`backup-init`, `backup-custody`, `r2-install`), `infra/backup/retention-fixture/provision.ts`, `tests/unit/backup/{manifest,sign,steps}.test.ts`, `tests/integration/capture/{barrier,coordinator,pair}.test.ts`, `tests/fault/capture/{compete,crash}.test.ts`, `tests/staging/backup.staging.test.ts`, `tests/harness/{privilege-matrix,pair-fixture}.ts`, `docs/decisions/{D-51-capture-barrier,D-52-pair-format-and-custody}.md`, `docs/runbooks/{backup,custody-map,credential-custody,db-globals-inventory}.md`, `docs/evidence/cost-sheet.md`.

**Consumes:** the spike (`infra/backup/pair-spike/*`: the step builders, `freeze`, `boundaryOf` — read for what they do, then superseded: the spike directory is deleted in Task C's commit); Run 6.2 (`ObjectStore`, the ops image); Run 6.4 (`captureSince`, `backup` in the heartbeat); `expectCatalogMatchesBackend`, `createCredentialsFixture`.

**Produces:**

```ts
// @mykey/db — repos/capture.ts
export type CaptureMode = "idle" | "draining" | "capturing";
export function captureMode(db: Queryable, opts?: { lock: "share" }): Promise<{ mode: CaptureMode; pairId: string | null; since: Date }>;
export function setCaptureMode(tx: Queryable, from: CaptureMode, to: CaptureMode, pairId: string | null, owner: string): Promise<boolean>;   // as maintenance; false: the row was not in `from`
export function invalidateCapture(tx: Queryable, reason: "sign_out" | "session_revoke" | "credential_revoke" | "archive"): Promise<void>;       // SELECT app.capture_invalidate($1)
export function invalidationsBetween(db: Queryable, from: Date, to: Date): Promise<number>;
// @mykey/db — repos/pairs.ts
export type PairStatus = "candidate" | "eligible" | "ineligible" | "expired";
export interface PairRow { id: string; host: string; captureStartedAt: Date; status: PairStatus; eligibleUntil: Date | null; objectKey: string | null; manifestSha256: string | null; invalidReason: string | null; verifiedAt: Date | null; deletedAt: Date | null }
export function insertCandidate(tx: Queryable, p: { id: string; host: string; captureStartedAt: Date; boundary: unknown; schemaRevision: string; releaseBuild: string; keyRefs: unknown }): Promise<void>;
export function markEligible(tx: Queryable, id: string, v: { objectKey: string; manifestSha256: string; artifactHashes: unknown; eligibleUntil: Date }): Promise<boolean>;   // only from candidate, only when no invalidation crossed it
export function markIneligible(tx: Queryable, id: string, reason: string): Promise<boolean>;
export function newestEligible(db: Queryable, host: string): Promise<PairRow | null>;
// @mykey/operations — capture/barrier.ts
export const CAPTURE_SQLSTATE = "MKC01";
export function isCaptureRefusal(error: unknown): boolean;
// @mykey/operations — capture/coordinator.ts
export const DRAIN_DEADLINE_MS = 30_000; export const FROZEN_DEADLINE_MS = 120_000;
export function beginCapture(pool: pg.Pool, owner: string): Promise<{ kind: "capturing"; pairId: string; captureStartedAt: Date; boundary: unknown } | { kind: "busy" }>;
export function recordCapture(pool: pg.Pool, pairId: string, manifest: PairManifest): Promise<void>;     // candidate row, audit, mode → idle, one transaction
export function abortCapture(pool: pg.Pool, owner: string, reason: "aborted" | "deadline"): Promise<{ released: boolean; pairId: string | null }>;
// @mykey/backup — manifest.ts, sign.ts
export const PAIR_FORMAT = "mykey-pair/1"; export const ARTIFACT_NAMES = ["postgres.dump", "globals.sql", "openbao.snap"] as const;
export interface PairManifest { /* P-119 */ } export const pairManifestSchema: z.ZodType<PairManifest>; export const eligibilitySchema: z.ZodType<Eligibility>;
export function canonicalJson(value: unknown): Buffer;
export function signEligibility(body: Omit<Eligibility, "signature">, key: KeyObject, keyId: string): Eligibility;
export function verifyEligibility(e: Eligibility, trust: ReadonlyMap<string, KeyObject>): { ok: true } | { ok: false; cause: "unknown_key" | "signature" | "format" };
export function loadTrust(dir: string, host: string): ReadonlyMap<string, KeyObject>;
```

Design fixed here (P-118 … P-120, P-131; Doc 06 §13; FR-1.66; AC-1.27; PO-13, PO-21):

- **Migration `0017`**, by hand in the generated file: the trigger on `service_control`; `app.backup_invalidation (id uuid, at timestamptz default now(), reason text)` (`api_runtime`: nothing directly; the function inserts); `app.capture_invalidate`; the barrier trigger function and one trigger per table (the table list is generated by a query over `pg_tables` in the test and compared with the triggers that exist: a table added later without a trigger fails `barrier.test.ts`); the new columns of `backup_pair` (`host`, `object_key`, `manifest_sha256`, `invalid_reason`, `verified_at`, `deleted_at`); the revokes. Before writing it: a search for writers of `backup_pair` and `service_control` outside the spike, recorded as "none" (P-131).
- **The barrier does not replace the gate**: it is checked after the gate and the limits, before validation, as one step `captureStep(route)`; the reducing routes call `invalidateCapture` inside their own transaction instead.
- **The provisioner** asks `captureMode` before taking a job (a deferred job is sent again as it is for a closed gate) and treats `MKC01` as "later".
- **A session that expired** is still denied when the delete that tidies it up is refused; **`last_used_at`** is skipped.
- **Host steps** (`steps.ts`) are pure functions that return shell text, unit-tested as text: each container mounts only the one artifact it reads or writes (M2); the dump runs in the pinned PostgreSQL image on the database's bridge; the snapshot is taken with `curl` inside the OpenBao container's network; Restic runs with `--network none`; only the ops container (host network) reaches R2.
- **The backup password** is used by Restic through `RESTIC_PASSWORD_FILE` on a read-only mount; the signing key is read by `ops pair verify` alone.
- **Deadlines.** The frozen part is bounded by `FROZEN_DEADLINE_MS` in the script (`timeout`) and by `abortCapture` in `ExecStopPost`; the whole unit by `TimeoutStartSec=7200`.
- **Staging's bucket**: the 11 spike objects are deleted with `deleteObjectsChecked` (they carry no lock), then the rule `pairs/` 30 days is set. From that moment an object under `pairs/` stays 30 days: the tests of this run write real pairs only through the product's job, a handful in total.
- **Runbook** `backup.md`: what runs when, how to read a failed unit, how to run a capture by hand, what `ineligible` reasons mean, the custody set (what a restore needs that R2 does not hold: the backup password, the trust anchor, OpenBao's recovery keys, access to the KMS key, an R2 read token).

### Task A — the barrier

- [ ] **Step 1 — Failing tests** (`barrier.test.ts`; real stores; the mode is set by a `maintenance` pool):
  - `api_runtime, provisioner_runtime and backup_reader cannot change service_control` (each statement; `42501` or the trigger's error); `maintenance can`; `api_runtime can still lock the row FOR SHARE`;
  - `every table of app and auth except the four has the barrier trigger`;
  - in `capturing`, a write to each such table as `api_runtime` raises `MKC01`; in `draining` and `idle` it does not; `audit.event` and `rate_limit` accept writes in every mode;
  - in `draining` and in `capturing`, every route of `EXPANDING_ROUTES`, sign-in, password change, enrolment, `session.activity` and reset completion answer `503 busy` and wrote nothing; lists, history, reveal, export and machine resolve are served **with their audit rows**;
  - `sign-out, session revocation, credential revocation and archive succeed in capturing`, each leaves one `backup_invalidation` row, and the revoked token is gone from OpenBao;
  - `a request refused by the barrier costs no OpenBao request` (correlation id absent from the device);
  - `a session past its lifetime is denied in capturing and its row is still there afterwards`;
  - `the provisioner takes no job in draining and takes it after idle`; `the API's sweep tick does nothing while not idle`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** the migration, the repositories, the step, the swallowing sites; remove the six inline checks. **Step 4 — Run:** PASS; the whole integration suite once (the barrier touches every write path); `pnpm run db:check`. **Commit** `feat(db): writing is closed by a trigger while a pair is captured`.

### Task B — the coordinator, against everything at once

- [ ] **Step 1 — Failing tests.**
  - `coordinator.test.ts`: `beginCapture waits for an operation that is executing and then answers capturing`; `with an operation that stays executing for 31 s it answers busy and the mode is idle again`; `two coordinators: one captures, the other is busy`; `recordCapture writes the candidate, system.backup_capture success and idle in one commit`; `abortCapture releases only the caller's own freeze, marks the candidate ineligible (aborted) and writes system.backup_invalidated`; `abort when idle is a no-op that says so`.
  - `tests/fault/capture/compete.test.ts` — the test of Review focus 1. Forty captures in a row (local stack; the artifacts are really taken and restored into scratch instances by `pair-fixture.ts`). During all of them eight workers run without pause: secret writes and deletes, imports, issuance, revocation, archive and reactivation, project and environment creation (so provisioner jobs), sign-in with TOTP, session activity, password change, and machine resolves. For every pair that ends `eligible`: restore both halves, then `expectCatalogMatchesBackend` on the restored copies for every environment, every `active` credential row has a live accessor in the restored OpenBao and every machine-policy accessor there has an `active` row, no operation is `executing`, no effect slot is held, and the sessions and accounts tables pass the auth invariants. For every pair crossed by a reducing action: it is `ineligible` with reason `access_reduction` and that action succeeded. At least five pairs of each kind must occur, or the test fails as "did not exercise". No worker ever received a 5xx other than `busy`.
  - `tests/fault/capture/crash.test.ts`: the coordinator killed in `draining`, in `capturing` and after the artifacts; each time the recover unit's command releases, the product writes again within the test's deadline, the candidate is `ineligible`, and the scratch directory is empty.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** `coordinator.ts`, `ops capture begin|record|abort`, `pair-fixture.ts`. **Step 4 — Run:** PASS (one heavy job; about 25 minutes). The freeze's measured length (median, worst) goes into the run note. **Commit** `feat(ops): the capture coordinator drains, freezes, records, releases`.

### Task C — the pair: pack, upload, verify, sign

- [ ] **Step 1 — Failing tests** (`manifest.test.ts`, `sign.test.ts`, `steps.test.ts`, `pair.test.ts`):
  - `canonicalJson is stable under key order and rejects NaN, undefined and a Date`; `a signature verifies with the right key and fails after one changed byte of the manifest, with another key, and with a key id that is not in the trust directory`;
  - `the manifest schema refuses a fourth artifact, a missing one and a sha256 of the wrong length`; `no manifest field name matches /password|secret|token|private/i` except `backupPassword`, whose value must match `^[a-z]+/[0-9]+$`;
  - every step builder: its text mounts one artifact, names no secret value, and quotes the pair id;
  - `pair.test.ts` (local stack; `ObjectStore` over a directory): `upload then verify makes the pair eligible with eligible_until = capture + 30 days and writes system.backup_eligible`; `a bundle that reads back with one changed byte stays candidate and the job exits 1`; `restic check failing stays candidate`; `a pair whose capture window holds an invalidation becomes ineligible, not eligible`; `two hours and one second after the capture a candidate is ineligible (deadline)`; `markEligible is refused for an ineligible pair`;
  - cloud (`tests/restore/retention/cleanup.cloud.test.ts`, prefix `probe/`): a real bundle of the local stack is put, read back and compared through `r2Store`; its size and the upload time go into the cost sheet.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** `@mykey/backup`, `ops pair upload|verify`, `host.ts backup-init|backup-custody|r2-install`; delete `infra/backup/pair-spike/` and `tests/staging/pair.staging.test.ts` (superseded by Task D; D-52 says so). **Step 4 — Run:** PASS. **Commit** `feat(backup): a signed, verified pair as one locked object`.

### Task D — on staging, by timer

- [ ] **Step 1 — Install** (window in `staging-windows.md`): deploy the API and provisioner images with migration `0017`; `host.ts staging backup-init`; commit the public key; remove the spike objects and set the lock rule; `r2-install pairs`; install the units; `MYKEY_BACKUP_EXPECTED=yes`.
- [ ] **Step 2 — `backup.staging.test.ts`:** `a capture started by the unit ends eligible; its two objects exist; eligible.json verifies against the committed key`; `during the capture a staging write gets 503 busy at most for the measured freeze and succeeds afterwards; a reveal during the capture succeeds`; `the freeze lasted less than 60 s` (recorded); `a credential revoked during a second capture is revoked and that pair is ineligible`; `the bundle downloaded to the workstation restores with the custody password and its three digests equal the manifest's` (digests only in the output); `no object under pairs/ is larger than 5 GiB`; `the password, the private key and the R2 secret are in no unit file, no journal line of the units and no process list taken during the run` (`countOnHost`, with controls); `after the timer's own 03:00 run the heartbeat's newestEligibleCaptureAt is that capture` — this last test is the checkpoint `backup-first-night`, due the next morning.
- [ ] **Step 3 — Custody.** `host.ts staging backup-custody`; tell the owner (OWN-4); record the owner's "copied" in `owner-requests.md`. Complete the `backup_stale` evidence line of Run 6.4.
- [ ] **Step 4 — Run:** PASS. **Commit** `feat(hosts): the daily pair on staging`.

**Registry:** FR-1.66, AC-1.27 → `SPIKE_PASS`; PO-13, PO-21 keep `SPIKE_PASS` with the product's evidence. **Covers:** Review focus 1. **Done when:** staging holds at least two eligible pairs made by the unit, the custody copy is confirmed, D-51 and D-52 are written, `pnpm run check` is green.

## Run 6.6 — Retention, clean-up and cost (D08-S41)

**Files:** `packages/backup/src/retention.ts`, `apps/ops/src/commands/pair.ts` (`retention`), `infra/hosts/systemd/mykey-pair-retention.{service,timer}`, `infra/hosts/ops-jobs.json`, `infra/backup/retention-fixture/{provision,cleanup}.ts`, `tests/restore/retention/{fixture,cleanup}.cloud.test.ts`, `tests/unit/backup/retention.test.ts`, `tests/integration/capture/retention.test.ts`, `tests/staging/checkpoints/pair-30-day.staging.test.ts`, `docs/evidence/session-1/retention-fixture.json`, `docs/evidence/cost-sheet.md`, `docs/decisions/D-53-retention-and-cleanup.md`, `docs/runbooks/backup.md`.

**Consumes:** Run 6.5 (`PairRow`, `ObjectStore`, `verifyEligibility`, `pair-fixture.ts`); Run 1.9 (the fixture's evidence file, its tokens, `deleteObjectsChecked`); Run 2.7 (the loss-test KMS key).

**Produces:**

```ts
// @mykey/backup — retention.ts
export interface RetentionPlan { delete: PairRow[]; keep: { pair: PairRow; why: "newest_eligible" | "not_expired" | "candidate_in_deadline" }[]; orphans: string[] }   // orphans: object prefixes without a row
export function planRetention(rows: readonly PairRow[], objects: readonly { key: string }[], host: string, now: Date): RetentionPlan;
export interface CleanupResult { deleted: string[]; refused: { key: string; code: string }[]; stillPresent: string[]; uploadsAborted: number }
export function applyRetention(deps: { pool: pg.Pool; store: ObjectStore; host: string; now: () => Date }, plan: RetentionPlan): Promise<CleanupResult>;
export function keyReadable(kmsKeyId: string, probe: (keyId: string) => Promise<boolean>): Promise<boolean>;      // used by the restore's refusal
```

Design fixed here (P-121; Doc 06 §11, §13; FR-1.78; AC-1.36 per D-04; PO-9; R2-L1; COST-B1):

- **`planRetention` is pure** and never returns the host's newest eligible pair in `delete`, even when it is expired and even when it is the only pair. An `ineligible` pair is deleted when its object's lock has ended (the lock rule holds every object 30 days, eligible or not). An object prefix without a row is reported as an orphan and **not** deleted by the job: the operator decides (`ops pair retention --delete-orphans <prefix>`).
- **Order per pair**: `eligible.json`, a `HEAD` that proves it gone, the row `expired` with `deleted_at`, then `bundle.tar`. A refusal leaves the row as it is and is counted in `refused`; three days of refusals for an object whose lock should have ended make the unit exit 1 (an alert).
- **The fixture's end** (`cleanup.ts`, run once by hand): download `pair-20261111-1`, restore it with the fixture's password into scratch instances, compare its artifacts' digests with its manifest; then delete all fixture objects, `probe/` and `scratch/` included, with the verified delete; write checkpoint 3 into `retention-fixture.json` with the observed outcomes per object. The bucket stays, with its rules, for the cloud tests.
- **The cloud tests after this run** make their own objects under `probe/` (600 s): overwrite refused, single delete refused, bulk delete with HTTP 200 and per-object errors, and — in the same file, with the objects of a run at least eleven minutes earlier found by listing — deletion after the lock. The first run on a day has no earlier objects and says so in one informational test that passes; a second run eleven minutes later is part of this run's proof.
- **Cost sheet**: the size of a used staging pair (after the journeys of Sessions 4 and 5 and 1,000 secrets), 30 pairs a month at the rates of 11 Nov 2026, the audit segments' size per day, class A and B operations per day, and the line "no invoice figure yet" until one exists.

### Task A — the fixture is finished and the guard is gone

- [ ] **Step 1 — Failing tests:** rewrite `fixture.cloud.test.ts` as above (it fails until the helper that creates run-time objects exists). **Step 2 — Run:** FAIL. **Step 3 — Implement**; run `cleanup.ts` once. **Step 4 — Run:** `pnpm run test:cloud` green, twice, eleven minutes apart; the evidence file shows checkpoint 3 observed and lists no object. **Commit** `test(cloud): the retention fixture is restored, cleaned up and no longer dated`.

### Task B — the retention job

- [ ] **Step 1 — Failing tests.**
  - `retention.test.ts` (pure): `the newest eligible pair is kept when expired`; `with one pair nothing is deleted`; `an expired pair beside a newer eligible one is deleted`; `a candidate inside its two hours is kept, one outside is planned as ineligible first`; `pairs of another host are not in the plan`; `an object prefix without a row is an orphan, never a deletion`.
  - `retention.test.ts` (integration; directory store with a switch that refuses keys): `eligible.json goes first; when bundle.tar is refused the row is expired, the refusal is recorded and the next run tries only the bundle`; `a delete that answers success for a key that is still there is reported as stillPresent and the job exits 1`; `system.backup_cleanup carries the three counts`; `stale multipart uploads are aborted`.
  - `cleanup.cloud.test.ts` (`probe/`): a pair-shaped prefix of a run eleven minutes earlier is cleaned up by `applyRetention` with the real store; one made now is refused with 409 and reported, not thrown.
  - KMS: `keyReadable` answers false for the loss-test key of Run 2.7 and true for staging's seal key (staging test in `backup.staging.test.ts`).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement**; install the unit on staging. **Step 4 — Run:** PASS; on staging the unit runs, deletes nothing (nothing is 30 days old) and says so. **Commit** `feat(ops): retention deletes verified, in order, never the last pair`.

### Task C — cost and the 30-day checkpoint

- [ ] **Step 1 —** Fill the cost sheet from the measured sizes. **Step 2 —** Write `pair-30-day.staging.test.ts` (out of the staging project until 18 Dec 2026, like `kms-expiry`): the oldest eligible staging pair is restored into scratch instances; then the retention unit deletes it and its objects are gone by `HEAD`. Add the checkpoint to CLAUDE.md's dated items at the gate. **Commit** `docs(evidence): cost of pairs and archive; the 30-day checkpoint`.

**Registry:** FR-1.78, AC-1.36, PO-9, R2-L1, COST-B1 → `SPIKE_PASS`. **Done when:** `test:cloud` is green without a dated guard, the retention unit runs on staging, D-53 is written, `pnpm run check` is green.

## Run 6.7 — Quarantine gate v2 and restore tooling (D08-S42)

**Files:** `packages/contracts/src/gate-record.ts`, `packages/operations/src/gate.ts`, `packages/db/migrations/0018_incarnation.sql`, `packages/db/src/repos/capture.ts` (`incarnation`), `packages/openbao/src/admin.ts` (`raftSnapshot`, `raftRestore`, `listNamespaces`, `incarnation`, `rotateSecretId`, `generateRoot`), `apps/api/src/{server,app,pipeline/gate}.ts`, `apps/api/src/routes/{secrets,credentials,lifecycle,imports}.ts`, `apps/provisioner/src/worker.ts`, `apps/ops/src/commands/{restore-invalidate,restore-verify,verify-journey}.ts`, `infra/hosts/backup/restore-steps.ts`, `scripts/host.ts` (`gate` v2, `restore`, `tunnel verify`), `infra/compose/host.compose.yml`, `tests/unit/gate/v2.test.ts`, `tests/unit/backup/restore-steps.test.ts`, `tests/integration/restore/{gate,listener,invalidate,verify,full}.test.ts`, `tests/fault/restore/interrupted.test.ts`, `tests/harness/restore-fixture.ts`, `docs/decisions/{D-54-gate-v2-and-verification-listener,D-55-restore-by-class}.md`, `docs/runbooks/{service-gate,restore,db-globals-inventory,custody-map}.md`.

**Consumes:** Run 6.5 (the pair, the trust anchor, `pair-fixture.ts`); Run 6.6 (`keyReadable`); `reconcileCredentials`, `OpenBaoAdmin.listAccessors`, `tokenRevokeAccessor` (Session 5); `initiateReset` (Session 3); `applyRoles`; D-18, D-25, D-26.

**Produces:**

```ts
// @mykey/contracts — gate-record.ts
export const gateRecordV2Schema: z.ZodType<GateRecordV2>;
export interface GateRecordV2 { version: 2; state: "open" | "closed"; gateEpoch: number; hostInstanceId: string; backendIncarnation: string;
  origin: { kind: "fresh_install"; id: string } | { kind: "restore"; pairId: string }; releaseBuild: string; reportSha256: string | null; phase: "verifying" | "serving"; writtenAt: string }
export const verificationReportSchema: z.ZodType<VerificationReport>;
export interface VerificationReport { format: "mykey-verification/1"; host: string; hostInstanceId: string; backendIncarnation: string; releaseBuild: string; origin: GateRecordV2["origin"];
  createdAt: string; checks: { id: string; state: "ok" | "failed" | "unknown"; observed: string }[]; members: number }
export const REQUIRED_CHECKS: { restore: readonly string[]; deploy: readonly string[] };
// @mykey/operations — gate.ts
export type GateAdmits = "all" | "verification" | "none";
export type GateCause = "missing" | "unreadable" | "invalid" | "version" | "host" | "incarnation" | "build" | "closed";
export interface GateExpect { hostInstanceId: string; backendIncarnation: string; releaseBuild: string }
export function readGate(path: string, expect: GateExpect, io?: GateIo): Promise<{ admits: GateAdmits; cause: GateCause | null; record: GateRecordV2 | null }>;
export function mayOpen(report: VerificationReport, expect: GateExpect, kind: "restore" | "deploy", nowMs: number): { ok: true; sha256: string } | { ok: false; cause: string };
// @mykey/ops — commands
export function restoreInvalidate(deps: RestoreDeps): Promise<{ sessions: number; accounts: number; resetTokens: number; credentials: number; accessorsRevoked: number; namespaces: number; secretIdsRotated: number; operationsClosed: number }>;
export function restoreVerify(deps: RestoreDeps, journey: JourneyResult | null): Promise<VerificationReport>;
export function verifyJourney(deps: { baseUrl: string; origin: string; owner: OwnerSecrets; expectValueSha256?: { environmentId: string; name: string; sha256: string } }): Promise<JourneyResult>;
```

Design fixed here (P-122 … P-124; Doc 06 §14; FR-1.67–1.69, FR-1.86, FR-1.87; Doc 10 §10 item 5):

- **Migration `0018`**: `service_control.backend_incarnation text`, `restored_from_pair uuid`, both writable by `maintenance` only (the trigger of `0017` already says so). A fresh install writes its incarnation in `host.ts <host> db-init`; staging and production get theirs in Run 6.9's first deploy.
- **`REQUIRED_CHECKS.restore`**: `pair_signature`, `pair_digests`, `schema_revision`, `openbao_readable`, `sessions_none`, `accounts_recovery_pending`, `reset_tokens_none`, `machine_accessors_none` (every namespace), `credentials_all_revoked`, `approle_secret_ids_rotated`, `root_tokens_revoked`, `control_row_idle`, `incarnation_three_places`, `operations_none_executing`, `catalog_matches_backend` (every environment, through `verifyOrganization` and the name comparison), `members_confirmed`, `journey_owner_enrolled`, `journey_reveal_digest`, `journey_mutation_refused`, `old_credentials_refused`. **`.deploy`**: `schema_revision`, `openbao_readable`, `incarnation_three_places`, `control_row_idle`, `journey_sign_in`, `journey_reveal_digest`, `journey_mutation_refused`, `previous_gate_closed`. A check the command could not perform is `unknown`, and `mayOpen` refuses `unknown` as it refuses `failed`.
- **`gateOpen()`** at write time becomes `admits === "all"`; the routes that call it are unchanged otherwise. An import whose gate closes mid-way leaves the remaining entries `not_attempted` for a resume instead of rejecting them (M-1).
- **`old_credentials_refused`** is filled by the caller: the restore passes what it knows of the old world as digests and accessors only (never a token in the report).
- **`restore-steps.ts`** are text builders like the backup's; the restore runs them through `sshExec` with the usual redaction.
- **Runbook** `restore.md` is the nine steps with the commands, what each prints, what to do when one stops, and the production variant (the owner completes the reset in a browser through the tunnel; the journey's reveal is then done by the owner and confirmed with `--owner-confirmed`).

### Task A — the record, the listener, the opening

- [ ] **Step 1 — Failing tests** (`v2.test.ts`, `gate.test.ts`, `listener.test.ts`):
  - `readGate`: each cause alone; a v1 record → `none` (`version`); an open record with another incarnation, another build or another host → `none`; `closed` + `verifying` with all three equal → `verification`; `closed` + `serving` → `none`;
  - `the database's incarnation differs from the expected one → every product route answers quarantined although the file says open`; `the provisioner refuses jobs when OpenBao's incarnation differs`;
  - `mayOpen`: a report 31 minutes old, of another host, with one failed check, with one unknown check, with a required check missing → refused with its cause; the right one → its hash;
  - `gate open writes operator.gate_open before the file; with audit unavailable the file is unchanged and the command exits 1`; `gate close works with PostgreSQL stopped`;
  - `listener.test.ts`: with `closed` + `verifying` — on the public listener everything but `/health` is `quarantined` and `/health` is down; on the verification listener sign-in, the lists, history and a reveal are served (the reveal's audit row exists), every route of `EXPANDING_ROUTES` and `REDUCING_ROUTES` answers `quarantined` except sign-out and session revocation, both machine routes answer `quarantined`, and **no request reached OpenBao with a write** (the device shows reads only);
  - `with open + serving the verification listener answers like the public one`; `without MYKEY_VERIFY_LISTEN there is one listener`;
  - `an import running when the gate closes ends with its remaining entries not_attempted and resumes to completion after the gate opens`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; the whole integration suite once (every harness gate file becomes v2). **Commit** `feat(gate): bound to host, incarnation, release and a verification report`.

### Task B — restore and invalidate

- [ ] **Step 1 — Failing tests** (`invalidate.test.ts`, `verify.test.ts`, `restore-steps.test.ts`; `restore-fixture.ts` builds a "lost world": an organization with two projects, credentials in every state, sessions in every phase, a used and an unused reset link, an operation left `executing`, then a pair, then the changes of P-125, then both halves restored into scratch instances):
  - `after pg_restore the control row says capturing and a write is refused; after the reset step it is idle with a new incarnation`;
  - `restoreInvalidate`: no session, no reset token, no verification row; every account `recovery_pending` with a higher epoch; every credential row `revoked`; `LIST auth/token/accessors` in every namespace holds no machine-policy accessor and no token of the old AppRole logins; the four AppRoles have new secret ids and the old ones fail to log in; the old root token and the custody root token answer 403; every non-terminal operation is `uncertain`; the counts it returns equal what the test counts itself;
  - `it is idempotent`: a second call changes nothing and returns zeros; `stopped after the database part, a second call completes the backend part`;
  - `an accessor in a namespace the catalog does not know is revoked too` (D-18: the walk is over `sys/namespaces`);
  - `restoreVerify` returns every required check; made `failed` one at a time by the test (a session inserted, one credential set `active`, one accessor created, the incarnation changed in one of the three places, an environment's name removed from OpenBao) the matching check fails and only that one;
  - `globals.sql` is compared and never executed: a `CREATE ROLE` for an unknown role in it makes the restore stop with the role's name; the role passwords of the restored cluster are new (the old `api_runtime` password is refused);
  - `a manifest whose KMS key is not usable here stops the restore before anything is written` (PO-22's refusal; the loss-test key);
  - `a bundle with one changed byte, an eligible.json signed by an unknown key, and a prefix without eligible.json are each refused with their cause`.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** the admin methods (each with its own test against the local OpenBao in `tests/integration/openbao/`), the two commands, the step builders. **Step 4 — Run:** PASS. **Commit** `feat(ops): restore invalidates every credential class and reports`.

### Task C — the whole restore, locally, with nine old credentials

- [ ] **Step 1 — Failing tests** (`full.test.ts`, `interrupted.test.ts`): the fixture's lost world is restored by the same functions `host.ts restore` calls, into a second local stack, started closed + `verifying`.
  - Presented to the restored product on the verification listener and, where the route exists, on the public one — each refused: (1) the old password; (2) the password changed after the capture; (3) a TOTP code of the old secret; (4) a recovery code that was unused at the capture; (5) the reset link that was unused at the capture; (6) the session cookie that was live at the capture; (7) the machine token that was live at the capture — refused by the API and by OpenBao's `lookup-self` directly; (8) the old `runtime` secret id — AppRole login refused; (9) the old root token. Tokens and codes are compared by what the server answers, never printed.
  - `the admin removed after the capture is back in the membership table, the report says members: 2, and gate open refuses until --confirm-members 2 or the member is removed`;
  - `the secret written after the capture is absent; every secret of the capture reveals with its digest`;
  - `the operator's reset link works, the owner enrols and signs in through the listener, and the account can do exactly what the matrix says an owner can` (the reset test "that proves something about rights": three allowed and three denied actions after opening);
  - `gate open with the fresh report opens; a write succeeds; the first issuance returns a token that resolves`; `a fresh capture on the restored stack ends eligible`;
  - `interrupted.test.ts`: the restore is killed after each of steps 2–7 in turn; each time the stack is started: the public listener answers `quarantined` and `/health` down, `gate open` is refused (no report, or a report whose incarnation is not the host's), and running the restore again from step 1 ends in a product that passes the test above;
  - `a report made, then one session inserted, then gate open` → refused: `gate open` runs the cheap checks (`sessions_none`, `machine_accessors_none`, `control_row_idle`, `incarnation_three_places`) again itself and compares.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** `host.ts restore` (the local path through the same step functions), the re-check inside `gate open`. **Step 4 — Run:** PASS (one heavy job). **Commit** `feat(host): a restore that stays closed until a report says open`.

**Registry:** FR-1.67, FR-1.68, FR-1.69, FR-1.86, FR-1.87 → `SPIKE_PASS` on the local proof; AC-1.28, AC-1.43, AC-1.44 and PO-22 wait for the drill. **Covers:** Review focus 2. **Done when:** the three tasks are green, D-54 and D-55 are written, `pnpm run check` is green.

## Run 6.9 — Deployment, rollback and supply chain (D08-S43) — before Run 6.8 (P-126)

**Files:** `infra/release/{build,release-schema}.ts`, `scripts/{host-release,host,ci-scan}.ts`, `package.json` (`host:release`), `apps/api/Dockerfile`, `apps/provisioner/Dockerfile`, `apps/ops/src/remote/{ssh,redact,hosts}.ts` (moved from `tests/harness/`; the harness re-exports), `apps/ops/src/commands/{sweep,operations-expire}.ts`, `apps/api/src/operation-sweep.ts`, `packages/operations/src/imports/apply.ts`, `infra/hosts/systemd/mykey-{operations-expire,auth-cleanup,sweep}.{service,timer}`, `infra/hosts/ops-jobs.json`, `tests/unit/release/{schema,deploy-plan}.test.ts`, `tests/unit/hosts/images.test.ts`, `tests/integration/deploy/{previous-release,failed-migration,expire-resume}.test.ts`, `tests/staging/deploy.staging.test.ts`, `docs/decisions/D-57-release-and-deploy.md`, `docs/runbooks/{deploy,service-gate,network}.md`.

**Consumes:** Run 6.7 (`verifyJourney`, `restoreVerify`'s deploy checks, `mayOpen`, the listener); Run 6.2 (three images); `scripts/ci-scan.ts`; `migrate`, `ensureQueues`.

**Produces:**

```ts
// infra/release — release-schema.ts
export interface Release { format: "mykey-host-release/1"; version: string; commit: string; builtAt: string;
  images: { name: "api" | "provisioner" | "ops"; imageId: string; archive: string; archiveSha256: string }[];
  baseDigests: Record<string, string>; migrations: { last: string }; scans: { secrets: "pass"; dependencies: "pass"; images: "pass" } }
export const releaseSchema: z.ZodType<Release>;
// infra/release — build.ts
export function buildRelease(opts: { version: string; outDir: string }): Promise<Release>;         // refuses a dirty tree, a commit not on origin, a failing scan
// scripts/host.ts
export interface DeployPlan { steps: readonly ("verify_release" | "load_images" | "gate_close" | "migrate" | "start" | "journey" | "report" | "gate_open")[] }
export function deployPlan(current: { build: string; lastMigration: string }, release: Release): DeployPlan | { refused: string };
```

Design fixed here (P-127 … P-129, P-131; Doc 06 §14; FR-1.73, FR-1.74; AC-1.32):

- **`scans` can only say `pass`**: the schema has no other value, and `buildRelease` writes the file only after the three scanners exited 0 against the image ids it lists.
- **`deployPlan` refuses**: a release whose last migration is older than the host's (a downgrade), a release whose commit is not an ancestor or descendant of the running build's, an image id given on the command line that the release does not list.
- **On the host** nothing is built: `docker load` of the verified archives, `host.env` rewritten with the three image ids, compose up. The migration runs from the workstation through the tunnel as today.
- **A deploy that stops** after `gate_close` leaves the gate closed. `host.ts <host> deploy --resume` continues from the plan; `host.ts <host> deploy --release <previous>` is the rollback and goes through the same steps, journey and report included. Two more flags: `--install-only` ends after `load_images` (a host that will be restored), `--stay-closed` ends after `start` (production, which has no OpenBao and no owner to make a journey with).
- **Rollback across the gate's format change** is the one special case: `45b5c1f3cc3a` reads a v1 record only. Returning to it means writing a v1 record with that commit's own `host.ts`; this is rehearsed locally in `previous-release.test.ts` and written into `deploy.md`, and it is not rehearsed on staging. The staging rollback of Task B goes to a release that already knows v2.
- **The API image**: the final stage copies no `npm`, `npx` or `corepack` (`images.test.ts` runs the image with `--entrypoint ls` on the three paths and expects them absent); all three images run as a non-root user with a read-only root filesystem in compose and in `ops-run.sh`.
- **Runbook** `deploy.md`: build, deploy, what the journey checks, rollback, a failed migration, production's extra step (the owner's yes).

### Task A — build once

- [ ] **Step 1 — Failing tests** (`schema.test.ts`, `images.test.ts`, the `ci-scan` unit tests): `a release with a scan that is not pass does not parse`; `buildRelease refuses a dirty tree and an unpushed commit`; `two builds of one commit list the same base digests`; the three images' checks above; `host.ts and the harness import SSH and redaction from @mykey/ops/remote` (a skeleton test: `scripts/` imports nothing from `tests/`).
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement.** **Step 4 — Run:** PASS; `pnpm run host:release -- --version 0.6.0` on a clean clone under `C:/Users/gmpar/mykey-gate/` (one heavy job); `gh release create host-v0.6.0` with the three archives, `release.json` and `SHA256SUMS`. **Commit** `feat(release): three images, scanned, built once`.

### Task B — promote, verify, open; roll back

- [ ] **Step 1 — Failing tests.**
  - `deploy-plan.test.ts`: the refusals above; the plan of a normal deploy is the eight steps in order; the plan of a redeploy of the running release has no `migrate`.
  - `previous-release.test.ts`: the image of `45b5c1f3cc3a` (built once from that commit, its id recorded) runs against a database migrated to `0018`: sign-in, a secret write, a reveal, an issuance and a revocation succeed. This is the proof of P-131.
  - `failed-migration.test.ts`: a rehearsal release whose extra migration raises after creating a table: `migrate` fails, the table does not exist, `meta.schema_migration` is unchanged, the plan stops with the gate closed, and `deploy --release <previous>` brings the product back open with a fresh report.
  - `deploy.staging.test.ts`: after the deploy of `host-v0.6.0` — the three running image ids are the release's; the gate record is v2, `open`, `serving`, with this build and a report hash; `operator.deploy` and `operator.gate_open` are in the audit table; the public name answered `quarantined` between `gate_close` and `gate_open` (a poller records it) and never a 5xx of the proxy's own for longer than the restart; a rollback to the previous release (`host-v0.5.9`, built from the last commit of Run 6.7, the first that knows gate v2 and the listener) and forward again both end open, and the journey's reveal digest is the same each time.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement** `host.ts deploy`. **Step 4 — Deploy staging** with it (window in `staging-windows.md`): this is also staging's conversion to gate v2 and its first incarnation. Run the staging file. **Commit** `feat(host): deploy promotes a release through the closed gate`.

### Task C — timers and the carried minors

- [ ] **Step 1 — Failing tests** (`expire-resume.test.ts`, the sweep's tests, `units.test.ts`): `an import parent left awaiting_input for 31 days is expired with its entries; a resume answers 409 replay_expired` (M-7); `one archive that throws does not stop the tick from driving the next` ; `ops sweep runs the PostgreSQL sweeps once and exits 0; with the capture mode not idle it does nothing`; every unit of P-129 exists, calls `ops-run.sh` with a job of the table and has `Persistent=true` where it is daily.
- [ ] **Step 2 — Run:** FAIL. **Step 3 — Implement**; install the units on staging; `systemctl list-timers 'mykey-*'` into the run note. **Step 4 — Run:** PASS; `PENDING_WRITERS` of Run 6.1 is empty and its test says so. **Commit** `feat(hosts): timers for expiry, clean-up and the sweeps`.

**Registry:** FR-1.73, FR-1.74, AC-1.32 → `SPIKE_PASS`. **Done when:** staging runs `host-v0.6.0` through the tooling with a v2 gate, a rollback was made and undone, D-57 is written, `pnpm run check` is green.

## Run 6.8 — Clean-host restore drill (D08-S42) · OWNER: OWN-5

**Files:** `apps/ops/src/remote/hosts.ts`, `scripts/host.ts` (`HostName`), `workers/probe/wrangler.jsonc` (the `drill` entry), `tests/staging/drill.staging.test.ts`, `tests/harness/drill.ts`, `docs/evidence/session-6/{drill.json,staging-windows.md,owner-requests.md}`, `docs/decisions/D-56-drill-host.md`, `docs/runbooks/{restore,network,kms-and-unseal,custody-map}.md`.

**Consumes:** everything: Run 6.5 (pairs on staging), Run 6.7 (`host.ts restore`, the report), Run 6.9 (`host.ts deploy`, the release), Run 6.4 (alerts), Session 2 (`host.ts bootstrap`, `apply`, `kms-csr`, `kms-cert`).

**Produces:** `docs/evidence/session-6/drill.json` — `{ pairId, pairCapturedAt, lostAt, steps: [{ name, startedAt, seconds }], gateOpenedAt, recoverySeconds, report: { sha256, checks }, negative: [{ name, refused: true, cause }], freshPairId }` — and the sentences of the session report.

Design fixed here (P-125; Doc 06 §14; FR-1.67–1.69, FR-1.86, FR-1.87; AC-1.28, 1.43, 1.44; PO-22; KMS-L1; DB-G1):

- **The drill is one test file run step by step**, not a script beside the tests: each step is a test that asserts its own result and writes its timing; a failed step stops the file (`bail`), and the run note says where and why. The host commands are the runbook's, so `restore.md` is corrected in the same commit whenever a step needed something the runbook did not say.
- **"From R2 and the custody set alone"** is enforced, not assumed: from the moment staging is declared lost until the gate of the drill host is open, the test's SSH helper refuses every connection to staging (a guard in `tests/harness/drill.ts`), and nothing is copied from the workstation except the release, `hosts.json`, and the custody set named in `backup.md`.
- **Staging's own state is not changed by the drill** beyond the fence: its data, credentials and gate epoch are as before when it is started again. The drill host's rotations happen in the drill host's OpenBao.
- **The drill host's probe entry** is `inService: true` from the moment its gate opens, so the off-host view of the restored service is part of the proof; it is removed at the gate.

### Task A — the host

- [ ] **Step 1 —** With the owner's server: add `drill` to `~/.mykey/hosts.json`; DNS record `drill.<zone>` (Cloudflare API); `host.ts drill bootstrap`, `push`, `apply` + `confirm`, the VPN peer; `host.ts drill kms-csr` → the CSR to the owner → `kms-cert`, `kms-use`; the egress sets. Unit test: `HostName` accepts a name of the file and `prod`'s permission rule still applies only to `prod`. **Step 2 —** `host.ts drill status`: firewall loaded, KMS reachable, no containers. **Commit** `feat(host): a third host by name; the drill host is up`.

### Task B — the stale pair and the loss

- [ ] **Step 1 — On staging** (window announced): the drill's own organization content — a project with two environments, 50 secrets with run-time canaries (digests kept in memory), two machine tokens, an admin member. `systemctl start mykey-backup` → pair P, eligible. Then the changes after P: the owner's password changed, TOTP and recovery codes replaced, a reset link issued and used, one session signed out and one left live, one machine token revoked, the admin removed, one secret written, one credential issued. A second capture is **not** taken.
- [ ] **Step 2 — Declare lost** (`lostAt`): `host.ts staging gate close`, `quiesce`, the probe entry `inService: false`; from here the guard refuses staging.

### Task C — the restore on the clean host, timed

- [ ] **Steps 1–9** are the nine of `restore.md`, each timed: (1) `host.ts drill deploy --release host-v0.6.0 --install-only` (images loaded, nothing started); (2) `host.ts drill restore --source staging --newest` picks P by listing, verifies signature and digests, restores the artifacts; (3) PostgreSQL with new role passwords, globals compared, `pg_restore`, schema revision; (4) OpenBao on the same seal, snapshot restored, readable; (5) `restore-invalidate`; (6) the control row, the incarnation in three places, a new host instance id; (7) start closed + `verifying`; `verify-organization`, `reconcile-credentials` for every environment, the operator's reset for the owner, the journey through the tunnel; (8) the report, `--confirm-members`; (9) `gate open`.
- [ ] **Assertions after step 9**, through the drill host's public name: the nine old credentials of Run 6.7 Task C, here with the real staging ones, are refused — the machine token revoked after P and the one live at P both; the 50 secrets reveal with their digests; the secret written after P is absent; the admin is present only if confirmed (the drill removes them and says so in the report); a new token is issued and `secrets run` with the released CLI starts the fixture application with the complete set; `systemctl start mykey-backup` on the drill host ends eligible under `pairs/drill/`; the probe shows the drill host healthy with no open condition; the audit table holds `operator.restore_begin`, `restore_invalidate`, `restore_verify`, `gate_open` in that order, and the owner reads the tenant rows of P's time through the audit route.

### Task D — what must stay closed

- [ ] **Negative steps**, each on the drill host from a snapshot of "after step 4" (re-run steps 2–4 from R2; the timings of Task C are not affected): `gate open` without a report → refused; with a report older than 30 minutes → refused; with the report of another incarnation → refused; the API started on restored data with a v2 gate file copied from before the restore → `quarantined` (`incarnation`); the restore stopped after step 5 and the host rebooted → closed, and the capture-recover unit did not open anything; a pair prefix whose `eligible.json` was replaced by one signed with a throw-away key (written under `probe/`, never under `pairs/`) → refused before download of the bundle; `--pair` naming an `ineligible` pair of Run 6.5 Task D → refused ("not eligible": it has no `eligible.json`).
- [ ] **Finish:** write `drill.json`; un-fence staging (`resume`, `gate open` with a fresh deploy-kind report, `inService: true`); `host.ts staging status` and the probe clean; the staging journey of Session 5 (`machine.staging.test.ts`) passes on staging with its **own** old credentials (proof that the drill changed nothing there). **Commit** `test(staging): staging rebuilt on a clean host from R2; timings and refusals`.

**Registry:** AC-1.28, AC-1.43, AC-1.44, PO-22 → `SPIKE_PASS`; KMS-L1, DB-G1 keep `SPIKE_PASS` with the drill as evidence. **Covers:** Review focus 2, on real hosts. **Done when:** `drill.json` is complete with a recovery time, every negative step was refused, staging serves again, D-56 is written, `pnpm run check` is green. The drill host stays until the gate.

## Run 6.10 — Runbooks and honest limits (D08-S43)

**Files:** `docs/runbooks/{alerts,known-limits,audit,limits,operator-status,backup,restore,deploy,probe,service-gate,custody-map,credential-custody,db-globals-inventory,network,kms-and-unseal}.md`, `tests/unit/runbooks/{alerts,links,commands}.test.ts`, `scripts/runbook-coverage.ts`, `docs/evidence/session-6/alerts.md`.

**Consumes:** every run of this session; the probe's `CONDITIONS`; `AUDIT_COVERAGE`; `LIMITS`; `ops-jobs.json`.

**Produces:** `alerts.md` (one section per condition), `known-limits.md`, and three tests that keep them true.

Design fixed here (P-130; FR-1.75; AC-1.33):

- **`alerts.md`**: for each condition the four headings. `Check` names the exact command (`host.ts <host> status`, a unit's journal, a query) and what its output means; `Fix` the first action and when to stop and close the gate instead; `Confirm` the `resolved` message and the status line that must be `ok`.
- **`known-limits.md`** — what the service does **not** do, each with where it was measured or decided. At least: a response made by the proxy carries no request id; unattributable refusals are log lines, not audit rows; a source that sends 30 unknown machine tokens a minute also blocks valid tokens from that source for the rest of the minute; the per-credential read lock and the measured effect on writes; the certificate threshold for short-lived certificates (D-50); the watcher may be late and stops after 60 days without repository activity; a pair larger than 1 GiB of artifacts or 5 GiB of bundle fails the capture; a capture refuses writes for the measured seconds each night; an access-reducing action during a capture costs that night's pair; the audit archive of staging is locked 30 days, production's 365; restore needs the custody set and the same KMS key, and without the key there is no restore (Run 2.7); a restore returns every account to `recovery_pending` and revokes every machine token, so every consumer needs a new token; rollback is a redeploy on the same schema or a restore, never a downgrade; import of 1 MiB against 8 MiB environments and the `@next/env` case (CLAUDE.md); Better Auth writes `expires_at` on the API's clock; an issuance left `needs_review` has no stored accessor; one operator, one workstation.
- **The tests**: `alerts.test.ts` — the section list equals `CONDITIONS`, every section has the four headings and at least one fenced command, and `docs/evidence/session-6/alerts.md` has a line with a date and an alert-log id for every condition; `links.test.ts` — every relative link and every `docs/…` path named in a runbook exists; `commands.test.ts` — every `host.ts`, `probe.ts` and `ops` command named in a fenced block of a runbook exists in the tool's usage text or in `apps/ops/src/commands/`.

### Task A — write and check

- [ ] **Step 1 — Failing tests** (the three). **Step 2 — Run:** FAIL. **Step 3 — Write** the two new runbooks; bring the others up to date with what the runs changed (each run already touched its own). **Step 4 — Run:** PASS. **Step 5 — One reading** of `restore.md` and `deploy.md` against `drill.json` and the deploy's run note: every command the runs really used is in the runbook, in that order. **Commit** `docs(runbooks): one runbook per alert; the known limits`.

**Registry:** FR-1.75, AC-1.33 → `SPIKE_PASS`. **Done when:** the tests are green and `pnpm run check` is green.

## Run 6.11 — Session gate

- [ ] **Step 1 — Clean clone, full suite.** Clone the branch to `C:/Users/gmpar/mykey-gate/session-6`; `pnpm install --frozen-lockfile`; `pnpm run check`; `pnpm test`; `pnpm run test:integration -- --maxWorkers=2`; `pnpm run test:cloud`; `pnpm run test:cli`; `pnpm run test:browser`. One at a time, the heavy lock held, no agent beside them. A failure is fixed on the branch and the failed command is run again from the clean clone.
- [ ] **Step 2 — Dated items.** `test:cloud` is green with no dated guard. Read again: KMS certificates (12 Dec 2026) and `.trivyignore.images` (14 Dec 2026) — both now also visible as `certificate_expiring` on its day and in CLAUDE.md. New checkpoints: `backup-first-night` (observed or due), `pair-30-day` (from 18 Dec 2026). The drill host's KMS certificate is revoked with the host.
- [ ] **Step 3 — Staging.** Build `host-v0.6.1` from the branch head when anything changed after Run 6.9; `host.ts staging deploy --release …`; `status` and the probe clean; the timers listed.
- [ ] **Step 4 — Staging suite, one file at a time**, in the order of `tests/staging/` with the session's new files last; the two `unseal` tests three times each. Restore the evidence files the suite rewrites. Then `pnpm run test:consumers`.
- [ ] **Step 5 — Staging's root token** (M1): `generate-root` with the recovery keys, revoke the token in `/root/mykey-custody` and its copy in workstation custody, revoke the new one; `ops` over the tunnel moves to a short-lived token obtained the same way per use, and `credential-custody.md` says so. If `ops` cannot work without a resting root token, this step stops, the reason goes into the report, and the item is carried to Session 8 as a Blocker candidate.
- [ ] **Step 6 — The drill host is deleted**: its probe entry and DNS record removed, its KMS certificate revoked, its `hosts.json` entry removed; the owner is asked to delete the server and confirms. Its pairs under `pairs/drill/` stay until their lock ends; the retention of a later session removes them (a line in `backup.md`).
- [ ] **Step 7 — Production, only with the owner's yes** (asked in `owner-requests.md`): `host.ts prod deploy --release … --stay-closed` with migrations up to `0018`; production keeps no gate file, the plan ends after `start` and every route stays `quarantined`; `status.sh` and `heartbeat.sh` version 2 are already there. Without a yes: not done, said in the report.
- [ ] **Step 8 — One fresh-context review** of `git diff main...session-6`, with these nine questions and nothing of this plan's reasoning: (1) Can any write reach an authority table while a capture is `capturing`, and can a pair become `eligible` without a download and check? (2) After a restore, name every kind of credential and where it is invalidated; is one missing? (3) Can the gate open without a report, with a stale one, or on a host or incarnation the report was not made for? (4) Does any limit, the capacity check or the audit probe answer "allow" when it cannot decide? (5) Can a row of another organization, a global row or an unvalidated detail leave through the audit or activity route? (6) Can an audit row be deleted before its segment was verified off-host? (7) Is a backup password, signing key, R2 secret, role password or token in a log, a unit, a manifest, a report, a heartbeat, an alert or a committed file? (8) Which alert can fail to open, or fail to resolve? (9) Is anything of this diff not expand-only for the previous release?
- [ ] **Step 9 — Findings.** Blocker and Important are fixed and proven before the report; Minor is fixed or listed with the run that takes it. A finding that needs the stores is proven on the stores.
- [ ] **Step 10 — Registry and report.** `registry-overrides.json`, `pnpm run evidence:build`; `docs/evidence/session-6/report.md`: the verdict; the drill's timings (per step and the recovery time) and its refusals; the freeze's measured length; pair and segment sizes and the monthly cost; every alert with its evidence line; findings; deviations; and **"What Sessions 7, 8 and 9 must know"** (the audit and activity contracts and their filters; the new error answers a workspace must show — 429 with `retry-after`, 507 `disk`, `busy` during a capture; the verification listener; that a restore resets every account and token; the timers; what is in `known-limits.md`; the checkpoints). Update CLAUDE.md: "Where we stand", the commands (`host:release`, `host.ts deploy|restore|status`, `ops-run.sh`), the corrected count of pending routes, "Things already learned" for Session 6, the dated items.
- [ ] **Step 11 — Pull request** `session-6` → `main`; watch CI (`gh run list --branch session-6 --limit 3`) until green; merge only when the owner says so. If Session 7 merged first, merge `main` into the branch, run Step 1's `check` and unit tests again, and renumber nothing: the migrations of this session keep `0015`–`0018`.

## Session 6 end state

- `main` (after the owner's merge) holds: the audit view and activity timeline with a coverage table that fails the build when a route has no decision; segments of both audit streams verified in R2 with a purge that cannot outrun them; every limit of Doc 06 §11 enforced in the pipeline and failing closed; a private status view and fifteen alert conditions, each delivered once for real and each with a runbook; a daily pair that is eligible only after it was read back, checked and signed; retention that never deletes the last pair; a gate bound to host, incarnation, release and report; a restore that invalidates by class; releases built once and promoted through the closed gate.
- Staging runs the session's release with a v2 gate, takes a pair every night at 03:00 UTC, archives its audit, and was rebuilt once on a clean server from R2 and the custody set, with the recovery time written down. Production runs the same release, closed, when the owner agreed.
- Registry: the session's items at `SPIKE_PASS` (FR-1.56–1.63, 1.66–1.69, 1.73–1.75, 1.78, 1.80, 1.81, 1.86, 1.87, 1.95; AC-1.18, 1.23–1.25, 1.27, 1.28, 1.32, 1.33, 1.36, 1.43, 1.44, 1.49; PO-9, PO-22, PO-23; R2-L1; COST-B1), nothing `PASS`; whatever did not reach it is `OPEN` or `FAIL` with its reason in the report.
- Decisions D-46 … D-57; migrations `0015`–`0018`; the drill host deleted; no alert open; no dated guard in the cloud suite.
