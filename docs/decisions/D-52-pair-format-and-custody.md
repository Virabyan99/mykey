# D-52 — The pair: format, verification, signature and custody

**Date:** 2026-11-17

**Status:** DECIDED in Run 6.5 (P-119, P-120; Doc 06 §13; D-25; FR-1.66; AC-1.27). Evidence:

- `docs/evidence/session-6/run-6.5.md`;
- `tests/unit/backup/{manifest,sign,steps}.test.ts`, `tests/integration/capture/pair.test.ts`;
- `tests/restore/retention/cleanup.cloud.test.ts`, `tests/staging/backup.staging.test.ts`.

It replaces the spike of Run 2.9 (`infra/backup/pair-spike/`, deleted in Run 6.5).

## Decision

### What a pair is

Three artifacts taken while writing is closed (D-51), format `mykey-pair/1`:

| Artifact        | How                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------ |
| `postgres.dump` | `pg_dump -Fc` as `backup_reader`, over the database bridge, in the pinned PostgreSQL image |
| `globals.sql`   | `pg_dumpall --globals-only --no-role-passwords` on the server's own socket                 |
| `openbao.snap`  | the Raft snapshot, with a 600 s token of the root AppRole `backup`                         |

The manifest names each artifact with its size and SHA-256, and the boundary (nothing executing, no slot held). It also names the host, its instance, OpenBao's cluster id, the latest migration, the API's build and the tool versions. It refers to keys by name only: the KMS key id, the seal type, the backup password as `<host>/<n>`, the signing key id. A field that looks like a secret is refused by the schema.

### One repository per pair, one object

The artifacts go into a Restic repository of their own, encrypted with the host's backup password, in a 1 GiB tmpfs. It is packed as `bundle.tar`. A pair is deleted as one object; a shared repository could not be (Doc 10 §8.1).

Objects: `pairs/<host>/<captureUtc>-<pairId>/bundle.tar`, then `…/eligible.json`. The bucket keeps every object under `pairs/` for 30 days (lock rule `pairs-30d`).

### Eligible only when verified and signed

After the upload the job reads the bundle back and runs `restic check --read-data` on that copy. It restores the copy and compares the three digests with the manifest.

Then, with the pair's row locked:

- **More than two hours after the capture:** `ineligible` (`deadline`).
- **An access reduction inside the capture window** (`backup_invalidation`, D-51): `ineligible` (`access_reduction`). The job ends successfully: this is the barrier working.
- **Otherwise:** `eligible.json` = `{ manifest, verification, eligibleUntil = capture + 30 days, signature }` is written, and the pair becomes `eligible` in the same transaction. A failed write leaves a candidate.

The signature is Ed25519 over the canonical JSON (keys sorted, no whitespace, no value JSON cannot carry exactly). **A pair without `eligible.json` does not exist for a restore.**

### Keys and custody

`host.ts <host> backup-init` makes the backup password and the signing key **on the host** (owner 1000, mode 0400) and never replaces them. It writes the public key to `infra/hosts/backup/trust/<host>-<keyId>.pub`; this committed file is the trust anchor, independent of the bucket it checks. It also gives the root AppRole `backup` (policy `backup`, 600 s tokens) one secret id without expiry, for `backup.sh` as root.

`host.ts <host> backup-custody` copies the password and the signing key unseen to `~/.mykey/custody/<host>/backup/`. The owner keeps an offline copy (OWN-4).

A restore needs what R2 does not hold:

- the backup password;
- the trust anchor;
- OpenBao's recovery keys;
- access to the KMS key;
- an R2 read token.

A new key or password is a new id (`k2`, `<host>/2`). Old pairs keep naming the one they were made with.

### Who touches what

`backup.sh` (root, run by `mykey-backup.service` at 03:00 UTC) does the host steps. Each step is a container that mounts at most the one artifact it writes; Restic runs with no network. Only the ops container reaches R2, through its jobs `capture` and `pair`, as `maintenance`.

`backup.sh recover` (at boot, and after every run) releases a freeze a dead capture left and removes any pair tmpfs.

## Alternatives rejected

- **One Restic repository for all pairs.** Retention would need `forget`/`prune` against a locked bucket, and a pair could not be deleted as one object.
- **Trusting the upload's answer.** R2 answers for what it received. Only a read-back of the stored bytes proves what a restore will get.
- **A signing key in the bucket or beside the bundle.** A trust anchor must not come from the place it vouches for.
- **Per-capture AppRole secret ids (the spike's 60 s).** They would put a credential-minting root token on the host at every capture. One secret id, installed once and bound to a 600 s token with the `backup` policy only, is the smaller exposure.
