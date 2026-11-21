# Restore

How a host is rebuilt from a backup pair. The nine steps of Doc 06 §14; decisions D-54 (the gate) and D-55 (the restore). Written in Run 6.7; the drill (Run 6.8) times each step on a clean host and adds what it learns here.

A restore **never opens anything by itself**. It ends closed + `verifying`: the public listener answers `quarantined` and `/health` is down until a verification report opens the gate. Expect the probe's `health_failing` for the whole window.

## Before

- The target host is installed and its release is loaded, with **the gate closed and the executors stopped**. On a clean host (the drill, Run 6.8), in this order:

  ```sh
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> bootstrap        # then apply firewall|ssh + confirm, the VPN peer
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> kms-install <okms-cli-linux-x86_64.tar.gz>   # the pinned okms (the restore checks the pair's seal key with it)
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> kms-csr | kms-cert | kms-use   # kms-and-unseal.md: a certificate under the source's KMS domain
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> deploy --release <dir> --install-only
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> maint 10 -- docker compose --env-file /etc/mykey/host.env -f /opt/mykey/compose/host.compose.yml -p mykey pull --quiet postgres openbao edge   # upstream images, by digest
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> maint 5 -- docker pull -q restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510   # backup.sh's restic
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> up
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> bao-init         # the host's own root token: the restore's step 4 needs it (on the lost host's own name: written beside its copy, dated)
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> db-init
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> keys init
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> acme production  # then up again: a new host starts on Let's Encrypt staging (network.md)
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops-secrets      # MYKEY_HOST_NAME and the jobs' role passwords (the restore replaces the passwords)
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> timers           # the job timers
  node scripts/probe.ts secrets                                    # the heartbeat: status.sh writes the capacity record each minute; without it every expanding change answers 503
  MSYS_NO_PATHCONV=1 node scripts/host.ts <host> quiesce
  ```

  A restore refuses a host whose gate is open or whose database holds organizations, and a host where a finished restore left `/var/lib/mykey/restore-state.json` (the refusal names it).

- **A host restored onto its own reinstalled server** (production onto production). `bao-init` finds the lost host's answer in `~/.mykey/custody/<host>/openbao-init.json` and keeps it: that copy holds the pair's root token and the recovery key the restore needs. The new server's answer goes beside it, as `openbao-init.<UTC stamp>.json`. `bao-init` refuses only when that dated path already holds another answer. The restore then offers the new server's token from the dated copy.

- The workstation holds: the source host's R2 token `mykey-<source>-pairs-upload` (`~/.mykey/secrets/r2/`), the source's custody copy `~/.mykey/custody/<source>/openbao-init.json` (its root token is in the pair's snapshot), the source's backup password `~/.mykey/custody/<source>/backup/password` (Restic opens the pair with it; the restore installs it on the target, and a clean host's own password, made at install, is kept beside it as `/etc/mykey/secrets/backup/password.before-restore`), and the trust anchor `infra/hosts/backup/trust/<source>-<key>.pub` (Git).
- The target's KMS certificate can use the pair's seal key: a pair sealed under another key is refused at step 2, before anything is written.

## Steps 1–7: `restore`

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> restore --source <staging|prod> --newest
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> restore --source <staging|prod> --pair <pair id>
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> restore --source <staging|prod> --newest --organization <id>   # a clean host: the organization its API serves
```

| Step | What happens                                                                                                                                                             | What it prints / where to look                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1    | Refuses an open gate or a database with organizations                                                                                                                    | `restore refused: …`, exit 1                                           |
| 2    | `eligible.json` and its signature, the bundle into the host's tmpfs, its digest, `restic check --read-data`, `restic restore`, each artifact's digest; the KMS key check | `pair <id>: signature, bundle, Restic and digests verified`            |
| 3    | `globals.sql` compared with the inventory (never run), new role passwords, database access, `pg_restore`                                                                 | an unknown role stops it: `globals.sql creates roles … : <name>`       |
| 4    | The OpenBao snapshot on the same seal, with the first root token the target accepts; the restore's own root token, kept at once                                          | `the target's OpenBao accepts none of its root tokens` stops it        |
| 5–6  | Every credential class invalidated; the control row idle with a new incarnation                                                                                          | audit `operator.restore_begin`, `operator.restore_invalidate` (counts) |
| 7    | `host.env` gets the new incarnation and host instance id; api and provisioner start; gate `closed` + `verifying`                                                         | `pair <id> restored; closed + verifying; incarnation <uuid>`           |

It also prints the measurements (`measured (FR-1.69): …`) and checks two old credentials it holds: the pair's root token and the old `maintenance` password, both must be refused.

New role passwords go where they were: `api_runtime` and `provisioner_runtime` on the host, the others in `~/.mykey/secrets/hosts/<host>/<role>`. The restore's root token is written to `~/.mykey/secrets/hosts/<host>/restore-root-token` (0600) as soon as step 4 mints it, before the step is recorded; it waits there for step 9. The hand-off is in `restore.json` beside it.

**When it stops.** Each step writes `/var/lib/mykey/restore-state.json` on the host. Step 4 writes `snapshot` as soon as the snapshot is in: from then on the target's own root token is gone. Run the same command again: it starts from step 1 and does every step again (nothing is skipped on the word of an earlier run).

For the snapshot, step 4 offers the target's OpenBao these root tokens, in this order, and uses the first one it accepts:

1. the restore's own kept token;
2. the dated init answers, newest first;
3. the custody copy;
4. the pair's root token.

So a rerun works whatever step the run stopped at. One limit: the restore's own token lasts two hours. A run that stopped after step 5 (which revokes the pair's token) and is run again more than two hours later finds no token, and OpenBao must be initialised anew (`known-limits.md`). Until a report opens it, the host stays closed whatever step it stopped at.

## Between 7 and 8: the owner comes back

Every account is `recovery_pending` and every machine token is revoked. The owner's part, in plain words, is `start-here.md`, step 6; give them that page, not this section.

1. `host.ts <host> ops verify-organization --organization <id>` and `host.ts <host> ops reconcile-credentials --environment <id>` for every environment. Until step 9, `host.ts <host> ops` uses the restore's root token (`restore-root-token`): the snapshot replaced the token store the host's custody copy belonged to.
2. `host.ts <host> ops reset-account --email <owner> --kind mfa` (`operator-accounts.md`). Give the link to the owner.
3. `host.ts <host> tunnel verify` opens a local port to the verification listener. Through it the owner completes the reset, enrols a new authenticator, signs in, reveals one secret they know and checks its value, and tries one change (it must answer `quarantined`). Then the owner signs out: the report requires that no session exists.

## Steps 8–9: `restore-verify`

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> restore-verify --confirm-members <count> --owner-confirmed
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> restore-verify --confirm-members <count> --owner-confirmed --open
```

- The report goes to `~/.mykey/secrets/hosts/<host>/restore-report.json` and the measurements to `restore-measurements.json`. It lists every check; a check not `ok` is printed with what was observed.
- `--confirm-members <count>`: the restored memberships are the pair's, which may hold someone removed since. Read the count the report prints, check the list in the database, then confirm it. A wrong count fails `members_confirmed`.
- `--owner-confirmed`: the owner did the journey above in a browser.
- `--journey` (staging and the drill; never production): the operator runs the journey itself through the verification listener, with the newest reset link `ops reset-account` wrote since the restore began. The new password and authenticator seed go to `~/.mykey/secrets/hosts/<host>/` (`owner-password`, `owner-totp-seed`). A second `--journey` (for `--open`, after a report went stale) needs a new reset link first.
- `--open`, in this order:
  1. **The next root token.** A new root token for the restored OpenBao is made with generate-root and the **source's** recovery key: the snapshot carries the source's recovery configuration, so the target's own key no longer works. The target's custody copy `~/.mykey/custody/<host>/openbao-init.json` becomes the source's answer with that token. The copy it replaces is kept beside it, as `openbao-init.<UTC stamp>.json`. `ops`, a deploy and a restore of this host's later pairs use the new token.
  2. **The gate.** `gate open` with the report, after re-checking sessions, accessors, the control row and the incarnation. A report older than 30 minutes is refused: run `restore-verify` again.
  3. **The state.** The state line is marked `opened`. Then the restore's root token is revoked, and its copy and the state files are removed.

  Check that `/var/lib/mykey/restore-state.json` is gone. A restore refuses a host where a finished one is left, and so does a deploy, which opens no host whose restore is not finished. Copy the new custody copy to the password manager, in place of the one it replaced.

After opening: every person signs in after an `mfa` reset (`reset-account --kind mfa`), every machine needs a new token, and every `uncertain` operation needs review (`reconciliation.md`). The authenticators and recovery codes in the pair are never trusted (rule 9): a `password` reset is refused (`restored_factor`) while a person's active authenticator is older than the restore, and becomes possible again once they have enrolled anew.

## Production

The same commands with the owner's permission for each one that touches the host. The owner completes the reset and the journey in their own browser through `tunnel verify` and says so; the operator then runs `restore-verify … --owner-confirmed`.
