# Run 11.10 — `host-v0.10.0` on production

**Date:** 27 Nov 2026, after the gate. **Branch:** `prod-host-v0.10.0`. D-85, on the owner's word: "push it to production now".

## Result

Production serves `host-v0.10.0` (source `5e13f421a4e6`), gate open at epoch 15 from 07:21:57 UTC. Migration `0019_automation_and_runtime` is applied. The owner did the journey on the new build and confirmed it.

Production was closed from about 07:12:50 to 07:21:57 UTC, about nine minutes. It stayed closed between the two deploys; the second closed it again (epochs 13 and 14) before it opened.

## Before

- **The question.** The owner asked whether Session 11 had reached production. The answer was no, by D-80, with its two costs: no way back but a restore, and a 28-day record of two releases. The owner asked for the deploy.
- **Production, read-only:** gate open at epoch 11, build `0486f24c3b6e` (`host-v0.9.2`), disk and capture fine.
- **The restore point:** the pair of 27 Nov 2026, 03:00:04 UTC, eligible.
- **The release:** `~/mykey-release/host-v0.10.0`, `sha256sum -c SHA256SUMS` all OK. `release.json` is `457ebd63…7b26`, the digest Run 11.8 recorded.
- **Host files:** the one change between the two releases' sources under `infra/` is `field-day.sh`'s `set -f` fix. It is Session 10's (`427ddfb`) and was already on production, so no `push` was needed.
- **The workstation:** no test or host job was running.

## The deploy (`production.md` §4)

| Step | Command                                                                    | Result                                                                                                                                        |
| ---- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `deploy --release …/host-v0.10.0 --stay-closed` (07:10:04 to 07:14:37)     | `load_images` 146 s, `gate_close` 22 s (epoch 12), `migrate` 39 s (`applied 0019_automation_and_runtime.sql`), `start` 34 s; exit 0           |
| 2    | `tunnel verify --browser`                                                  | The owner's window at production's own name                                                                                                   |
| 3    | The owner's journey                                                        | Signed in; revealed a secret of an older project and found the value they expected; creating a project refused with "The service is not open" |
| 4    | `deploy --release …/host-v0.10.0 --owner-confirmed` (07:19:07 to 07:22:06) | `journey: owner confirmed (--owner-confirmed)`, the report, `gate_open` (epoch 15); exit 0                                                    |

## After

- **`host.ts prod status`:** every line `ok`:
  - gate open, OpenBao unsealed (KMIP), KMS reachable;
  - provisioner healthy, `reviewOpen` 0, `operationsUnresolved` 0;
  - no failed unit, backup expected.
- **The gate record:** `state` open, `gateEpoch` 15, `releaseBuild` `5e13f421a4e6`, written 07:21:57.348Z.
- **The probe:** `health_failing` opened during the closed window, as `deploy.md` says it may. Failing since 07:13:32, opened 07:17:32, resolved 07:22:32 UTC, both delivered. At 07:24:32 nothing was open.

## What it means

- **No rollback:** `deploy` refuses `host-v0.9.2` on production now (D-57). The way back is a restore of the 03:00 pair or a later one.
- **The owner's application** keeps its 30-day token and `cli-v0.1.2`. That CLI ran its whole journey on `host-v0.10.0` on staging (`staging-cli-released-0.1.2.json`, Run 11.8). A runtime credential needs `cli-v0.2.0`.
- **Gate F at W-2** (20 Dec 2026) judges 28 days of two releases: `host-v0.9.x` until 27 Nov 07:13 UTC, `host-v0.10.0` after (D-85).
- **Not done on production:** no runtime or automation credential has been issued there yet, and no staging file runs against production.
