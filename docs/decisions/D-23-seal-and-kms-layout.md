# D-23 — Seal and KMS layout

**Date:** 2026-11-12

**Status:** DECIDED by the executing agent in Run 2.7, with the owner's console sittings (OWN-3). Custody confirmation (OWN-4): **received** — the owner replied "custody confirmed" on 12 Nov 2026 (init answer and SSH key in the password manager). Evidence: `tests/staging/{unseal,key-loss}.staging.test.ts`, `docs/evidence/session-2/{unseal-staging,key-loss-staging}.txt`, `kms-checkpoints.json`, `run-2.7.md`. Runbooks: `kms-and-unseal.md`, `custody-map.md`.

## Decision

- **OpenBao's built-in `seal "kmip"` against OVHcloud KMS (OKMS).** OpenBao 2.7.2 unsealed from OKMS at the first attempt; the Doc 10 §8.1 fallback (the OVHcloud seal plugin) was not needed. Endpoint `us-east-vin.okms.ovh.us:5696` — the hosts are in OpenStack region `os-us-east-va-2`, served by the US control panel and the `.ovh.us` KMS names, not the `.ovh.net` name the plan assumed (R60). The endpoint's public certificate is verified against the image's system roots; no `ca_cert`.
- **Two KMS domains**, each with one IAM user and one policy, never the root identity:

  | Domain               | Id                                     | IAM user             | Policy and actions                                                                                                                                                               |
  | -------------------- | -------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `mykey-staging-kms`  | `9d3293d1-7e93-4bb0-ac60-85adc6e1c1cf` | `mykey-staging-seal` | `mykey-staging-kms-seal`: `okms:kmip:encrypt`, `decrypt`, `locate`, `get`, `getAttributes` (`create` and `activate` removed after the key existed; `kmip create` is now refused) |
  | `mykey-losstest-kms` | `c830ef05-deb3-4edb-a484-11144053d1a6` | `mykey-losstest-ops` | `mykey-losstest-kms-all`: `okms:kmip:*`                                                                                                                                          |

- **The seal key** `mykey-staging-seal-1` = `5ec11f05-091a-460b-a7e6-f1064a6ece0e`: AES-256, usage Encrypt|Decrypt, `Extractable false`, `Never Extractable`, `Sensitive`, Active since 12 Nov 2026 09:34:26 UTC.
- **Certificates from CSRs**, EC P-256 (accepted by the console). The seal certificate's key is generated **on the host** (`host.ts staging kms-csr`) and never leaves it; only the CSR is printed. Files in `/etc/mykey/secrets/kms/` (directory 0700 and keys 0400, owner OpenBao's uid 100:1000); OpenBao's configuration names `seal.crt`/`seal.key`, two relative links switched by `kms-use`. A certificate is installed only next to its own key (`kms-cert` compares the public keys).
- **Validity 30 days** — the only choice the console offered (R66). Current seal certificate `staging-seal-2` expires **12 Dec 2026, 10:50 UTC**; it must be replaced before then (runbook), and Run 6.4 owes the expiry alert.
- **Init (P-35)** with one recovery share, on the host; the answer goes to `/root/mykey-custody/openbao-init.json` and, unseen, to `~/.mykey/custody/staging/openbao-init.json`. The root namespace gets the audit headers and the policy `backup`.
- **Operator tool** `okms` 0.6.0 (OVHcloud, Apache-2.0): `ghcr.io/ovh/okms-cli` refuses anonymous pulls, so the release archive is pinned by SHA-256 (`infra/dependencies.lock.json`, section `binaries`) and run in the pinned restic image through `infra/hosts/kms/okms.sh`, on the host's network (R65: the KMS bridge exists only while OpenBao runs).
- **Health and status.** Public `/health` is `up` only when PostgreSQL answers and OpenBao's `sys/health` says 200. `status.sh` reports `sealed`, `sealType` and `kmsReachable` separately; the heartbeat carries them, and the probe tells `kms_unreachable` from `openbao_sealed`.
- **Production** copies this layout with its own domain, user, policy, key and certificate at its first OpenBao start; it holds none of it in Session 2 (`host.ts` refuses the KMS commands for `prod`).

## Measured on staging

| Drill                                       | Observed                                                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container restart                           | unsealed and secret readable after 1.0–1.2 s                                                                                                                                                                              |
| Cold start (container removed, volume kept) | 1.0–1.1 s                                                                                                                                                                                                                 |
| Host reboot                                 | SSH back after 27 s; public `/health` 200 after 36 s, no command on the host                                                                                                                                              |
| KMS dropped at start (240 s)                | sealed throughout, `/health` 503, recovery key refused; OpenBao waits on the KMIP connection (about 130 s), exits, restarts; unsealed 35 s after the block ended, with no command                                         |
| KMS dropped while running (300 s)           | reads and writes go on; `kmsReachable: false`, `sealed: false`; probe opened `kms_unreachable` after 255 s (not `openbao_sealed`), resolved after the block                                                               |
| Certificate deleted in the console          | restart on it: sealed throughout, `/health` 503, the refused handshake makes OpenBao exit at once (10 restarts in 60 s); switched to the reissued certificate: unsealed in 2.1 s, earlier secret intact; old key shredded |
| Seal key revoked and destroyed (losstest)   | **unrecoverable**: no restart, no other key, no recovery key (HTTP 400), no snapshot (plain restore 400; forced restore accepted, instance seals, secret unreadable) — KMS-L1                                             |

## Findings

- `host.ts image` recorded the first image of an archive that held two (`docker save` without a tag); staging ran an API without the OpenBao check, and `/health` said `up` with OpenBao stopped. Fixed: an archive must hold exactly one image.
- `status.sh` hung during a KMS outage (the check's `openssl`, as PID 1, ignored `timeout`'s signal), and with it the heartbeat; the probe would have seen `heartbeat_missing`. Fixed with `--init` and `timeout -k`.
- A losstest certificate (KMIP rights only) gets HTTP 200 with an empty list from the domain's REST key listing: listing seems allowed without REST rights, or filtered.
- All console certificates expire on 12 Dec 2026, within the same 95 minutes.

## Open

- Checkpoint `kms-cert-expiry` from 12 Dec 2026 09:57 UTC (needs a new losstest certificate `losstest-ops-2` by then).
- Seal-key rotation is described, not exercised.
- `PASS` for FR-1.64, FR-1.65, AC-1.26, PO-1 waits for the first production start.
