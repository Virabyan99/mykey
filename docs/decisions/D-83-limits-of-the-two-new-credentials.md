# D-83 — The limits of runtime and automation credentials

**Date:** 2026-11-25

**Status:** DECIDED (P-196; Run 11.2), on the owner's answers 2 and 3 of `docs/evidence/session-11/owner-requests.md`. Evidence: `packages/contracts/src/limits.ts`, `tests/unit/contracts/limits.test.ts`, `docs/runbooks/limits.md`, `run-11.2.md`.

## Context

Doc 06 §11 lists every limit of Stage 1, and it knows one machine credential: a token of at most 30 days. Session 11 (D-80) adds two credentials that live longer and are checked by the API. Their limits are not in Doc 06 and need a record, or the next reader of `limits.ts` finds numbers with no source.

## Decision

| Limit                                 | Value                                              | Why                                                                                                                             |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A runtime credential's lifetime       | default and maximum 31,536,000 s (365 days)        | A server restarts unattended for months. A year makes rotation a yearly task that is rehearsed; "no expiry" is never rotated.   |
| The token of one exchange             | 900 s, not renewable                               | It bounds what a revoked credential's last token can still read in OpenBao (P-189): at most 15 minutes.                         |
| An automation credential's lifetime   | 3,600 s to 31,536,000 s; default 604,800 s (7 d)   | It can create and issue. A short default makes the long-lived one a choice somebody typed.                                      |
| Bound source networks                 | at most 8 for each kind; at least 1 for automation | A provisioning secret usable from anywhere is the worst leak this session can add. A runtime credential may be unbound.         |
| Exchanges of one runtime credential   | 10 a minute                                        | A fleet boot is 10 servers with two exchanges each in 20 seconds, one credential per server. A loop is stopped within a minute. |
| Requests of one automation credential | 120 a minute                                       | The same number a person's session has.                                                                                         |
| Secrets nobody can attribute          | the existing 30 misses a minute per source         | One counter for every bearer nobody can name, so a guesser gains nothing by changing the prefix.                                |
| The expiry warning                    | the existing 7 days                                | One rule for every credential in the inventory.                                                                                 |

The values are `LIMITS.runtimeCredential`, `LIMITS.automationCredential`, `LIMITS.rate.exchangePerCredentialPerMinute` and `LIMITS.rate.perAutomationCredentialPerMinute`. The database repeats two of them as checks (at most 8 networks; 1 to 8 for automation), read from `LIMITS` when the migration is generated.

## Consequences

- A request outside a lifetime's range or with a ninth network is `422 validation_failed`. No error code is added.
- A platform whose egress addresses change must bind a wide network or re-issue. `known-limits.md` says so (Run 11.7).
- Doc 06 §11 is not edited (`docs/doc_*.md` files are never reformatted). This record and the comments in `limits.ts` are the source for these numbers.
- A change to any of them is a `contract:` commit: the lifetimes are in the OpenAPI file.

## The fleet, measured (Run 11.3): the CLI asks ten times

The input specification says: ten runtime credentials from one source, each exchanging and resolving twice within 20 s, all succeed under the default limits, "or the defaults move by decision". Run 11.3 measured it (`docs/evidence/session-11/measurements.json`), with ten credentials of **one** environment, which is the hard case: ten instances of one application.

- **No rate limit refused anything.** The limits above hold a fleet of ten.
- **What paces a fleet is D-49's concurrency, which is not changed.** Complete reads of one environment are admitted about two every 1.6 s (the read cool-down of 1.5 s, two large requests a process). Requests that wait for the cool-down hold the process's two large slots, so the others are answered `503 busy` at once.
- **With the five requests of `cli-v0.1.2` (3.75 s of pauses), 8 of the 10 started.** Two exited with `busy`. Ten credentials spread over three environments did no better (8, then 7).
- **Decision: the CLI asks ten times, over 13.75 s** (`BUSY_PAUSES_MS`: 250, 500, 1,000 and six times 2,000 ms). It is in the CLI from `0.2.0`. The server is unchanged, and so is D-49's fairness rule for writers.
- **With ten requests, 10 of 10 started, twice.** Alone on the workstation: one round in 7.7 s, two rounds in 16.8 s, the slowest start 9.1 s, at most 7 requests for one start. With another suite running beside it: two rounds in 19.6 s, the slowest start 10.0 s.
- **The 20 s of the specification is met as measured and is not guaranteed.** One round of ten cannot be faster than about 7 s, whatever the client does. The test (`tests/integration/machine/fleet.test.ts`) asserts that all twenty starts succeed and that no limit refused one, within 30 s; it records the time against 20 s.
- **What it costs:** a start against an API that stays busy now fails after about 14 s where it failed after about 4 s. Ten requests are well inside the 60 a minute of one credential, and a fleet of twenty behind one address stays inside the 300 a minute of one source.
- **Still true for `cli-v0.1.2`,** which production's consumer runs: more than about six instances of one environment started in the same second lose some, which their supervisor starts again. It is a line of `known-limits.md`.

## Amends

Doc 06 §11, by addition only. The CLI's retry rule of Session 5's gate review (five requests), from `cli-v0.2.0`.
