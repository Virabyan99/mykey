# MyKey Private

A single-operator secrets service: OpenBao holds secret values, PostgreSQL holds accounts, permissions, operations and audit, and a thin CLI starts an application with a complete secret set and no `.env` file.

This repository is in Stage 1. The specification lives in `docs/doc_01` … `docs/doc_10`; the session plans are in `docs/plans/`.

## Prerequisites

- Node.js — the exact version in `.node-version`
- pnpm — the exact version in the `packageManager` field of `package.json` (`corepack enable` picks it up)
- Docker with Compose (for integration tests, from Run 1.5 on)

## The three commands

```sh
pnpm install --frozen-lockfile   # install exactly what the lock file says
pnpm run check                   # format check, lint, type check
pnpm test                        # unit tests
```

`pnpm run test:integration` runs the tests that need real PostgreSQL and OpenBao. A suite with no tests fails; a skipped test is not a pass.

## Layout

```text
apps/       api, provisioner, web, cli, ops
packages/   contracts, db, auth, openbao, operations, audit
workers/    probe
infra/      compose, hosts, traefik, openbao, backup, recovery, release
tests/      unit, integration, browser, cli, fault, restore
scripts/    repository scripts (TypeScript, run directly by node)
docs/       specification, plans, decisions, evidence, runbooks
```

Synthetic data only: no real secret, token or password belongs anywhere in this repository.
