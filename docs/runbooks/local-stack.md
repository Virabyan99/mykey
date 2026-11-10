# Local development stack

Real PostgreSQL 18 and real OpenBao in Docker, with TLS on both, for development and for every integration test. One definition (`infra/compose/dev.compose.yml`) is used on the workstation and in CI.

Everything in this stack is synthetic and development-only. The seal is a static key file; real KMS unseal exists only on staging (Run 2.7).

## Commands

| Command                            | What it does                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run stack:up`                | Starts project `mykey-dev` on fixed ports: PostgreSQL `127.0.0.1:54320`, OpenBao `https://127.0.0.1:8200`. Safe to run again while it is up. |
| `pnpm run stack:status`            | Prints each service's state and health; exits 0 only when both are running and healthy.                                                      |
| `pnpm run stack:down`              | Stops `mykey-dev` and deletes its volumes and its state directory. All data is gone.                                                         |
| `node scripts/stack.ts down --all` | Removes `mykey-dev` and every test stack `mykey-t-*`, including leftovers of a crashed test run.                                             |
| `pnpm run test:integration`        | Starts its own stack on free ports, runs the integration tests, removes the stack. It does not touch `mykey-dev`.                            |

## What runs

| Service    | Image                                   | Notes                                                                                                                                                                                                                            |
| ---------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pki-init` | pinned PostgreSQL image (has `openssl`) | One-shot. Writes a development CA, one server certificate each for `postgres` and `openbao` (names: the service name, `localhost`, `127.0.0.1`) and a 32-byte static seal key into the `pki` volume. Does nothing if they exist. |
| `postgres` | `postgres` 18.6 by digest               | TLS 1.3 only. `pg_hba.conf` has `hostssl … scram-sha-256` lines and no plain `host` line, so a client without TLS is refused. Superuser password comes from a Compose secret file.                                               |
| `openbao`  | `openbao/openbao` 2.7.2 by digest       | Raft storage, TLS listener, `seal "static"`. The harness initialises it once (one recovery share) and it unseals itself on every restart.                                                                                        |

## Where state lives

| Thing                                                  | Place                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Database files, Raft data, certificates, seal key      | Docker volumes `<project>_pgdata`, `<project>_baodata`, `<project>_pki` |
| Ports, CA path, superuser password, OpenBao root token | `.stack/<project>/stack.json` (git-ignored)                             |
| CA certificate for clients                             | `.stack/<project>/ca.crt`                                               |
| Superuser password given to the container              | `.stack/<project>/pg-superuser-password`                                |

These are development-only values. They still never go into logs, evidence files or chat.

## Connecting by hand

- PostgreSQL: host `127.0.0.1`, port 54320, user `postgres`, database `postgres`, `sslmode=verify-full`, `sslrootcert=.stack/mykey-dev/ca.crt`; the password is in `stack.json`.
- OpenBao: `https://127.0.0.1:8200` with `.stack/mykey-dev/ca.crt` as the CA; the root token is in `stack.json`. Namespaces are addressed with the `X-Vault-Namespace` header.

## In tests

`tests/harness/stack.ts` is the only way tests reach the stack:

- `getSharedStack()` — the stack started for this test run.
- `freshDatabase(stack)` / `freshNamespace(stack)` — an isolated database or OpenBao namespace; call `drop()` when done.
- `mountKvV2(stack, namespace)` — mounts KV v2 and waits until it serves (see below).
- `baoFetch(stack, path, init)` — one HTTPS request with CA verification.
- `startStack()` / `stack.stop()` — a private stack, for tests that restart or break a service.
- `restartService(stack, service)` — restarts and waits; host ports can change and `stack` is updated.

## Things that will surprise you

- **A new KV v2 mount answers HTTP 400 for a moment** ("Upgrading from non-versioned to versioned data"). Configure or write only after `GET /v1/<mount>/config` returns 200. Provisioning code (Run 3.8) must do the same read-back.
- **Host ports of a test stack change when a service restarts**, because they are assigned by Docker. Use the values on the `Stack` object after `restartService`.
- **Windows:** the Compose file bind-mounts three configuration files and one shell script from `infra/compose/dev/`. They must have LF line endings; `.gitattributes` guarantees that on checkout.

## Reset

`pnpm run stack:down && pnpm run stack:up` gives a brand-new, empty stack with new certificates, a new seal key and a new root token.
