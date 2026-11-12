# KMS and unseal (staging; production copies it)

OpenBao on a MyKey host unseals itself from **OVHcloud KMS** (OKMS, KMIP) with the built-in `seal "kmip"` of OpenBao 2.7.2. Nobody types an unseal key, ever. Decision record: D-23. Evidence: `docs/evidence/session-2/run-2.7.md`, `unseal-staging.txt`, `key-loss-staging.txt`.

## How it works

- **The seal key** `mykey-staging-seal-1` (AES-256, `Extractable: false`, `Never Extractable`, `Sensitive`) lives in the KMS domain `mykey-staging-kms` (id `9d3293d1-7e93-4bb0-ac60-85adc6e1c1cf`, region `us-east-vin`). It never leaves the KMS. Key id: `5ec11f05-091a-460b-a7e6-f1064a6ece0e` (in `host.env` as `MYKEY_KMS_SEAL_KEY_ID`).
- **The access certificate** that lets OpenBao use the key: its private key was made **on the host** (`host.ts staging kms-csr <name>`) and never left it; the owner issued the certificate in the console from the CSR, for the IAM user `mykey-staging-seal` only. Files: `/etc/mykey/secrets/kms/<name>.{key,crt}`, owner OpenBao's uid 100:1000. OpenBao's configuration names `seal.crt`/`seal.key`, two links that `host.ts staging kms-use <name>` points at one certificate.
- **The endpoint** `us-east-vin.okms.ovh.us:5696` has a public certificate, checked against the image's system roots (no `ca_cert`). Only the `mk-kms` bridge reaches it (firewall set `kms`, port 5696); the host itself may too (operator tool `okms`).
- **IAM rights** (policy `mykey-staging-kms-seal`): `okms:kmip:encrypt`, `decrypt`, `locate`, `get`, `getAttributes` — and, until sitting 2 of Run 2.7, `create` and `activate`.
- **Init** (`host.ts staging bao-init`, once): one recovery share. The answer (root token, recovery key) went straight into `/root/mykey-custody/openbao-init.json` on the host and, unseen, to `~/.mykey/custody/staging/openbao-init.json`. The recovery key authorises some operations; **it cannot decrypt anything** and cannot unseal.

## What each state looks like

| Situation                          | `host.ts staging status`                                  | public `/health`                                        | probe                               |
| ---------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------- |
| Normal                             | `sealed: false`, `sealType: "kmip"`, `kmsReachable: true` | 200                                                     | nothing open                        |
| OpenBao stopped or not answering   | `sealed: null`                                            | 503 `down`                                              | `health_failing` after the grace    |
| KMS unreachable while OpenBao runs | `sealed: false`, `kmsReachable: false`                    | 200 (it still serves: the key is only needed to unseal) | `kms_unreachable`                   |
| KMS unreachable at start           | `sealed: true` or `null`, `kmsReachable: false`           | 503                                                     | `openbao_sealed` / `health_failing` |

At start without the KMS, OpenBao waits on the KMIP connection (about 130 s when the traffic is dropped), exits, and Docker's restart policy starts it again; it unseals by itself as soon as the KMS answers. Measured on staging: container restart 1.0–1.2 s to unsealed; cold start (container removed, volume kept) 1.0–1.1 s; host reboot 36 s from the reboot command to public `/health` 200.

## Operator commands (staging)

```sh
node scripts/host.ts staging status                         # sealed, sealType, kmsReachable
node scripts/host.ts staging kms staging-seal-1 -- kmip locate --details
node scripts/host.ts staging kms staging-seal-1 -- kmip attributes get <key id>
```

`okms` (OVHcloud's CLI, release 0.6.0, pinned by SHA-256 in `infra/dependencies.lock.json`) runs on the host through `infra/hosts/kms/okms.sh`, as uid 100, with one named certificate; it prints identifiers and states only.

## Replace a certificate (the certificate is lost, leaked or about to expire)

Certificates from the console are valid for **30 days** (the only choice offered on 12 Nov 2026). **`staging-seal-1` expires on 12 Dec 2026, 09:16 UTC**; OpenBao keeps running after that but cannot unseal again. Replace it at least a week before.

1. `node scripts/host.ts staging kms-csr staging-seal-<n>` — a new key on the host; prints the CSR only.
2. Owner, console: `mykey-staging-kms` → Access certificates → Generate, **provide the CSR**, identity `mykey-staging-seal` only (never root), download; save as `~/.mykey/kms/staging-seal-<n>.crt`.
3. `node scripts/host.ts staging kms-cert staging-seal-<n> ~/.mykey/kms/staging-seal-<n>.crt` — installs it beside its key, only if the two match.
4. `node scripts/host.ts staging kms-use staging-seal-<n>`, then restart OpenBao (`docker restart mykey-openbao-1` on the host) and check `status`: unsealed.
5. Owner deletes the old certificate in the console; on the host `shred -u` the old key (`kms-remove <old name>` refuses while the seal links point at it).

Nothing of the old certificate or key is needed to make the new one work (proven in Run 2.7 Step 6).

## Rotate the seal key

A new key id in the same domain: create and activate it (`kms … kmip create symmetric …`, `kmip activate`), then OpenBao's seal migration to the new key id. **The old key must stay active** until OpenBao has re-wrapped its root key and a backup pair under the new key exists; destroying the old key first loses everything sealed with it. Not exercised in Stage 1.

## What is lost when

| Lost                                               | Consequence                                                         | Way back                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A certificate or its key                           | Unseal fails at the next start                                      | Issue a new certificate (above); the data is safe                                                          |
| The root token                                     | Operator access                                                     | Generate a new root token with the recovery key (`sys/generate-root`)                                      |
| The recovery key                                   | Some operations need a quorum that no longer exists                 | None needed for unseal; keep it in custody (OWN-4)                                                         |
| **The seal key** (destroyed or revoked in the KMS) | **Everything sealed with it, and every backup pair taken under it** | **None.** Proven: no restart, no other key, no recovery key and no snapshot brings the data back (KMS-L1). |

## Owed later

- Run 6.4: an alert 30 days and 7 days before a seal certificate expires.
- Production: the same layout with its own KMS domain, user, policy and certificate at its first OpenBao start.
- Checkpoint `kms-cert-expiry` (`docs/evidence/session-2/kms-checkpoints.json`): from 12 Dec 2026, 09:57 UTC, prove that an expired certificate cannot unseal.
