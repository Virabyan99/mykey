# Run 1.5 — Local development stack

## What was done

- `infra/compose/dev.compose.yml`: `pki-init` (one-shot), `postgres` 18.6 and `openbao` 2.7.2, all by digest. TLS on both services from a development CA generated into a named volume; OpenBao on Raft storage with `seal "static"`; PostgreSQL superuser password through a Compose secret file generated under `.stack/<project>/`.
- `infra/compose/dev/`: `pki-init.sh`, `openbao.hcl`, `postgresql.conf`, `pg_hba.conf` (all LF).
- `tests/harness/stack.ts`: `startStack`, `getSharedStack`, `freshDatabase`, `freshNamespace`, `baoFetch`, `restartService`, plus `mountKvV2`, `stackDirectory`, `stackStatus`, `listStackProjects`, `stopStack`. `tests/harness/global-setup.ts` starts one stack per test run.
- `scripts/stack.ts` and root scripts `stack:up`, `stack:down`, `stack:status`; `down --all` sweeps every `mykey-t-*` project and `mykey-dev`.
- Integration tests in `tests/integration/stack/` (15 tests) and the runbook `docs/runbooks/local-stack.md`.
- CI: the `integration` job now ends with `node scripts/stack.ts down --all` under `if: always()`.

## Commits

- this commit: feat(infra): local PostgreSQL 18 + OpenBao stack with TLS, Raft, static seal and test harness

## Commands and results

All run from the Windows checkout (path with a space, inside OneDrive).

| Command                                                    | Exit      | Proof line                                                                                                   |
| ---------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm run test:integration` before the harness existed     | 1         | `Failed to load url …/tests/harness/global-setup.ts … Does the file exist?`                                  |
| `pnpm run test:integration` after the first implementation | 1         | `Tests 2 failed \| 18 passed (20)` — KV configuration answered HTTP 400 straight after the mount (see below) |
| `pnpm run test:integration`                                | 0         | `Test Files 4 passed (4)`, `Tests 20 passed (20)`, 68 s                                                      |
| `pnpm run stack:up`                                        | 0         | `stack mykey-dev is up`, PostgreSQL `127.0.0.1:54320`, OpenBao `https://127.0.0.1:8200`                      |
| `pnpm run stack:status`                                    | 0         | `openbao: running (healthy)`, `postgres: running (healthy)`                                                  |
| `pnpm run stack:up` a second time                          | 0         | `stack mykey-dev is up` (idempotent)                                                                         |
| `pnpm run stack:down`, then `stack:status`                 | 0, then 1 | `stack mykey-dev removed`; `stack mykey-dev is not running`                                                  |
| `pnpm run check`                                           | 0         | `pins: ok`                                                                                                   |

What the integration tests prove: PostgreSQL reports major 18; a TLS 1.3 connection verified against the CA succeeds; a different CA is rejected; a connection without TLS is refused with SQLSTATE 28000; `freshDatabase` creates and removes a database; OpenBao is initialised, unsealed, on Raft with a static seal; a namespace gets a KV v2 mount with `cas_required` and `max_versions 20`, a write with `cas 0` returns version 1 and reads back, the same path in a second namespace and in the root namespace is 404; a write without `cas` and a write with a stale `cas` are both rejected; a dropped namespace is gone; a request without a token is denied; plain HTTP never reaches the API; two stacks run at once on different ports with different root tokens; after `restartService(stack, "openbao")` the server is unsealed and the data is still there; `stop()` leaves no container, volume, network or state directory; the key owners in the Compose file match the users the pinned images run as.

## Measurements

`docker stats --no-stream` on `mykey-dev`, idle, about 20 seconds after start:

| Service         | Memory   |
| --------------- | -------- |
| PostgreSQL 18.6 | 37.5 MiB |
| OpenBao 2.7.2   | 22.1 MiB |

Both are far below the allowances in the Run 1.3 sizing estimate (2.0 GB and 0.5 GB), which were set for load, not idle. The estimate stands: 4 vCPU / 8 GB / 80 GB.

## Deviations and decisions

- **A new KV v2 mount is briefly unavailable.** Straight after `POST /v1/sys/mounts/kv`, `POST /v1/kv/config` returned HTTP 400 "Upgrading from non-versioned to versioned data. This backend will be unavailable for a brief period". The harness gained `mountKvV2`, which waits until `GET /v1/<mount>/config` returns 200. Organization provisioning in Run 3.8 needs the same read-back.
- **Key owners are passed to `pki-init` as `uid:gid`** read from the pinned images with `id` (`postgres` 999:999, `openbao` 100:1000) and re-checked by an integration test, so an image update that changes them fails a test instead of breaking start-up.
- **The OpenBao health check is `bao status`** over verified TLS (exit 1 = unreachable) instead of the HTTP health URL in the plan: the image's BusyBox `wget` cannot verify a private CA. The harness itself waits on `GET /v1/sys/health` over TLS.
- **`baoFetch` uses `node:https`** with the CA file and returns a standard `Response`; Node's global `fetch` has no per-request CA option without an extra dependency.
- **PostgreSQL accepts TLS 1.3 only** (`ssl_min_protocol_version`), stricter than the plan asks.
- The shared stack is announced to test workers through the environment variable `MYKEY_SHARED_STACK` (project name only; credentials stay in `.stack/<project>/stack.json`).
- `pg` and `@types/pg` are development dependencies of the root and of `@mykey/tests` through the catalog.

## Open issues

- None for this run. CI result for the `integration` job is recorded in the session report.
