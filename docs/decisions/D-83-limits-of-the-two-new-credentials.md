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

## Amends

Doc 06 §11, by addition only.
