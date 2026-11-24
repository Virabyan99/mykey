# D-78 — The staging credential drill places its fault with a trigger on the host

**Date:** 2026-11-24

**Status:** DECIDED (P-176; Runs 10.3 and 10.6). Evidence: `docs/evidence/session-10/credential-drill.json`, `run-10.6.md`, `tests/staging/credential-drill.staging.test.ts`, `tests/staging/host-scripts/freeze-on-create.sh`.

## Context

The drill of an issuance left unknown (AC-1.18, AC-1.40, AC-1.57, PO-18) needs OpenBao to receive the token create and leave it unanswered. Until Session 9 the drill paused OpenBao from the workstation over SSH. Such a pause lands 2.5 to 3.4 s after it is sent, and the window is one call. It caught nothing in 20 attempts on `host-v0.8.1`, so the four ids stayed NOT PROVEN. The exact placement was proven only by `tests/fault`, on CI.

## Decision

1. **The fault is placed on the host, by a trigger.** `freeze-on-create.sh` runs as a transient unit for one attempt. It follows OpenBao's audit device and, at the first request record of `auth/token/create/machine-env-<environment id>`, writes 1 to OpenBao's `cgroup.freeze`. It holds, then writes 0. OpenBao writes a request's audit record before it handles the request, so the create is received and unanswered.
2. **Up to five attempts, each in a fresh minute.** Every attempt ends thawed, whatever happened: the unit's stop command, the script's own exit trap, and the test's `thaw`.
3. **Never a host file, never on production.** The script is sent for one run; the file refuses to start without OpenBao's audit file and its freeze file.

## Result (Run 10.6, restored staging, `host-v0.9.2`)

- **The order, measured once with a hold of 0 s:** the trigger matched the create's record 114 ms before the API's 201 (the host's clock against the workstation's; staging's chrony offset 0.03 ms), and froze 1.2 ms after matching.
- **The drill: caught on the first attempt.**
  - The trigger froze OpenBao 0.98 ms after the record.
  - The issuance answered `503 outcome_unknown`, and the credential was `needs_review`.
  - The probe delivered `operations_unresolved` 21 s after the attempt was sent.
  - `quiesce`, then `ops reconcile-credentials --executors-excluded yes` (1 issuance settled), then `resume` and the gate opened again. The alert cleared.
- The file passed to its end.

## Consequences

- The four ids can name `credential-drill` at Run 10.7's manifest.
- `known-limits.md`'s line "places its fault by chance" is replaced by what is now true.
- The trigger depends on cgroup v2 with Docker's systemd driver, and on OpenBao's audit device writing to a file the host can read. A host without either stops the drill at its first step, with nothing changed.
- One attempt in one run is evidence, not a rate. The drill keeps its five attempts.
