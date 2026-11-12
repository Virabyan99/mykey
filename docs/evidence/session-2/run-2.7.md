# Run 2.7 — Real KMS auto-unseal

**Result: DONE on 12 Nov 2026**, apart from the owner's custody confirmation (OWN-4, requested). Staging OpenBao unseals itself from OVHcloud KMS after a restart, a cold start and a host reboot; it stays sealed (and says so) without the KMS and recovers alone; a deleted certificate cannot unseal and a reissued one can; a destroyed seal key loses everything. Decision record: D-23. Runbooks: `kms-and-unseal.md`, `custody-map.md`, `credential-custody.md` (new rows).

FR-1.64 SPIKE_PASS — unattended unseal after restart, cold start and reboot; KMS outage at start keeps OpenBao sealed with `/health` 503 and no manual-key fallback; outage while running keeps it serving and raises `kms_unreachable` (`unseal.staging.test.ts`, `unseal-staging.txt`).
FR-1.65 SPIKE_PASS — certificate replaced without the old one: `staging-seal-1` deleted in the console cannot unseal, `staging-seal-2` (key made on the host) unseals, the old key shredded.
AC-1.26 SPIKE_PASS — revoked half proven; the expired half is the dated checkpoint `kms-cert-expiry` (from 12 Dec 2026 09:57 UTC, `kms-checkpoints.json`).
PO-1 SPIKE_PASS — the seal key never leaves the KMS (`Never Extractable`), the certificate key never leaves the host, no unseal key exists.
KMS-L1 SPIKE_PASS — seal key lost: UNRECOVERABLE, as Doc 04 says; a backup pair is only as recoverable as its seal key (`key-loss.staging.test.ts`, `key-loss-staging.txt`).

## What was done

- **Owner, sitting 1:** two OKMS domains in `us-east-vin`, two IAM users, two policies, three access certificates from CSRs. The two losstest certificates were first issued in the staging domain and reissued in the losstest domain (a REST probe per certificate found it).
- **Host tool** (`scripts/host.ts`): `kms-csr`, `kms-install`, `kms-cert`, `kms-use`, `kms-import`, `kms-remove`, `kms`, `env`, `bao-init`; `up` renders `openbao.hcl` from `host.env` and adds the Compose profile `openbao` only where `MYKEY_OPENBAO=1`. All KMS commands refuse `prod`.
- **Compose:** service `openbao` (profile), bridges `mk-bao` and `mk-kms`; `host-kms-spike.compose.yml` for disposable instances on `mk-kms` (R68).
- **Health and status:** `/health` checks OpenBao; `status.sh` reports `sealed`, `sealType`, `kmsReachable`.
- **Owner, sitting 2:** `create`/`activate` removed from the seal policy; `staging-seal-2` issued; `staging-seal-1` deleted at the test's signal.
- **Tests:** `tests/staging/unseal.staging.test.ts` (10), `tests/staging/key-loss.staging.test.ts` (2), `tests/staging/kms-expiry.staging.test.ts` (dated), unit tests for every host command and for `status.sh`.

## Commits

- 0a69826 feat(api): /health requires an unsealed OpenBao where one runs; host OpenBao configuration template
- 37a3613 feat(hosts): OpenBao service under a Compose profile, rendered from host.env; status reports seal and KMS
- d860390 feat(hosts): OpenBao on staging unseals from OVHcloud KMS after a restart and a cold start
- ebd0363 test(hosts): staging OpenBao unseals alone after a reboot and survives the KMS going away
- 7fba06b test(hosts): a lost seal key is unrecoverable (KMS-L1); dated certificate-expiry checkpoint
- 88a845f test(hosts): a deleted KMS certificate cannot unseal; a reissued one can (FR-1.65)
- this commit: docs(hosts): D-23 seal and KMS layout, Run 2.7 note

## Commands and results

| Command                                                                                                     | Exit | Proof line                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run --project staging tests/staging/unseal.staging.test.ts` before OpenBao                | 1    | `no …openbao-init.json: run node scripts/host.ts staging bao-init first` (RED)                                                                                        |
| `host.ts staging kms staging-seal-1 -- kmip create symmetric … --extractable=false --sensitive`, `activate` | 0    | `Key created with ID 5ec11f05-…`, `Activated object`, attributes `Never Extractable true`, `State Active`                                                             |
| `host.ts staging up`, `bao-init`                                                                            | 0    | `openbao.hcl rendered`, `custody copy at …`, `audit headers registered; root-namespace policy backup written`                                                         |
| unseal tests, first run                                                                                     | 0    | 5/5: `seal-status type=kmip`, restart 1179 ms, cold start 1116 ms                                                                                                     |
| unseal tests, full                                                                                          | 1    | reboot PASS (36 s); KMS drills failed on the recovery-key field name (`recovery_keys_base64`), fixed                                                                  |
| KMS drill rerun                                                                                             | 1    | `public 503 seen false`: staging ran an older API image (archive held two images) and `status.sh` hung on the dropped handshake — both fixed with failing tests first |
| KMS drills, rerun                                                                                           | 0    | 2/2: sealed throughout, 503, unsealed 35 s after the block; `kms_unreachable` after 255 s                                                                             |
| `key-loss.staging.test.ts`                                                                                  | 0    | 2/2: `KMS-L1 SPIKE_PASS …`; expiry instance prepared, checkpoint written                                                                                              |
| `-t "rights are what"`                                                                                      | 0    | `kmip create … Operation is not authorized`; locate works                                                                                                             |
| `-t "deleted certificate"`                                                                                  | 0    | sealed throughout, 503, 10 restarts; `staging-seal-2` unsealed in 2087 ms; `-1` key shredded                                                                          |
| `pnpm run check`                                                                                            | 0    | —                                                                                                                                                                     |

## Deviations and decisions

- **R60** endpoint `us-east-vin.okms.ovh.us`, not `.ovh.net`.
- **R62** production's Compose also has the empty OpenBao volumes and the internal `mk-bao` bridge, without the service.
- **R65** `okms` runs with the host's network, not on `mk-kms`.
- **R66** certificates are 30 days, the console's only choice; the 1-day expiry test became a dated checkpoint at the real expiry.
- **R67** the losstest keys were created in Step 7, where they are used.
- **R68/R69** disposable instances on `mk-kms` from `host-kms-spike.compose.yml` (pushed because its name starts with `host`).
- **R70** the losstest certificates and the expiry instance stay on staging until the checkpoint.
- The `okms-cli` container image is not pullable anonymously; the release archive is pinned instead.
- The registry is not edited in this run (ruling R6).

## Open issues

- **OWN-4** — the owner copies `~/.mykey/custody/staging/openbao-init.json` and the SSH key into the password manager and replies "custody confirmed".
- All certificates expire on 12 Dec 2026 (seal: 10:50 UTC); replace `staging-seal-2` before then; `losstest-ops-2` is needed for the checkpoint.
- The expiry alert (Run 6.4); production's own KMS layout at its first OpenBao start.

Verdict: GO
