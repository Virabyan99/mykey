# D-61 — The three summary bodies count only what their caller may list

**Date:** 2026-11-19

**Status:** DECIDED in Runs 7.3, 7.7 and 7.8 (P-139; Doc 06 §18.3; Doc 04 §11.2; FR-1.90, FR-1.91, FR-1.94). Evidence:

- `docs/evidence/session-7/run-7.3.md`, `run-7.7.md` and `run-7.8.md`;
- `tests/integration/overview/overview.test.ts`, `tests/integration/credentials/summary.test.ts`, `tests/integration/metrics/metrics.test.ts`;
- `tests/unit/contracts/pending-routes.snapshot.json`, which is empty.

## Context

The route list was frozen in Session 3 (D-15) with three routes whose bodies were pending: `overview.get`, `credentials.summary` and `metrics.get`. They are the workspace's numbers. A number is the easiest place to leak: an aggregate can count rows its caller could never list, and a zero can stand for "nobody looked". Doc 04 §11.2 says unknown is not zero.

## Decision

### One rule for all three

- Each route keeps its action: an owner or an admin of the organization. A member gets `403 action_denied`, and another organization the hidden 404. Authorization comes before aggregation, so every number counts rows the caller may list through another route.
- Each reads inside one read-only transaction on one snapshot and reports the database's time as `observedAt`.
- Each runs with the 5 s statement timeout of `audit.list`. A read that takes longer answers `503 busy`.
- No answer holds a secret value, a secret name, a token or an accessor.

### `overview.get` (Run 7.3)

`{ observedAt, source: "index", projects: [{ id, name, state, reviewReason, environments: [{ id, name, state, reviewReason, kvReady, changedAt | null, keys: { live, deleted, needsReview } | null }] }], truncated }`

- At most 100 projects, by id; `truncated` says when there are more.
- Counts come from `app.secret_index`, never from OpenBao.
- `keys` is `null` for an environment that is `pending` or `needs_review`. The workspace shows "not available".

### `credentials.summary` (Run 7.7)

`{ observedAt, byState: { issuing, active, revoking, revoked, expired, needs_review }, expiring: [{ credentialId, name, projectId, environmentId, expiresAt }], expiringTruncated }`

- States are derived as `credentials.list` derives them: an `active` row past its expiry counts as `expired`.
- A row `revoked` with no accessor is left out, because `credentials.list` never lists it.
- `expiring` holds the `active` credentials within 7 days of their expiry, soonest first, at most 50.

### `metrics.get` (Run 7.8)

Query `{ days: 1..30, default 7 }`. Answer:

`{ observedAt, source: "audit.event", window: { from, to }, measuredFrom | null, days: [{ day, counts: { success, failure, unknown, denied } | null }], operations: { unresolved, uncertain } }`

- **The window** is whole UTC days. Its last day is today, counted up to `observedAt`; `window.to` is `observedAt`.
- **`success`, `failure` and `unknown`** count the rows `activity.list` serves (the product's actions, on the organization's rows and on its active members' account rows) by their outcome. An `intent` row is no outcome and is not counted.
- **`denied`** counts the rows of the action `access.denied` that `audit.list` serves to the same caller. `activity.list` does not serve that action, so the plan's sentence "only the rows `activity.list` would serve" cannot hold for this one column. The caller may still list every counted row.
- **`measuredFrom`** is the time of the organization's oldest audit row. A day before its UTC day has `counts: null`. Without any row, every day is `null`. A later day without events has four zeros.
- **`operations`** counts top-level operations (an import's children are not counted, as `operations.list` does not list them). `unresolved` is `accepted`, `executing`, `awaiting_input`, and `uncertain` with no end time. `uncertain` is every operation in that state, settled or not.
- `days` outside 1 to 30 answers `422 validation_failed`. A value that is no integer answers the pipeline's `400 malformed_request`.

## Consequences

- The pending snapshot is empty: every route of the list has a body.
- "Not measured" has a definition a test can check: a `null`, never a number.
- The purge removes audit rows older than its horizon. After a purge `measuredFrom` moves forward, and days the product once counted read "not measured". That is true of the log the summary is read from.
- The archive in R2 is not read. A summary over a longer time than the database keeps needs another source and another decision.
- The three reads are part of every overview load of an owner or an admin. The overview's test bounds that load at 6 requests.
