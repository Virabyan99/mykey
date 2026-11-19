# D-46 — Audit coverage is a table; the trail is served by scope

**Date:** 2026-11-16

**Status:** DECIDED in Run 6.1 (P-105 – P-110). Evidence:

- `docs/evidence/session-6/run-6.1.md`;
- `docs/evidence/session-6/audit-explain.txt`;
- `tests/unit/audit/{coverage,scope}.test.ts`;
- `tests/integration/audit/{journey,view,activity,diagnostics,explain}.test.ts`;
- `tests/fault/audit/device.test.ts`.

## Decision

**Coverage is a table, checked both ways.** `AUDIT_COVERAGE` (`packages/audit/src/coverage.ts`) has one entry for every route id, every path the auth module serves, every operator command (and the host jobs that later runs add) and every timer of the API and the provisioner. An entry is either the actions it writes or `none` with a reason of at least 20 characters. A unit test fails for a place without an entry and for an action that no entry names. The runbook's list (`docs/runbooks/audit.md`) is rendered from the table by `pnpm run audit:coverage`, and a unit test fails when they differ.

- Reads of metadata write nothing: lists, history, operation status, the reference, the session's activity. A row per list request would bury the trail, and FR-1.56 does not ask for them.
- Requests refused before a principal is known (401, malformed requests, origin, quarantine, rate limits) are log lines. Only `auth.throttled` and `access.denied` are rows, so an unattributable caller cannot fill the table.
- Four writers were missing and are added: `auth.sign_out`, `auth.session_revoke { revokedSessions }`, `import.resume` (the resume route no longer writes a second `import.apply`), `operator.auth_cleanup { steps, recoveryRows }`. Each is written in the transaction of the change it records: sign-out deletes the session and appends its row together, so a failed row leaves the session alive and answers `503 audit_unavailable`.
- The actions of the rest of Session 6 (archive, purge, backup, gate, restore, deploy) are declared now with their details and scope. Their writers arrive in Runs 6.2 – 6.9; the journey test lists them in `PENDING_WRITERS`, which Run 6.9 leaves empty.

**Every action has a scope**, enforced by `appendAudit`:

- `tenant` rows are written with their organization and served to its owners and admins.
- `account` rows (the `auth.*` actions and `operator.reset_initiate`) are written without one. They are served to the owners and admins of every organization the row's subject user belongs to now. The subject is the actor when it is a user, else the target when it is a user. It is the generated column `audit.event.subject_user_id` (migration `0015`), with a partial index for rows without an organization.
- `global` rows (the infrastructure, `auth.throttled`, `operator.operations_expire`, `operator.auth_cleanup`) are served to nobody through the API. The operator reads them with `psql` as `maintenance`.
- `access.denied` is `tenant`, with one exception: a denial behind the hidden 404 of a foreign organization names no organization and is the caller's account row.
- `operator.bootstrap` is `tenant`, not global: its row names the organization it creates and that organization's owner.

**The routes.** `GET …/audit` serves the tenant rows and the account rows of current members in one statement (`UNION ALL`, each branch on its own index, ordered and limited once outside). `GET …/activity` serves the product's actions only, with each operation's current state and the current name of its target, and never groups. Both are keyset pages under an anchor fixed by the first page in database time. The cursor is signed and bound to its filters: another filter is `409 listing_changed`, a cursor that does not verify is `400 malformed_request`. The window is at most 92 days (default 30), and the statement has a 5 s timeout (`503 busy`). A stored row whose details fail its schema is served with `{}` and logged `output_invalid` with its id.

**Diagnostics.** The request id is the API's own; an incoming `x-request-id` is never read. Every string field of a log entry must fit its field's format, else it is written `[invalid]`. No image or compose file carries an inspector, report or profiler flag, and every host service runs with `ulimits: core: 0`.

## Alternatives rejected

- **Global rows for owners.** An owner of one organization would see the gate, backups and other tenants' throttling. The infrastructure belongs to the operator.
- **Account rows by membership at the time of the event.** It needs a join at write time and a second fact to keep. Current membership is what the owner can act on; a removed member's rows leave the view with them.
- **Grouping by operation in SQL.** It breaks the keyset; the workspace groups by `operation.id` instead.
- **A row for every refusal.** An unauthenticated caller could fill the table (P-93).

## Consequences

- A new route, auth path, command or timer fails the unit test until its entry is written.
- An OpenBao request that fails with a 5xx is never read as a dead token: machine authentication answers `503`, not `401`, when the audit device cannot write. Only a 4xx from `lookup-self` is a dead token.
- The runbook's coverage list cannot drift from the code.
