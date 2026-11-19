# Run 6.1 — Audit coverage and the audit and activity routes

**Result: DONE on 16 Nov 2026.** Tag `session-6-run-6.1`. Decision: D-46.

## What was done

- **Coverage table (Task A).** `AUDIT_COVERAGE` names every route, auth path, operator command and timer, with the actions it writes or why it writes none. Unit tests check it both ways, and the runbook's list is rendered from it.
- **Scopes (Task A).** `AUDIT_SCOPE` gives every action `tenant`, `account` or `global`, and `appendAudit` refuses an event whose organization does not fit.
- **Writers added (Task A):**
  - `auth.sign_out`: the session is deleted with its row in one transaction;
  - `auth.session_revoke`: `/sessions/revoke`, and `/revoke-sessions`, which is now product-owned;
  - `import.resume`: the resume writes it instead of a second `import.apply` intent;
  - `operator.auth_cleanup`.
- **Actions declared ahead (Task A).** The actions of Runs 6.2 – 6.9 are declared with details and scope; their writers come later.
- **The two routes (Task B).** `GET /v1/organizations/:org/audit` and `/activity`:
  - contract commit `d3417d4`;
  - migration `0015` (`subject_user_id`, a generated column, and its partial index);
  - `listAuditEvents` (one statement, `UNION ALL`, 5 s timeout), keyset pages under an anchor, signed cursors bound to the filters;
  - the activity items carry the operation's current state and the target's current name.
- **Nothing leaks, and audit that cannot write stops the work (Task C):**
  - the journey through every writer;
  - the canary sweep;
  - the runtime roles cannot change audit;
  - OpenBao's audit device full;
  - the log field formats;
  - no diagnostic flags, core dumps off.
- **Runbook** `docs/runbooks/audit.md`; `pnpm run audit:coverage` renders its coverage list.

## Commits

- `5b01c77` feat(audit): a coverage table, scopes and the missing writers
- `d3417d4` contract: audit and activity
- `d463521` feat(api): the audit view and the activity timeline
- `690189e` test(audit): the EXPLAIN evidence file is written on request only
- `a9deec5` test(audit): coverage journey, canary sweep, a full audit device
- this note, D-46 and the registry lines

## Commands and results

- `pnpm run check` → green (with `audit-coverage` current).
- `pnpm exec vitest run --project unit` → 78 files, 981 tests passed (before the runbook test; `tests/unit/audit` 30/30 after it).
- Integration, run in groups with `--maxWorkers=2`:
  - `tests/integration/{machine,auth,ops,audit,imports,api}`: 45 files, 340 tests. The first run had 5 failures, all expectations this run changed (below). The 9 files involved, rerun: 69/69.
  - `tests/integration/audit/journey.test.ts` 6/6, `view` 8/8, `activity` 3/3, `explain` 1/1, `diagnostics` 3/3.
  - `tests/integration/database/*`, `routes-mounted`: green.
- `pnpm exec vitest run --project integration tests/fault/audit/device.test.ts` → 3/3.
- **The five expectations this run changed:**
  - `append.test.ts`: the row has the generated column `subject_user_id`.
  - `factors-http.test.ts`: `audit.list` and `activity.list` have handlers.
  - `storage.test.ts`: Better Auth no longer deletes a session by token, because the product's sign-out deleted it first.
  - `pipeline.test.ts`: the echo route's audit row is now a global action (`operator.bootstrap` is tenant and needs an organization).
  - `journey.test.ts`: the reset code is taken at a test-clock step of its own.
- **EXPLAIN** of the served query, from `MYKEY_WRITE_EVIDENCE=1 pnpm exec vitest run --project integration tests/integration/audit/explain.test.ts`, in `docs/evidence/session-6/audit-explain.txt`:
  - the tenant branch is an `Index Scan Backward using event_organization_occurred_idx`;
  - the account branch is a nested loop over the organization's active memberships with an `Index Scan using event_subject_occurred_idx`;
  - a `Merge Append` joins them under one `Limit`;
  - no sequential scan of `audit.event`.

### Registry

FR-1.56 SPIKE_PASS — the coverage table names every route, auth path, operator command and timer, and a unit test fails for a gap either way. One journey through every writer leaves a row for every action whose writer exists (`PENDING_WRITERS` lists the twelve declared for Runs 6.2 – 6.9). Every api row carries the request id its response carried (`tests/unit/audit/coverage.test.ts`, `tests/integration/audit/journey.test.ts`).
FR-1.58 SPIKE_PASS — owners and admins read their organization's trail and the account rows of their current members. Other people's rows, global rows and anonymous rows are never served. Filters match direct SQL; pages are stable under concurrent writes; a cursor is bound to its filters; a row with invalid details is served empty and logged (`tests/integration/audit/view.test.ts`, `activity.test.ts`, `explain.test.ts`).
FR-1.59 SPIKE_PASS — the request id is the API's own and is carried by every audit row of a request. An incoming `x-request-id` is neither echoed nor logged; the activity items carry the operation's current state (`tests/integration/audit/diagnostics.test.ts`, `journey.test.ts`, `activity.test.ts`).
FR-1.80 SPIKE_PASS — canaries were used as secret values, passwords, codes, a reset link, machine tokens and a foreign request id. None of them reached the API log, the PostgreSQL or OpenBao log, an audit row or an error body, and the controls were found. Every log field is checked against its format. The images and compose files carry no diagnostic flag, and core dumps are off (`tests/integration/audit/diagnostics.test.ts`, `tests/unit/api/log-entries.test.ts`, `tests/unit/hosts/diagnostics-flags.test.ts`).

FR-1.57, FR-1.81 and AC-1.23 wait for Runs 6.2 and 6.4.

## Deviations and decisions

- **`operator.bootstrap` is `tenant`**, not global as P-106 lists. Its row names the organization it creates and that organization's owner.
- **`access.denied` is `tenant` with an account fallback.** A denial behind the hidden 404 of a foreign organization names none and is served to the caller's own organizations.
- **`operator.auth_cleanup` details are `{ steps, recoveryRows }`**, not `{ sessions, tokens }`. The command removes TOTP steps and recovery rows, and the plan's own key rule forbids `token`.
- **`/revoke-sessions` is product-owned now** (it still answers `{ status: true }`). The native sign-out swallowed a failed delete and still answered success; the product's sign-out deletes and audits first and calls the native one only to clear the cookie.
- **Two statuses differ from the plan:**
  - A cursor that does not verify answers `400 malformed_request`, not 422: every list since Run 3.9 does.
  - An unknown query key also answers 400: it is the pipeline's rule for every route.
- **The audit tmpfs is 64 MiB, not 1 MiB.** Fixture setup writes more than 1 MiB of OpenBao audit before the test starts; the test fills whatever is left with `dd`.
- **A real bug found by the device test:** machine authentication read any failed `lookup-self` as a dead token. With the audit device full that answered `401`, and a client would drop a good token. Now only a 4xx means a dead token; a 5xx is `503`.
- **Owner bootstrap in the journey runs on a fresh database of its own.** The command refuses where accounts exist; that database's rows count toward the coverage check. Its organization is provisioned there, which writes `operator.organization_provision`.
- **The canary sweep sends canary-shaped TOTP codes.** A real code is six digits and would match timestamps. OpenBao's log cannot be written into from outside its process, so its control is that the window read holds the fixture's namespace (the log was read, and covers the journey).
- **The runbook's freshness check is a unit test**, not a step of `check`, so it runs with the other coverage tests.

## Open issues

- `PENDING_WRITERS` holds 12 actions; Runs 6.2, 6.5, 6.6, 6.7 and 6.9 write them, and Run 6.9 must leave the list empty.
- Dated items, unchanged:
  - all KMS certificates expire on **12 Dec 2026** (checkpoint `kms-cert-expiry` from 12 Dec 09:57 UTC);
  - `.trivyignore.images` expires on **14 Dec 2026**;
  - the R2 fixture guard keeps `test:cloud` red (4 guard tests) until Run 6.6.
- The full integration suite was not run in this run (only the groups above); the gate runs it.
