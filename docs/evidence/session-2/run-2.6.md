# Run 2.6 — Off-host probe and alert path

**Result: DONE on 12 Nov 2026.** Step 5: the owner confirmed on 12 Nov 2026 that the alert messages arrive in the Telegram chat ("receiving telegram messages since yesterday"). The Cloudflare Worker `mykey-probe` takes a heartbeat from both hosts every minute and probes their public `/health`; cutting the staging host off from the network completely produced delivered alerts within the grace period, and they resolved by themselves when the host came back. Decision record: D-22. Runbook: `docs/runbooks/probe.md`.

PO-14 SPIKE_PASS — an off-host alert path proven on staging: a 480-second blackout produced `heartbeat_missing` (170 s) and `health_failing` (290 s) messages accepted by Telegram's API (`delivered = 1`), both resolved after the automatic restore; a dead endpoint on a live host raised only `health_failing`; a failing sink never counted as sent (`tests/staging/probe.staging.test.ts`, `probe-drill-staging.txt`). Run 6.4 closes it (and the Worker's own disappearance).

## What was done

- **Worker** (`workers/probe/`): `evaluate.ts` (pure), `sinks.ts`, `store.ts` (D1, heartbeat and evaluation in separate rows), `index.ts` (routes and the minute's evaluation), `wrangler.jsonc`, `migrations/0001_init.sql`. Unit tests: `evaluate`, `sinks`, `auth`, `config` (19).
- **Deployment** (`scripts/probe.ts`): `deploy` (D1 database and migration, modules through the Cloudflare API, cron, custom domain `mykey-probe.nomikey.com`), `secrets` (read and heartbeat tokens to the Worker, Telegram secrets, the hosts' root-only curl configuration, the heartbeat timer), `state`, and `sinktest up|rows|down` for the sink-failure drill.
- **Hosts**: `heartbeat.sh`, `mykey-heartbeat.{service,timer}`, `mykey-egress.sh blackout <seconds>` with `mykey-blackout.nft`. Both hosts send heartbeats; the egress set `probe` holds the Worker's addresses.
- **Drills** on staging (`tests/staging/probe.staging.test.ts`), runbook, D-22, custody rows, `LIMITS.monitoring.alertReminderSeconds`.

## Commits

- 3fe9acd feat(probe): heartbeat and health probe Worker with a pure decision function
- this commit: feat(probe): off-host alert path proven by a blackout drill (early PO-14)

## Commands and results

| Command                                                                                              | Exit | Proof line                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run --project unit tests/unit/probe` before the Worker                             | 1    | `Cannot find module …/evaluate.ts` (RED)                                                                                                 |
| same, after                                                                                          | 0    | 19/19 (after a 204-with-body bug in the test's fetch stub was fixed)                                                                     |
| `node scripts/probe.ts deploy`                                                                       | 0    | `d1: created mykey-probe`, `applied 0001_init.sql`, `worker: uploaded`, `crons * * * * *`, `custom domain mykey-probe.nomikey.com`       |
| `node scripts/probe.ts secrets` (first)                                                              | 1    | staging: `curl: (7) Failed to connect`: the probe's address was not yet in the egress set (the name started resolving after the refresh) |
| `mykey-egress.sh refresh` on both, `resolvectl flush-caches` on production, `probe.ts secrets` again | 0    | `probe 2` addresses in the set on both hosts; heartbeats from both                                                                       |
| `pnpm exec vitest run --project staging tests/staging/probe.staging.test.ts`                         | 1    | 3/4: heartbeats, blackout, dead endpoint pass; sink failure: the new sink-test Worker's cron had not started within 600 s                |
| sink-test Worker polled until its first state row                                                    | —    | first scheduled run about 7 min after the cron was created                                                                               |
| `… -t "sink fails"` against the running sink-test Worker                                             | 0    | 1/1: 24 attempts, none delivered                                                                                                         |
| `pnpm run check`                                                                                     | 0    | —                                                                                                                                        |

## Deviations and decisions

- **R52** `alertReminderSeconds` (3600) added to `LIMITS.monitoring`: a planner value, not one of Doc 06 §11's.
- **R53** no wrangler: 4.160.0 depends on pre-release packages; `probe.ts` deploys through the Cloudflare API and Node strips the types.
- **R54** the D1 state is split into `heartbeat` and `host_state` (plus `alert_log`); `HostState` gains `knownSince` and `sinceMs` per open condition.
- **R55** tokens are compared through SHA-256 digests with a constant-time loop (`crypto.subtle.timingSafeEqual` exists only in Workers).
- **R56** the blackout is its own nftables table, loaded 5 s after its removal timer is armed, never in the boot configuration.
- **R57** the e-mail sink answers "not delivered".
- **R59 — the sink test reuses a running sink-test Worker and waits up to 20 minutes**, because a new cron trigger took about 7 minutes to start; the evidence file is appended to, never rewritten (a partial rerun had erased the drill lines once; they were restored from the run's output).
- **The probe's addresses are Cloudflare's shared anycast addresses**, so the egress set `probe` also admits other Cloudflare-served sites on 443 (D-21's open weakness).
- **A resolver that cached "no such name"** before the custom domain existed kept answering that on production until `resolvectl flush-caches` (runbook).
- The registry is not edited in this run (ruling R6).

## Open issues

- Step 5 closed: the owner confirmed that the messages arrive in the Telegram chat (12 Nov 2026); the per-message count of the 11 Nov drills was not checked one by one.
- Nobody notices when the Worker itself stops (Run 6.4).
- A `resolved` whose delivery fails is not retried.

Verdict: GO
