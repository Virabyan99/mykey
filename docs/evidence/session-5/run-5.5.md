# Run 5.5 — CLI core and `keys`

**Result: DONE on 15 Nov 2026.**

- **The thin CLI exists**: `apps/cli/dist/secrets.mjs`, one ESM file built by esbuild that imports only `node:` modules. `secrets keys` and `secrets --version` work. `run` and `export` parse and answer `78` until Run 5.6.
- **These fail before a credential is sent:**
  - an HTTP URL;
  - an untrusted authority, a certificate for another host name, an expired certificate;
  - `NODE_TLS_REJECT_UNAUTHORIZED=0` and `NODE_OPTIONS`;
  - a redirect of `/v1/version`;
  - another API major, and an HTML version body.

  Each has its exit code, and the test server saw no `Authorization` header.

- **A redirect of `keys` is refused.** Its target saw nothing; the one credentialed request went to the API itself.
- **`keys`** prints the names only when the whole answer passed. A wrong count or a bad name gives `65` and an empty stdout.
- **Real stores:** the CLI's own client against the fixture's API. Every body passes the CLI's validators, the digests equal the owner's export, and refusals carry the server's request id.
- On Windows, `pnpm run test:cli` checks the native refusal (`78`) and runs project `cli` in a glibc Linux container.
- Decisions: D-43 (first half).

FR-1.46 SPIKE_PASS — credential input: `tests/unit/cli/{token,args}.test.ts`; `tests/cli/connection.test.ts` (no source, two sources, 4,097 bytes → 64, no request) and `keys.test.ts` (`--token-stdin`); `runCli` fails whenever a token comes back on stdout or stderr. Linux (container) evidence; the four platforms are Run 5.7.
FR-1.47 SPIKE_PASS — keys: `tests/cli/keys.test.ts` (7), `tests/integration/machine/cli-client.test.ts` (5, real stores). Linux evidence.
FR-1.79 SPIKE_PASS — connection: `tests/unit/cli/{config,guard}.test.ts`, `tests/cli/connection.test.ts` (10) and `cli.test.ts`. Linux evidence; AC-1.37 on the four runners is Run 5.7.

## What was done

- **Contract:**
  - `contract: api major as a constant`: `API_MAJOR = 1`, used by `version.get`'s schema and by the API's version and machine handlers. `openapi.json` is unchanged byte for byte (`cmp`).
  - `machineKeysBody` and `machineResolveBody` are exported for the CLI's validator.
- **`apps/cli`** (version `0.1.0`, `bin: secrets`):
  - `args.ts`: the grammar. No flag carries a token, and no error quotes input.
  - `config.ts`: the API URL (variable, else the user's own config file; a bare https origin only) and the selector.
  - `guard.ts`: runtime settings and platforms.
  - `token.ts`: one source.
  - `errors.ts`: eight categories, the HTTP table, the stderr line.
  - `validate.ts`: a body is used only when it is whole and complete.
  - `client.ts`: `node:https`, verification on, no redirect, a deadline, a capped body, the version first.
  - `keys.ts`, `main.ts`, `bin.ts`; `identity.ts` holds D-08's constants and `CLI_VERSION`.
  - `build.ts`: the esbuild bundle.
- **Pins:**
  - npm `esbuild` 0.28.2 (already in the lockfile through vite and drizzle-kit);
  - image `node-glibc` = `node:24.22.2-bookworm-slim@sha256:01d566e8…`, test-only and not scanned.
- **Tests:**
  - `tests/unit/cli/` (6 files, 24 tests);
  - project `cli`: `tests/cli/{setup,certs,server}.ts`, `connection.test.ts` (10), `keys.test.ts` (7), `cli.test.ts` (5: `--version` makes no request; the bundle imports `node:` only);
  - `tests/harness/cli.ts` (`runCli`);
  - `tests/integration/machine/cli-client.test.ts` (5).
- **Scripts:** `pnpm run cli:build` and `pnpm run test:cli` (`scripts/test-cli.ts`).
- **`.gitignore`:** `apps/cli/release/`, `tests/cli/.certs/`.
- **Docs:** D-43.

## Commits

- `77e58f7` contract: api major as a constant
- `ceeebde` feat(cli): arguments, configuration, guards, error model, response validation
- this commit: feat(cli): verified connection, version check and keys

## Commands and results

| Command                                                                                               | Result                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tests/unit/contracts/routes.test.ts` before `API_MAJOR`                                              | RED (1 failed: `API_MAJOR` undefined); after: 19 passed; `openapi.json` byte-identical                             |
| `tests/unit/cli` before the modules                                                                   | RED (24 failed: functions missing)                                                                                 |
| the same after                                                                                        | 24 passed                                                                                                          |
| `node apps/cli/dist/secrets.mjs keys` on Windows                                                      | exit 78, `secrets: unsupported: native Windows is not supported; use Linux or macOS (code: none, requestId: none)` |
| `pnpm run test:cli` (Linux container, 817 files copied)                                               | 21 passed on the first run, then 22 with the client test below                                                     |
| mutation A: a bearer on `/v1/version`; `rejectUnauthorized: false`                                    | 6 failed (certificates, both redirects, the version cases, the keys order); restored                               |
| mutation B: the count check removed; the client's version check skipped                               | the count case failed; the version skip **survived** (`main` calls `version()` itself)                             |
| `the client itself checks the version before its first credentialed call` added; mutation C: the skip | failed; restored                                                                                                   |
| `tests/integration/machine/cli-client.test.ts`                                                        | 5 passed                                                                                                           |
| mutation: the error envelope ignored                                                                  | 3 failed (the revoked, foreign-path and held-slot cases); restored                                                 |
| `pnpm test` (unit)                                                                                    | 926 passed                                                                                                         |
| `pnpm run check`                                                                                      | exit 0                                                                                                             |

## TDD

- **Task A:** RED first.
- **Task B:** the client, `main` and `keys` were written before their tests: the order of the plan was not kept. The tests' reach was proven instead by the four mutation runs above. One mutation survived and showed a gap, which was closed with a test that drives `createClient` directly.

## Deviations and decisions (rulings in the ledger)

- `export` takes `--output` (Doc 04), not the plan's `--out`.
- A 400 from the API is `76 incompatible`; an unknown status is `69`.
- The guard is stricter than the plan:
  - `NODE_TLS_REJECT_UNAUTHORIZED` with any value but `1`;
  - `NODE_OPTIONS` even when empty;
  - `-r` besides the six `execArgv` forms.
- The API URL must be a bare origin (no path).
- **The container image is `node:24.22.2-bookworm-slim`, not "the pinned Node image".** The pinned image is Alpine (musl), and the CLI refuses a Linux without glibc there. The Debian image has no `openssl`, so `test:cli` makes the certificates on the host and copies them in.
- `identity.ts`, `bin.ts` and `tests/cli/certs.ts` are files the plan did not list. `tests/unit/cli/token.test.ts` was added.
- `run` and `export` answer `78` ("not in this build") until Run 5.6.

## Open issues

- **macOS runners** may ship LibreSSL as `openssl`. Whether `-days -1` and `-addext` work there is met in Run 5.7.
- `pnpm install` warns "Failed to create bin … secrets.mjs" while `apps/cli/dist` is unbuilt. It is harmless.
- One unit run hit a 5 s timeout in `tests/unit/registry/registry.test.ts` right after `check`; the rerun passed.

## What Run 5.6 must know

- `main` answers `78` for `run` and `export`. Replace that branch.
- `readToken` is already called with `tokenStdin: false` for `run`, and `--token-stdin` is refused for `run` by the grammar.
- `client.resolve` returns a validated `ResolveBody`. Its deadline is 150 s.
- `tests/cli/server.ts` has `goodResolve(entries)` and the `Reply` script, including `"hang"` and `noLength`.
- Run project `cli` only through `pnpm run test:cli` on this workstation. One run takes about two minutes, most of it the install in the container.
