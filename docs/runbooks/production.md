# Production

From a reinstalled server to "ready to open", the first opening, and every later deploy (Session 8, P-146, P-147, D-64). Commands hold placeholders only. **Every command that touches production needs the owner's yes, asked before it runs.**

Production shares nothing with staging (D-23): its own KMS domain, user, policy, seal key and certificate; its own root token and recovery key; its own backup password, signing key and R2 tokens.

## 1. From a reinstalled server to a closed host

After a reinstall the owner changes the expired `ubuntu` password in a terminal, and a changed host key is taken only right after a reinstall the owner has just confirmed. Then, in this order:

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts prod bootstrap        # then apply firewall|ssh + confirm; the owner restarts the tunnel (new WireGuard key)
MSYS_NO_PATHCONV=1 node scripts/host.ts prod push
MSYS_NO_PATHCONV=1 node scripts/host.ts prod up               # writes host.env
MSYS_NO_PATHCONV=1 node scripts/host.ts prod maint 10 -- docker pull -q <postgres image by digest>   # and traefik; compose pull fails while OpenBao is unset
MSYS_NO_PATHCONV=1 node scripts/host.ts prod up
MSYS_NO_PATHCONV=1 node scripts/host.ts prod db-init
MSYS_NO_PATHCONV=1 node scripts/host.ts prod deploy --release C:/Users/<you>/mykey-release/host-v<v> --stay-closed
MSYS_NO_PATHCONV=1 node scripts/host.ts prod keys init        # the API refuses to start without key rings
MSYS_NO_PATHCONV=1 node scripts/host.ts prod acme production  # then up again
node scripts/probe.ts secrets                                  # the owner then sets PROBE_READ_TOKEN again (probe.md)
```

The digests are those of `infra/dependencies.lock.json`.

## 2. The KMS and OpenBao

**Owner, console, sitting 1** (OVHcloud US Control Panel, region `us-east-vin`), as Run 2.7 did for staging:

1. Key Management Service → an OKMS domain `mykey-prod-kms`.
2. IAM → a local user `mykey-prod-seal` (no console password).
3. IAM → a policy `mykey-prod-kms-seal`: identity `mykey-prod-seal`, the domain `mykey-prod-kms`, actions `okms:kmip:encrypt`, `decrypt`, `locate`, `get`, `getAttributes`, `create`, `activate`.

**Agent:**

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts prod kms-install <okms-cli-linux-x86_64.tar.gz>   # checked against the lock
MSYS_NO_PATHCONV=1 node scripts/host.ts prod kms-csr prod-seal-1                         # the key stays on the host; prints the CSR
```

**Owner, console:** `mykey-prod-kms` → Access certificates → Generate, provide the CSR, identity `mykey-prod-seal` only (never root); download and save as `~/.mykey/kms/prod-seal-1.crt`.

**Agent:**

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts prod kms-cert prod-seal-1 C:/Users/<you>/.mykey/kms/prod-seal-1.crt
MSYS_NO_PATHCONV=1 node scripts/host.ts prod kms-use prod-seal-1
MSYS_NO_PATHCONV=1 node scripts/host.ts prod kms prod-seal-1 -- kmip create symmetric --alg AES --size 256 --usage encrypt,decrypt --name mykey-prod-seal-1 --extractable=false --sensitive
MSYS_NO_PATHCONV=1 node scripts/host.ts prod kms prod-seal-1 -- kmip activate <key id>
MSYS_NO_PATHCONV=1 node scripts/host.ts prod env MYKEY_KMS_HOST us-east-vin.okms.ovh.us
MSYS_NO_PATHCONV=1 node scripts/host.ts prod env MYKEY_KMS_SEAL_KEY_ID <key id>
MSYS_NO_PATHCONV=1 node scripts/host.ts prod env MYKEY_OPENBAO 1
```

**Owner, console, sitting 2:** remove `create` and `activate` from `mykey-prod-kms-seal`.

**Agent:**

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts prod maint 10 -- docker pull -q <openbao image by digest>
MSYS_NO_PATHCONV=1 node scripts/host.ts prod up               # renders openbao.hcl; OpenBao starts and is unsealed by the KMS
MSYS_NO_PATHCONV=1 node scripts/host.ts prod bao-init         # once; the custody copy lands in ~/.mykey/custody/prod/
MSYS_NO_PATHCONV=1 node scripts/host.ts prod ops-secrets
MSYS_NO_PATHCONV=1 node scripts/host.ts prod backup-init
MSYS_NO_PATHCONV=1 node scripts/host.ts prod backup-custody   # ~/.mykey/custody/prod/backup/
MSYS_NO_PATHCONV=1 node scripts/host.ts prod r2-install audit-archive    # and pairs, pairs-cleanup: production's own tokens, mykey-* buckets only
MSYS_NO_PATHCONV=1 node scripts/host.ts prod timers
MSYS_NO_PATHCONV=1 node scripts/host.ts prod status           # OpenBao unsealed, KMS reachable, gate closed
```

**Owner:** copy `~/.mykey/custody/prod/` (the init answer and the backup folder) into the password manager, as OWN-4 was for staging, and confirm. The certificate's end date (30 days from issue) goes into CLAUDE.md's dated items; it is replaced as `kms-and-unseal.md` says.

No `bootstrap-owner` and no `provision-organization` here: production holds no account, no organization and no data until the first opening. The probe keeps it `inService: false`.

## 3. The first opening (Run 9.1, after Gate R)

The gate is closed with phase `verifying` after a `--stay-closed` deploy, so the verification listener serves the running build.

1. **The owner's account.** In the owner's own terminal, with a password file the owner made (0600; never on a command line, never seen by the agent):

   ```sh
   MSYS_NO_PATHCONV=1 node scripts/host.ts prod ops bootstrap-owner --email <owner address> < <password file>
   ```

2. **Enrolment.** `node scripts/host.ts prod tunnel verify`; the owner opens the printed local address in their own browser, signs in, enrols their own authenticator and keeps the recovery codes (`operator-accounts.md`).
3. **The organization.** `MSYS_NO_PATHCONV=1 node scripts/host.ts prod ops provision-organization --organization <id>` (the id `bootstrap-owner` printed); `ops verify-organization` → `equal`.
4. **The owner's journey,** through `tunnel verify` again: sign in with password and code; there is no secret yet, so nothing is revealed; one write (a new project) must answer "The service is not open" (`quarantined`); sign out. The owner says "journey done".
5. **The opening:**

   ```sh
   MSYS_NO_PATHCONV=1 node scripts/host.ts prod deploy --release C:/Users/<you>/mykey-release/host-v<v> --owner-confirmed
   ```

   It deploys the build that already runs (no migration), records the three journey checks as `owner confirmed (--owner-confirmed)`, counts the secret index (no row: the reveal check is `ok`, `no secret in the index`), runs the store checks, writes the report and opens.

6. The probe gets `inService: true` (`probe.md`), and the first secrets are created by the owner.

## 4. A later deploy

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts prod deploy --release <new dir> --stay-closed     # loads, closes (verifying), migrates, starts
node scripts/host.ts prod tunnel verify                                                  # the owner's journey on the new build
MSYS_NO_PATHCONV=1 node scripts/host.ts prod deploy --release <new dir> --owner-confirmed # the report, then open
```

`--owner-confirmed` refuses a release that is not the running build: the owner's journey must be of the build that opens. A deploy of production without `--owner-confirmed`, `--stay-closed` or `--install-only` is refused before anything is touched: production never holds a workstation copy of the owner's password or authenticator.

## What the owner confirms

Through `tunnel verify`, on the build that runs, in their own browser:

- **sign-in:** the password and a current code from their authenticator work;
- **reveal:** one secret they know is revealed and is the value they expect (with no secret yet, nothing — the report counts the index);
- **refused write:** creating a project answers "The service is not open".

Then the owner says so in one line. The operator runs `--owner-confirmed` only after that line. The store checks (schema, OpenBao readable, the incarnation in three places, the control row idle) and the previous gate's state are measured by the deploy itself, and a failed one keeps the gate closed whatever the owner confirmed.

## A standalone `gate open --report`

It takes a deploy report only, not older than 30 minutes, of this host, incarnation and build, and runs the four store checks again right before it writes (`service-gate.md`). A restore report opens only through `restore-verify --open` (`restore.md`).
