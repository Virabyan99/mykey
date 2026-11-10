# D-16 — R2 token model

**Date:** 2026-11-10

**Status:** DECIDED by the session planner, recorded by the executing agent in Run 1.9. **Buckets and lock rules exist; no token has been created yet** (see `docs/evidence/session-1/run-1.9.md`).

## Decision

One Cloudflare account, four buckets, eight tokens. No token can both write objects and change a lock rule, and no token reaches more than one bucket's objects.

| Token name                    | Permission group                     | Scope                                         | Used by                               |
| ----------------------------- | ------------------------------------ | --------------------------------------------- | ------------------------------------- |
| `mykey-r2-admin`              | Workers R2 Storage Write             | account (bucket configuration and lock rules) | the agent, by hand, never by a server |
| `mykey-prod-pairs-upload`     | Workers R2 Storage Bucket Item Write | `mykey-prod-pairs`                            | production backup upload              |
| `mykey-prod-pairs-cleanup`    | Workers R2 Storage Bucket Item Write | `mykey-prod-pairs`                            | production retention clean-up         |
| `mykey-staging-pairs-upload`  | Workers R2 Storage Bucket Item Write | `mykey-staging-pairs`                         | staging backup upload                 |
| `mykey-staging-pairs-cleanup` | Workers R2 Storage Bucket Item Write | `mykey-staging-pairs`                         | staging retention clean-up            |
| `mykey-audit-archive-upload`  | Workers R2 Storage Bucket Item Write | `mykey-audit-archive`                         | audit archive export                  |
| `mykey-fixture-upload`        | Workers R2 Storage Bucket Item Write | `mykey-retention-fixture`                     | retention fixture and cloud tests     |
| `mykey-fixture-cleanup`       | Workers R2 Storage Bucket Item Write | `mykey-retention-fixture`                     | retention fixture and cloud tests     |

- Bucket resources are written as `com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_default_<BUCKET>`.
- S3 credentials are derived as Cloudflare documents: access key ID = token `id`; secret access key = SHA-256 hex of the token `value`.
- Each token's S3 credentials live in `~/.mykey/secrets/r2/<token name>.json` as `{accountId, accessKeyId, secretAccessKey}`, outside the repository and outside OneDrive. The custody list names them without values.
- Upload and clean-up are separate tokens with the same rights today. R2 has no "write but not delete" object permission, so the protection against deletion is the bucket lock rule, which neither token can change. The split exists so that either can be rolled or revoked alone and so that logs tell the two jobs apart.

## Lock rules

| Bucket                    | Rule                | Prefix   | Age                   |
| ------------------------- | ------------------- | -------- | --------------------- |
| `mykey-prod-pairs`        | `pairs-30d`         | `pairs/` | 2,592,000 s (30 days) |
| `mykey-retention-fixture` | `fixture-pairs-4d`  | `pairs/` | 345,600 s (4 days)    |
| `mykey-retention-fixture` | `fixture-probe-10m` | `probe/` | 600 s                 |

`mykey-staging-pairs` and `mykey-audit-archive` have no rule yet; Runs 6.5 and 6.2 own them.

## Open point

The plan's credential file holds only S3 credentials. Reading or setting a lock rule goes through the Cloudflare REST API, which needs the token value itself. For `mykey-r2-admin` the file therefore needs an extra `apiToken` field, or lock rules are read with the bootstrap token. This is decided when the tokens are created, and recorded here.

## What would change this decision

- Cloudflare adds an object permission that can write but not delete: the upload tokens move to it.
- A second account or jurisdiction is introduced: the resource names change and every token is re-created.
