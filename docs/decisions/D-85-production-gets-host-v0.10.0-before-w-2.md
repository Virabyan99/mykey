# D-85 — Production gets `host-v0.10.0` before W-2

**Date:** 2026-11-27

**Status:** DECIDED (owner, 27 Nov 2026: "push it to production now"). Amends D-80, point 1. Evidence: `docs/evidence/session-11/run-11.10.md`.

## Context

D-80 placed Session 11 on staging only: production would get the runtime and automation credentials after W-2 (20 Dec 2026), and until then would keep the `host-v0.9.x` line that Gate F's 28 days are observed on.

On 27 Nov 2026 the owner asked whether production had Session 11's changes, was told it did not and why, with the two costs below, and asked for the deploy now.

## Decision

1. **Production runs `host-v0.10.0`** (`5e13f421a4e6`), the release staging runs since 26 Nov 2026, from 27 Nov 2026 07:21:57 UTC (gate epoch 15).
2. **It was deployed as every production deploy is** (`production.md` §4, D-64): `--stay-closed`, the owner's journey in the `tunnel verify --browser` window, then `--owner-confirmed`.
3. **The owner's consumer keeps its 30-day token and `cli-v0.1.2`,** which work on `host-v0.10.0` unchanged (`cli.staging` with `cli-v0.1.2`, Run 11.8). Moving it to `cli-v0.2.0` is not part of this decision.

## What it costs

- **No way back but a restore.** Migration `0019_automation_and_runtime` is applied; `deploy` refuses `host-v0.9.2` on this host (D-57). The restore point is the pair of 27 Nov 2026, 03:00 UTC, eligible before the deploy.
- **The 28 days of use are of two releases.** From 22 Nov to 27 Nov 07:13 UTC production ran `host-v0.9.1` and `host-v0.9.2`; from 27 Nov it runs `host-v0.10.0`. W-2's report must say so, and Gate F at W-2 judges the release production runs then.
- **D-80's rule that a production fix before W-2 is cut from the `host-v0.9.x` line no longer holds:** a fix is a new `host-v0.10.x`.

## What it does not change

- W-2 stays on 20 Dec 2026; the real-use clock is not restarted.
- The open items of Session 11 (`session-11/report.md`) stay open: the fleet's 20 seconds on staging, the two owner design questions, the deferred minors.
