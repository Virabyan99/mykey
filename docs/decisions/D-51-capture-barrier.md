# D-51 — The capture barrier

**Date:** 2026-11-17

**Status:** DECIDED in Run 6.5 (P-118, P-120; Doc 06 §13; FR-1.66). Evidence:

- `docs/evidence/session-6/run-6.5.md`;
- `tests/integration/capture/{barrier,coordinator}.test.ts`;
- `tests/fault/capture/{compete,crash}.test.ts`.

## Decision

A pair is consistent only when nothing writes between the database dump and the OpenBao snapshot. The spike of Run 2.9 closed writing with a check in the six operation paths it knew. The product closes it in two ways, so that a path nobody listed is closed too.

### The mode

`app.service_control.capture_mode` is `idle`, `draining` or `capturing`.

- **Who changes it:** only `maintenance` (or a superuser) changes the row. A statement trigger (`service_control_guard`) checks `session_user` and refuses everyone else with `42501`.
- **The API's right on it:** the API keeps `UPDATE (updated_at)` only because `SELECT … FOR SHARE` needs an update right on some column. The guard refuses the update itself.
- **The provisioner:** it reads the row.

### Closure 1 — admission

While the mode is not `idle`, these answer or do nothing:

| Who                                                                                                                   | What it does                                 |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Every request that is not a GET, except those below (`captureStep`, after the gate and the limits, before validation) | `503 busy`                                   |
| The auth module's paths that write: sign-in, its factors, password change, enrolment                                  | `503 busy`                                   |
| The provisioner, before it takes a job                                                                                | defers the job by 30 s, as for a closed gate |
| The provisioner's sweep                                                                                               | skipped                                      |
| The API's operation sweep, outbox dispatcher and session clean-up                                                     | skip the tick                                |

These continue (`CAPTURE_OPEN_ROUTES`):

- **They only read and audit:** `secrets.reveal`, `export.create`, `machine.resolve`, every GET.
- **They reduce access:** `projects.archive`, `environments.archive`, `credentials.revoke`, sign-out, session revocation, and revocation of every session.

The six inline checks of the operation paths are gone: admission and the trigger replace them.

### Closure 2 — the trigger

A statement-level `BEFORE INSERT OR UPDATE OR DELETE` trigger, `capture_barrier`, is on every table of `app` and `auth` except `rate_limit`, `service_control`, `backup_pair` and `backup_invalidation`.

- **What it does:** it takes the control row `FOR SHARE`. While the mode is `capturing` it raises SQLSTATE **`MKC01`**, unless the transaction recorded an invalidation (below).
- **Staying complete:** a test compares the trigger list with `pg_tables`, so a table added later without the trigger fails the build.
- **What MKC01 becomes:**
  - in the pipeline, `busy`;
  - an admission refused by it is `busy`, never `unknown` (nothing committed);
  - the provisioner defers the job.
- **The best-effort writes on read paths** swallow it: deleting an expired session (the session is still denied) and `last_used_at`.
- **Never closed:** `audit.event` and the counters.

### Access reductions

`app.capture_invalidate(reason)` is `SECURITY DEFINER`, with `EXECUTE` for `api_runtime` only. Each writing transaction of a reduction calls it first:

- **Idle:** it does nothing.
- **Otherwise:** it inserts one row into `app.backup_invalidation` for the transaction (`txid`). The trigger lets a transaction with such a row through.
- **The pass cannot be forged:** only the function can write that table.
- **No reduction slips between capture and pair:** the function takes the row `FOR SHARE`, so a change of mode waits for the transaction. A reduction is either before the capture, and in the dump, or recorded in it.

A pair whose capture window holds an invalidation becomes `ineligible` with reason `access_reduction` (Task B).

### Lock order

The coordinator changes the mode in a transaction of its own. Writers only ever take `FOR SHARE` on the row, so the change waits for every writing transaction in flight, and new writers queue behind it for that moment. No writer ever raises its share lock to an update lock, which is the deadlock of Session 3.

## Alternatives rejected

- **Keeping the inline checks.** The inventory of Run 2.9 missed the auth module, the resources and the provisioner. A check per path rots with every new path.
- **A row-level trigger.** It never fires for a statement that changes nothing, but it costs a lock per row (an import writes hundreds of rows).
- **A transaction-local setting as the pass.** Every role can set a custom setting, so the pass would be forgeable. A row only the definer function writes is not.
- **Refusing the reductions during a capture.** A person must be able to sign out and revoke at any time (Doc 04). The pair loses its eligibility instead.
