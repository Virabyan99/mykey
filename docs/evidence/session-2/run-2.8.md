# Run 2.8 — CLI approach decision

**Result: DONE on 11 Nov 2026**, inside the two-hour cap. OpenBao Agent 2.7.2 in process-supervisor mode was run in a container from the pinned OpenBao image against the dev stack, with a machine token issued by the root token, and all nine questions of the plan were answered (seven observed, two documented). The thin CLI of D-08 stands (D-24).

AGENT-B1 stays OPEN (owner run 5.7); this run note is contributing evidence.

## What was done

- `tests/fixtures/agent-spike/`: `agent.hcl`, `child.sh` (prints the names of its environment variables and the state of each expected one, never a value), `run.sh` (five scenarios and the old-version read), `drive.ts` (one synthetic organization on the dev stack, a machine token, the container on the stack's network), `README.md`.
- D-24 with the table, the verdict and nine requirements for Run 5.5.

## Commits

- this commit: docs(decisions): D-24 thin CLI over OpenBao Agent, with measurements

## Commands and results

| Command                                                                       | Exit | Proof line                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker run … bao version` (pinned image)                                     | 0    | `OpenBao v2.7.2 (9e0a0d3c…)`                                                                                                                                                                                                       |
| `node tests/fixtures/agent-spike/drive.ts` (first run)                        | 0    | s1: Agent exit 7 = child's; names `A_ONE,A_TWO,BAO_ADDR,BAO_CACERT,BAO_NAMESPACE`; token file readable · s2/s3: child never started · s4: `CHILD-GOT-TERM` · s5: write failed (exit 2) · q6: version 1 read with the machine token |
| same, after adding `-cas=1` to the change and printing the Agent's log for s2 | 0    | s2: `no secret exists at …/A_MISSING` every second, Agent exit 0 once stopped · s5: two child starts, one TERM after the change                                                                                                    |
| `gh api repos/openbao/openbao/releases/tags/v2.7.2`                           | 0    | archives for darwin, freebsd, linux, netbsd, openbsd, windows                                                                                                                                                                      |
| `pnpm run check`                                                              | 0    | —                                                                                                                                                                                                                                  |

## Deviations and decisions

- **R51 — the dev stack is started by the spike and removed afterwards by hand** (`pnpm run stack:down`): `drive.ts` leaves it running, because removing a stack deletes its volumes and the driver cannot know whether they hold someone's work.
- **The first change write failed** because the KV mount requires check-and-set; `run.sh` now writes with `-cas=1`. Only the second run's s2 and s5 lines are new; every other line was the same in both runs.
- **Busybox `timeout`** passes on the Agent's own exit code (0 after it handled SIGTERM) instead of 124; the "124" hint printed by `run.sh` is therefore never shown, and s2/s3 are read from the log.
- The registry is not edited in this run (ruling R6).

## Open issues

- Process-supervisor behaviour on Windows was not observed (only a Linux container).

Verdict: GO
