# D-22 — Probe and alert path

**Date:** 2026-11-11

**Status:** DECIDED by the executing agent in Run 2.6. Evidence: `tests/unit/probe/*.test.ts`, `tests/staging/probe.staging.test.ts`, `docs/evidence/session-2/probe-drill-staging.txt`, `docs/evidence/session-2/run-2.6.md`. Runbook: `docs/runbooks/probe.md`.

## Decision

- **P-33 holds.** One Cloudflare Worker `mykey-probe` (custom domain `mykey-probe.nomikey.com`) with a cron trigger every minute and a D1 database `mykey-probe`. Its decision logic is a pure function (`workers/probe/src/evaluate.ts`) tested in the `unit` project; time is passed in, and the Worker's own clock stamps every heartbeat.
- **Four conditions.** `heartbeat_missing` (no heartbeat for more than the grace; a host never heard from counts from when the Worker first listed it), `health_failing` (the public `/health` failing continuously for the grace), `openbao_sealed` and `kms_unreachable` (reported by the host's heartbeats continuously for the grace; `null` never opens them). A condition resolves at the first good observation; `resolved` is sent only for a condition whose `opened` was delivered.
- **One grace, on purpose.** Doc 06 §12 gives one value (three minutes); the heartbeat, health and reported graces are all `LIMITS.monitoring.heartbeatGraceSeconds` (180 s). An open condition is repeated every `LIMITS.monitoring.alertReminderSeconds` (3600 s; added to the limits in this run, a planner value not in Doc 06).
- **Nothing counts as sent that was not sent.** An `opened` or `reminder` intent is produced on every evaluation until a sink has answered 2xx; every attempt is in `alert_log` with `delivered` 0 or 1.
- **One sink: Telegram**, the owner's choice. A webhook sink exists for the sink-failure test; e-mail answers "not delivered".
- **Routes.** `POST /v1/heartbeat/<host>` with the host's own token; `GET /v1/state/<host>` with a read token; everything else, an unknown host and a wrong token answer 404. Tokens are compared through their SHA-256 digests in constant time.
- **Host side.** `mykey-heartbeat.timer` every 60 s runs `heartbeat.sh` (`status.sh` → `{bootId, sealed, kmsReachable}`), one attempt with a 10 s timeout, URL and token in a root-only curl config. The probe's addresses are the egress set `probe`.
- **Deployment without wrangler (R53).** `scripts/probe.ts` uploads the Worker through the Cloudflare API, with Node stripping the TypeScript types. wrangler 4.160.0 depends on pre-release packages (`miniflare` 5.20261110.0-beta, `unenv` 2.0.0-rc.24), which the pin rules exclude. `workers/probe/wrangler.jsonc` keeps wrangler's layout.

## Measured

On staging, with the real Telegram channel (`docs/evidence/session-2/probe-drill-staging.txt`):

| Drill                                                                 | Observed                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blackout 480 s (every packet dropped, VPN included)                   | `heartbeat_missing` delivered 170 s and `health_failing` 290 s after the host went dark (limit 300 s); both resolved 536 s after it went dark, 56 s after the automatic restore; SSH over the VPN back with no command |
| `edge` stopped, restarted by a timer at 300 s                         | `health_failing` delivered 232 s after the stop, resolved at 356 s; `heartbeat_missing` stayed closed                                                                                                                  |
| A sink that answers 404 (separate Worker, a host that does not exist) | 24 delivery attempts over about 12 minutes, none recorded as delivered, `lastAlertAt` stayed null                                                                                                                      |
| A new cron trigger                                                    | the first scheduled run came about 7 minutes after the trigger was created (Cloudflare documents up to 15)                                                                                                             |

`heartbeat_missing` can open before 180 s after a host goes dark, because the grace counts from the last heartbeat, which was up to a minute earlier.

## Open

- **Nobody notices when the Worker itself stops** (Doc 06 §12 "checker disappearance"): Run 6.4.
- The probe's custom domain resolves to Cloudflare's shared anycast addresses; the egress set `probe` therefore admits other Cloudflare-served sites on 443 (the weakness of D-21).
- A `resolved` whose delivery fails is not retried.

## Cost if wrong

If the grace is too short, planned work produces alerts; if too long, an outage is reported later. Both are one number in `LIMITS`.
