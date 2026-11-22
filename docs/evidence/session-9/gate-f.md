# Gate F — Stage 1 completion (OWN-9, D-74)

**For the owner to sign.** Everything here comes from `exit-dossier.md` and its evidence, corrected after the gate review (`gate-review.md`).

## The dossier in ten lines

1. **Production runs `host-v0.9.1`** (`b19ca6671e14`) with `cli-v0.1.2`, open since 22 Nov 2026 (epoch 7), with the probe watching.
2. **No application runs on it yet.** consumer-1 (your WSL) has made names-only starts. The values you entered may be test values.
3. **Real use: day 1,** about an hour at the time of writing (D-05). The 28 days are W-2, on 20 Dec 2026.
4. **The manifest of `host-v0.9.1`** gives 144 PASS (33 on older evidence, each line says which), 9 NOT PROVEN and 7 NOT YET DUE (this gate).
5. **The reworked workspace** passed your seven tasks unaided, after its first build failed your first look.
6. **A machine token was exposed on first use** (F-9.2-1) by the connect panel's token step, the second such leak after Run 8.8. It was revoked unused. **The panel still shows that step.**
7. **The agent experiment:** the runner's boundary held for every request sent. It is not a pass by the plan's rule: the model declined three adversarial scenarios, and no agent met revocation or outage.
8. **The restore code changed this session** and is proven locally only. The staging re-drill is deferred to before 31 Dec 2026.
9. **The baseline:** no value in files on the consumer, against `.env`, history and a root token for plain OpenBao. On first use, MyKey too put a token and test values on the screen.
10. **The agent recommends HARDEN** (below), and deciding the next stage at W-2.

## What is not proven, and what is not yet due

- **NOT PROVEN** (manifest): AC-1.18, AC-1.25, AC-1.26, AC-1.36, AC-1.40, AC-1.52, AC-1.55, AC-1.57, PO-18. Each has its reason in `manifest.md`.
- **Not yet due:**
  - **this gate's own ids:** FR-1.98, FR-1.99, FR-1.100 and AC-1.53, AC-1.54, AC-1.58, AC-1.59;
  - **W-1:** retention ageing, 23 to 26 Dec 2026;
  - **W-2:** 28 days of use, 20 Dec 2026;
  - **AC-1.58:** a real consumer for 28 days, which also needs an application to run.
- **Gate F's own condition** in Doc 10 §2, "a real non-critical app runs on MyKey", is **open**.

## The open Mediums

- **F-9.2-1:** the connect panel's token step. It needs a release, and your journey on production.
- **RR-2:** a restore must reach `--open` within two hours of step 4 (`known-limits.md`).
- **The restore re-drill (D-73).** Until it runs, the restore code is untested on a host, and generate-root's host path has no test.
- **Session 8's accepted Mediums,** in `known-limits.md`.

## The maintenance calendar

Each row needs you to start a session; the agent runs nothing between sessions.

| By (UTC)                | What                                                                      | Who                                          |
| ----------------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| 5 Dec 2026              | Replace staging's KMS certificates (they expire 12 Dec; alert from 2 Dec) | You issue in the OVH console; agent installs |
| 12 Dec 2026, 09:57      | Checkpoint `kms-cert-expiry`                                              | You start a session                          |
| 14 Dec 2026             | Replace production's seal certificate (expires 21 Dec, 07:48)             | You issue; agent installs                    |
| 14 Dec 2026             | `.trivyignore.images` expires: review                                     | You start a session                          |
| 17 Dec 2026, 19:00      | Checkpoint `pair-30-day`                                                  | You start a session                          |
| about 20 Dec 2026       | Rotate consumer-1's token (it expires by about 22 Dec)                    | You, with a session                          |
| 20 Dec 2026             | **W-2,** the 28-day report; you add costs and friction notes              | You start it                                 |
| 23 to 26 Dec 2026       | **W-1,** retention ageing                                                 | You start a session                          |
| 31 Dec 2026             | Staging restore re-drill (D-73)                                           | You reinstall staging; agent runs it         |
| weekly from 29 Nov 2026 | `field-pull` and the weekly report                                        | You start a session                          |

## The four choices

- **ADVANCE.** Start Stage 2 (Doc 09: invited managed teams) with its planning session now, on today's evidence.
- **HARDEN (or re-scope).** Stage 1 stays open on a short list: connect a real application, ship the one-command token step, run the restore re-drill, re-aim the credential drill. Gate F is decided again at W-2, on 28 days of use.
- **PIVOT.** Rewrite the next stage as an agent-ready private product (Doc 02 §7.1) instead of invited teams. It starts with a plan for workload identity and the runner as a supported feature.
- **STOP.** Keep MyKey Private running for your own use as it is, with the calendar above, and start no further stage.

**The agent's recommendation: HARDEN.**

## Running MyKey Private in the meantime

- **Production** stays open on `host-v0.9.1`. Every change to it is `--stay-closed`, then your journey in the `tunnel verify --browser` window, then `--owner-confirmed`.
- **consumer-1:** start your application through `secrets-launch.sh` at least once a day, or the days count as "no activity". Store a new token only with the one-command form in `known-limits.md`. Never paste a token or value into a chat.
- **Weekly:** `field-pull` and the weekly report. The calendar rows as dated.
- **A restore of production before the re-drill** only in an emergency, and then inside the two-hour window.

---

**Decision:** ADVANCE / HARDEN / PIVOT / STOP (circle one)

**Merge PR #23 into `main`:** yes / no

**Signed:** ________________ **Date:** ____________
