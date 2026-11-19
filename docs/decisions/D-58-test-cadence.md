# D-58 — Heavy proof runs once, at the session gate

**Date:** 2026-11-19

**Status:** DECIDED at the start of Session 7 (P-132, P-133; the owner's rule of 19 Nov 2026). Evidence:

- `docs/plans/session-7-plan.md`, "How this session is tested";
- `.github/workflows/ci.yml` (commit `0f6f0b8`);
- `docs/evidence/session-7/run-7.1.md` (the first draft run of CI).

## Context

Session 6 took three days instead of two. Its report says where the time went: every run repeated suites, deploys and CI runs, and the gate still found what crossed runs (13 failures on its first full run). Every push to a pull request started about 13 minutes of integration tests.

The owner's rule: when CI takes a few minutes it may run on every run; the suite and the gate checks run at the end of the session only.

## Decision

### Inside a run

A run proves itself on the workstation with:

- `pnpm run check`;
- the unit files it adds or changes;
- its one browser file;
- for a run that fills a pending route, the one integration file of that route.

Nothing else runs inside a run: no full suite, no staging file, no deploy, no review.

### CI in two weights

| Pull request | What runs                                                                   | Time             |
| ------------ | --------------------------------------------------------------------------- | ---------------- |
| draft        | `check` (with every unit test) and the secret scan                          | about 2 minutes  |
| ready        | also both integration shards, the scans and the browser project (a new job) | about 20 minutes |

`ci.yml` reads `github.event.pull_request.draft`; the event type `ready_for_review` starts the heavy jobs. A run started by hand (`workflow_dispatch`) runs everything.

The session's pull request stays a draft until the gate. A push is not waited for: its result is read before the next run's first commit, and a red run is fixed before new work.

### At the gate

Once: the pull request is marked ready; one release, one deploy to staging, the staging files one at a time, `test:consumers`, one fresh-context review.

`pnpm run test:cloud` and `pnpm run test:cli` run at a gate only when the session changed `packages/backup`, `apps/ops`, `apps/cli`, `infra/backup`, `tests/restore` or `tests/cli`.

## What is not made lighter

- Doc 10 §4.1.
- Test first for every behaviour a plan names.
- Real stores as proof: no mocked API, no component tests.
- The gate itself: the full suite must be green on CI before a session is reported.

## Consequences

- A defect that crosses runs is found at the gate, not in the run that caused it. The gate has to be planned as half a day.
- The browser project runs on Linux for the first time at Session 7's gate.
- A later session may return to heavier runs by marking its pull request ready earlier; nothing in the workflow has to change.
