# Deploy

How a release reaches a host: built once, promoted through the closed gate. Decision D-57; the gate is D-54 (`service-gate.md`). Written in Run 6.9.

## Build

On a clean clone outside OneDrive (one heavy job at a time; about 15 minutes):

```sh
git clone https://github.com/Virabyan99/mykey.git ~/mykey-release/src
cd ~/mykey-release/src && git checkout <commit> && corepack enable && pnpm install --frozen-lockfile
node infra/release/build.ts --version 0.6.0 --out ~/mykey-release/host-v0.6.0
```

It refuses a dirty tree, a commit origin does not hold, an image holding `npm`, `npx` or `corepack`, and a failing scan. The output directory holds `api.tar`, `provisioner.tar`, `ops.tar`, `release.json` and `SHA256SUMS`. Publish it:

```sh
gh release create host-v0.6.0 ~/mykey-release/host-v0.6.0/* --title "host-v0.6.0" --notes "<commit>"
```

A release is never changed: a fix is a new version.

## Deploy

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts staging deploy --release ~/mykey-release/host-v0.6.0
```

It prints the plan, then each step with its time (`D-57`). The gate is closed from `gate_close` to `gate_open`: the public name answers `quarantined` and `/health` is down, and the probe may alert during the window. Write the window in `docs/evidence/session-6/staging-windows.md` first.

**What the journey checks.** Through the verification listener (`tunnel verify`), with the owner's workstation credentials (`~/.mykey/secrets/hosts/<host>/owner-*`):

- the owner signs in with password and TOTP;
- one secret is revealed and its digest compared with the last deploy's (`deploy-journey.json`; the first deploy records it);
- a write must answer `quarantined`;
- the owner signs out.

The report (`deploy-report.json` beside it) must have every check `ok`, or the deploy stops before `gate_open`.

**When it stops.** The gate stays closed. Read the step it printed last, fix the cause, then:

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts staging deploy --release <same dir> --resume
```

`--resume` refuses a stopped deploy of another release; deploying a different release starts from step 1.

## A failed migration

A migration runs in one transaction with its history row: a failing one leaves nothing behind (no table, `meta.schema_migration` unchanged) and the deploy stops closed. Deploy the previous release again (`--release <previous dir>`, without `--resume`). It runs every step, journey and report included, and opens. The broken release is then fixed as a new version.

## Rollback

A deploy of the previous release (`--release <previous dir>`). The plan refuses a release whose last migration is older than the host's, so the previous release must already know today's schema.

**Across the gate's format change.** `45b5c1f3cc3a` (production and staging before Session 6) reads only a v1 record. Its API works on a database at `0018` (`tests/integration/deploy/previous-release.test.ts`). To go back to it:

1. Deploy its images with that commit's own `host.ts` (`image`, `up`).
2. Write a v1 record with that commit's `host.ts <host> gate open`, after removing `MYKEY_BACKEND_INCARNATION` from `host.env` (its `gate` refuses otherwise).

This is rehearsed locally only.

## Converting a host to gate v2 (once per host)

The first deploy of a v2 release converts a host whose `host.env` has no incarnation:

- `gate_close` writes a v1 closed record;
- `migrate` runs `db-init`, which writes the incarnation into the database and `host.env`;
- the copy goes into OpenBao where none is, and the record is rewritten v2 closed + `verifying`;
- then the deploy goes on as usual.

On a host with OpenBao, re-run `host.ts <host> ops provision-organization --organization <id>` after the deploy, so the organization's policies and its namespace's incarnation copy are current.

**A release that changes a planned OpenBao object** (a policy, a role) leaves each organization's live object as it was: `provision-organization` then answers `review: <step> differs from the plan; nothing was overwritten`, and the sweep does the same. Reconcile as `provisioning.md` says: `ops verify-organization` names the object; compare the live one with the plan; write the planned one with the root token; run `provision-organization` again (→ `active`, `verify-organization` → `equal`). The run rotates every secret id. Releases from `host-v0.6.1` on read the new ones on their next call. With `host-v0.6.0` or older, the API keeps the destroyed runtime id, `/health` fails with `openbao_audit`, and after a few minutes OpenBao locks the runtime role id out for about 15 minutes. Staging met this in Run 6.9: Run 6.9's first deploy changed the provisioner policy (Run 6.7's read of `mykey-meta/data/incarnation`).

## Production

Production has no OpenBao and no owner yet: `deploy --release <dir> --stay-closed` loads, migrates and starts, and leaves the gate closed. Every production deploy needs the owner's yes, asked before the command runs.
