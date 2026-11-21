# Session 8 — requests to the owner

Written at the session start (20 Nov 2026). No value appears in this file. One answer is asked now; four moments are announced.

## 1. Now: may production be changed in this session?

**Answered: yes** (the owner, 20 Nov 2026, at the session start).

With "yes", production gets its corrected host files, its own KMS domain, user, policy, key and certificate, OpenBao initialised and unsealed by that key, its custody set, its backup material and timers, and the release candidate deployed with `--stay-closed`. It gets no account, no organization and no data, and it stays `inService: false` in the probe (plan P-146, decision record D-64). With "no", production is not touched, scope valve 1 is taken, and Gate R says so above the signature line.

## 2. Today or tomorrow morning: the KMS console for production (about 20 minutes, twice)

A domain, a user, a policy, and a certificate from a request the agent prints; later, two rights (`create`, `activate`) removed from the policy. The agent sends the exact steps of `kms-and-unseal.md` when the operator tool can do production's part (Run 8.0 Task B). Afterwards: production's custody files (`~/.mykey/custody/prod/`) copied into the password manager, as OWN-4 was for staging.

### Sitting 1, asked on 20 Nov 2026 (after Run 8.0 Task B)

The agent pushed production's host files, installed the pinned `okms` and made the seal certificate's key on the host (`kms-csr prod-seal-1`); the request is `C:\Users\gmpar\.mykey\kms\prod-seal-1.csr` (public, no key). In the OVHcloud US Control Panel, region `us-east-vin`:

1. Key Management Service → order one OKMS domain `mykey-prod-kms`.
2. IAM → a local user `mykey-prod-seal` (no console password).
3. IAM → a policy `mykey-prod-kms-seal`: identity `mykey-prod-seal`, the domain `mykey-prod-kms`, actions `okms:kmip:encrypt`, `decrypt`, `locate`, `get`, `getAttributes`, `create`, `activate`.
4. `mykey-prod-kms` → Access certificates → Generate → provide the CSR `prod-seal-1.csr`, identity `mykey-prod-seal` only (never root); download and save as `C:\Users\gmpar\.mykey\kms\prod-seal-1.crt`.
5. Reply "prod KMS done" with the domain id.

Sitting 2 (later the same day): remove `create` and `activate` from `mykey-prod-kms-seal`, after the agent says the seal key exists.

**Sitting 1 answered:** "prod KMS done" (the owner, 21 Nov 2026), domain `edafd078-…`; the certificate matched the CSR.

### Sitting 2, asked on 21 Nov 2026 (the seal key `mykey-prod-seal-1` is active)

1. IAM → policy `mykey-prod-kms-seal` → remove `okms:kmip:create` and `okms:kmip:activate`, leaving five actions.
2. Copy `~/.mykey/custody/prod/` (the init answer and the backup folder) into the password manager.
3. Reply "prod sitting 2 done".

**Answered:** "prod sitting 2 done" (the owner, 21 Nov 2026). Checked: `kmip create` is refused ("Operation is not authorized"), and OpenBao unseals itself after a restart with the five rights left.

## 3. After the freeze: one hour (OWN-6)

The first-run walk of Run 8.8 on staging, with an authenticator application and WSL at hand. The agent says when staging is ready and runs nothing on staging during that hour.

## 4. At the end (OWN-7)

Read `docs/evidence/session-8/gate-r.md`, answer "approved" or not, and say "merge".

**Asked:** 21 Nov 2026, with the manifest built (144 PASS, 9 NOT PROVEN, 7 NOT YET DUE). The answer goes here and into D-67, with its date.

## 5. Only if the agent says so

The repository secret `PROBE_READ_TOKEN`, needed again only when `probe.ts secrets` has to run.

## Also

GitGuardian's false positive (incident 39994924) may be dismissed by the owner at any time; nothing depends on it.
