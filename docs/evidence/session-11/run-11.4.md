# Run 11.4 — The CLI exchanges a runtime credential (0.2.0)

**Date:** 26 Nov 2026. **Branch:** `session-11`. P-187, D-81, D-83.

## What was done

- **The CLI takes a runtime credential where it takes a token.** `SECRETS_MACHINE_TOKEN`, or `--token-stdin` for `keys` and `export`, may hold a client secret (`mkrc.<id>.<secret>`). After the version check the CLI exchanges it once (`POST /v1/machine/exchange`, the bearer and no body) and runs the command with the exchanged token, exactly as it runs with a 30-day token.
- **A 30-day token makes no exchange.** Nothing of that path changed.
- **The answer of an exchange is checked** as every machine answer is: the whole body, the contract's shape, the API's major version. Its token must also have a token's shape before it goes into a header. Anything else is exit 65 and nothing starts.
- **A refused exchange is final:** 401 is exit 77, 429 is exit 75, 503 is exit 69, each with one line on stderr that holds the code and the request id and no part of the secret.
- **The child never sees either secret.** Its environment holds neither the client secret nor the exchanged token.
- **The fleet test now starts through the CLI's own client,** both calls (owed since Run 11.3).
- **`apps/cli/package.json` is 0.2.0.** The release `cli-v0.2.0` is built at the freeze (Run 11.8). `cli-v0.1.2` is unchanged.
- **The documents name `cli-v0.2.0`:** the agent guide, both consumer runbooks, `start-here.md`, the README and the workspace's copy of the runbooks.

## Commit

- `feat(cli): a runtime credential is exchanged before the read (0.2.0)`.

## Commands and results

| Command                                                                                    | Result                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `tests/unit/cli/validate.test.ts`, before `validateExchange`                               | 2 failed as intended (`validateExchange is not a function`)                               |
| `tests/integration/machine/cli-client.test.ts`, the runtime case, before `client.exchange` | failed as intended (`client.exchange is not a function`)                                  |
| `pnpm run test:cli tests/cli/exchange.test.ts`, without the step in `main.ts`              | 7 failed as intended (the client secret went to `resolve`: 401); the 30-day case passed   |
| `tests/integration/machine/cli-client.test.ts` and `fleet.test.ts`                         | 2 files, 7 tests passed; the fleet's two rounds 17.3 s, the slowest start 9.3 s           |
| `pnpm run test:cli` (the whole CLI suite, in its container)                                | 10 files, 80 tests passed (the eight exchange cases; the busy pin: 75 after ten requests) |
| `pnpm test` (unit)                                                                         | 143 files, 1630 tests passed                                                              |
| `pnpm run check`                                                                           | green                                                                                     |
| CI on the draft pull request (#27), after Run 11.3's push                                  | green: `check` and `secret-scan` (run 45694151023)                                        |

## Deviations and decisions

- **The integration case uses the client module, not `secrets run` with a child.** The integration project has no bundle, and the CLI refuses native Windows, where that suite runs locally. The case exchanges and resolves on the real API: 25 entries whose digests equal the owner's export; after the revocation the exchange and the exchanged token are both refused. The whole process with a child is proven in `tests/cli` against the test server, and on staging in Run 11.8.
- **The exchange is asked once.** Only a machine read is asked again on `busy`.
- **The exchanged token must have a token's shape,** beyond the contract's schema.
- **The test server keeps the SHA-256 of each bearer** in a second list, and refuses a client secret on `keys` and `resolve` as the API does.
- **`main.ts`'s step was written before its red run.** It was taken out for that run and put back.
- **The busy pin of Run 11.3** (`tests/cli/run.test.ts`, ten requests) ran here for the first time.
- **The documents moved to `cli-v0.2.0` in this run, not in Run 11.7.** `tests/unit/agents/guide.test.ts` holds the guide's release equal to `apps/cli/package.json` (its first run after the bump: 1 failed). The other documents moved with it, so that no two of them name different releases.

## Open issues

- **The documents name a release that does not exist yet.** `cli-v0.2.0` is built in Run 11.8. Until then the download steps of this branch's runbooks fail, and `test:consumers` cannot run. `main` still names `cli-v0.1.2`; this branch is merged only after the release.
- **`cli-matrix`** (Linux and macOS, both architectures) runs by hand at the gate with `cli_release=cli-v0.2.0`.
- **The stop line (P-198).** After this run the runtime credential is complete and releasable on its own.
