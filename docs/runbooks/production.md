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
MSYS_NO_PATHCONV=1 node scripts/host.ts prod env MYKEY_KMS_HOST us-east-vin.okms.ovh.us   # before any `kms … --`: okms.sh reads it
MSYS_NO_PATHCONV=1 node scripts/host.ts prod maint 10 -- docker pull -q <restic image by digest>    # okms runs in the pinned restic image
MSYS_NO_PATHCONV=1 node scripts/host.ts prod maint 10 -- docker pull -q <openbao image by digest>
MSYS_NO_PATHCONV=1 node scripts/host.ts prod kms prod-seal-1 -- kmip locate --details   # the certificate works; the domain is empty
MSYS_NO_PATHCONV=1 node scripts/host.ts prod kms prod-seal-1 -- kmip create symmetric --alg AES --size 256 --usage encrypt,decrypt --name mykey-prod-seal-1 --extractable=false --sensitive
MSYS_NO_PATHCONV=1 node scripts/host.ts prod kms prod-seal-1 -- kmip activate <key id>
MSYS_NO_PATHCONV=1 node scripts/host.ts prod kms prod-seal-1 -- kmip attributes get <key id>   # Active, Never Extractable, Sensitive
MSYS_NO_PATHCONV=1 node scripts/host.ts prod env MYKEY_KMS_SEAL_KEY_ID <key id>
MSYS_NO_PATHCONV=1 node scripts/host.ts prod env MYKEY_OPENBAO 1
MSYS_NO_PATHCONV=1 node scripts/host.ts prod env MYKEY_BAO_URL https://openbao:8200       # without it `up` stops: the provisioner requires it
```

**Owner, console, sitting 2** (as soon as the key is active; nothing below needs the two rights): remove `create` and `activate` from `mykey-prod-kms-seal`.

**Agent:**

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts prod up               # renders openbao.hcl; OpenBao starts, waits for init, and is unsealed by the KMS after it
MSYS_NO_PATHCONV=1 node scripts/host.ts prod bao-init         # once; the custody copy lands in ~/.mykey/custody/prod/
MSYS_NO_PATHCONV=1 node scripts/host.ts prod ops-secrets
MSYS_NO_PATHCONV=1 node scripts/host.ts prod backup-init      # writes infra/hosts/backup/trust/prod-k<n>.pub: commit it, then push
MSYS_NO_PATHCONV=1 node scripts/host.ts prod backup-custody   # ~/.mykey/custody/prod/backup/
MSYS_NO_PATHCONV=1 node scripts/host.ts prod r2-install audit-archive    # and pairs, pairs-cleanup: the workstation's mykey-prod-pairs-* and the shared audit-archive token
MSYS_NO_PATHCONV=1 node scripts/host.ts prod timers           # sets MYKEY_BACKUP_EXPECTED=yes
# the first pair at once rather than at 03:00 (on the host, as root): systemctl start mykey-backup.service → "eligible <id>"
MSYS_NO_PATHCONV=1 node scripts/host.ts prod status           # OpenBao unsealed, KMS reachable, backup fresh, gate closed
node scripts/probe.ts state prod                              # `open` empty: checks_unknown closes with the first heartbeat that reads OpenBao
```

OpenBao's incarnation copy lives in each organization's namespace and is written by `provision-organization`: an empty production has only the two others (`app.service_control`, `host.env`), and that is complete.

**Owner:** copy `~/.mykey/custody/prod/` (the init answer and the backup folder) into the password manager, as OWN-4 was for staging, and confirm. The certificate's end date (30 days from issue) goes into CLAUDE.md's dated items; it is replaced as `kms-and-unseal.md` says.

**Done on 21 Nov 2026 (Run 8.1 Task A):** domain `mykey-prod-kms` (`edafd078-…`), seal key `mykey-prod-seal-1` (`eb5e0572-…`), certificate `prod-seal-1` until 21 Dec 2026, 07:48 UTC; the first pair eligible at 08:00 UTC; the probe with nothing open (`custody-map.md`, production).

No `bootstrap-owner` and no `provision-organization` here: production holds no account, no organization and no data until the first opening. The probe keeps it `inService: false`.

## 3. The first opening (Run 9.1, after Gate R)

The gate is closed with phase `verifying` after a `--stay-closed` deploy, so the verification listener serves the running build.

1. **The owner's account.** In the owner's own terminal, with a password file the owner made (0600; never on a command line, never seen by the agent):

   ```sh
   MSYS_NO_PATHCONV=1 node scripts/host.ts prod ops bootstrap-owner --email <owner address> < <password file>
   ```

2. **Enrolment.** `node scripts/host.ts prod tunnel verify --browser`. It opens a Chrome window of its own at production's own name, through the tunnel (see "The browser window" below). In that window the owner signs in, enrols their own authenticator and keeps the recovery codes (`operator-accounts.md`).
3. **The organization.** `MSYS_NO_PATHCONV=1 node scripts/host.ts prod ops provision-organization --organization <id>` (the id `bootstrap-owner` printed); `ops verify-organization` → `equal`.
4. **The owner's journey,** through `tunnel verify --browser` again: sign in with password and code; there is no secret yet, so nothing is revealed; one write (a new project) must answer "The service is not open" (`quarantined`); sign out. The owner says "journey done".
5. **The opening:**

   ```sh
   MSYS_NO_PATHCONV=1 node scripts/host.ts prod deploy --release C:/Users/<you>/mykey-release/host-v<v> --owner-confirmed
   ```

   It deploys the build that already runs (no migration), records the three journey checks as `owner confirmed (--owner-confirmed)`, counts the secret index (no row: the reveal check is `ok`, `no secret in the index`), runs the store checks, writes the report and opens.

6. The probe gets `inService: true` (`probe.md`), and the first secrets are created by the owner.

## 4. A later deploy

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts prod deploy --release <new dir> --stay-closed     # loads, closes (verifying), migrates, starts
node scripts/host.ts prod tunnel verify --browser                                        # the owner's journey on the new build
MSYS_NO_PATHCONV=1 node scripts/host.ts prod deploy --release <new dir> --owner-confirmed # the report, then open
```

`--owner-confirmed` refuses a release that is not the running build: the owner's journey must be of the build that opens. A deploy of production without `--owner-confirmed`, `--stay-closed` or `--install-only` is refused before anything is touched: production never holds a workstation copy of the owner's password or authenticator.

## The browser window

A browser pointed at the printed `https://127.0.0.1:<port>` cannot do the journey, as staging showed on 22 Nov 2026:

- the listener's certificate is from the host's own CA, so Chrome warns and may offer no way past;
- once past, sign-in is refused with "The request did not come from this site". The API accepts changes only from its own origin (`MYKEY_BASE_URL`), and 127.0.0.1 is not it.

`--browser` opens Chrome with a new, empty profile. That window:

- sends the host's own name on port 443 to the tunnel;
- trusts only the listener's key, read through the tunnel.

The page therefore has the product's real address. There is no warning, and sign-in is accepted. A yellow bar about an unsupported command-line flag is expected. The window's profile is a temporary directory. Close the window after the journey; Ctrl-C ends the tunnel.

## What the owner confirms

Through `tunnel verify --browser`, on the build that runs, in the window it opens:

- **sign-in:** the password and a current code from their authenticator work;
- **reveal:** one secret they know is revealed and is the value they expect (with no secret yet, nothing — the report counts the index);
- **refused write:** creating a project answers "The service is not open".

Then the owner says so in one line. The operator runs `--owner-confirmed` only after that line. The store checks (schema, OpenBao readable, the incarnation in three places, the control row idle) and the previous gate's state are measured by the deploy itself, and a failed one keeps the gate closed whatever the owner confirmed.

## A standalone `gate open --report`

It takes a deploy report only, not older than 30 minutes, of this host, incarnation and build, and runs the four store checks again right before it writes (`service-gate.md`). A restore report opens only through `restore-verify --open` (`restore.md`).
