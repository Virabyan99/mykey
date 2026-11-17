# Restore

How a host is rebuilt from a backup pair. The nine steps of Doc 06 §14; decisions D-54 (the gate) and D-55 (the restore). Written in Run 6.7; the drill (Run 6.8) times each step on a clean host and adds what it learns here.

A restore **never opens anything by itself**. It ends closed + `verifying`: the public listener answers `quarantined` and `/health` is down until a verification report opens the gate. Expect the probe's `health_failing` for the whole window.

## Before

- The target host is installed (`host.ts <host> bootstrap`, `apply`, `up`, `db-init`, `keys init`) and its release is loaded, with **the gate closed and the executors stopped** (`host.ts <host> quiesce` on staging). A restore refuses a host whose gate is open or whose database holds organizations.
- The workstation holds: the source host's R2 token `mykey-<source>-pairs-upload` (`~/.mykey/secrets/r2/`), the source's custody copy `~/.mykey/custody/<source>/openbao-init.json` (its root token is in the pair's snapshot), and the trust anchor `infra/hosts/backup/trust/<source>-<key>.pub` (Git).
- The target's KMS certificate can use the pair's seal key: a pair sealed under another key is refused at step 2, before anything is written.

## Steps 1–7: `restore`

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> restore --source <staging|prod> --newest
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> restore --source <staging|prod> --pair <pair id>
```

| Step | What happens                                                                                                                                                             | What it prints / where to look                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1    | Refuses an open gate or a database with organizations                                                                                                                    | `restore refused: …`, exit 1                                           |
| 2    | `eligible.json` and its signature, the bundle into the host's tmpfs, its digest, `restic check --read-data`, `restic restore`, each artifact's digest; the KMS key check | `pair <id>: signature, bundle, Restic and digests verified`            |
| 3    | `globals.sql` compared with the inventory (never run), new role passwords, database access, `pg_restore`                                                                 | an unknown role stops it: `globals.sql creates roles … : <name>`       |
| 4    | The OpenBao snapshot on the same seal; the restore's own root token                                                                                                      | —                                                                      |
| 5–6  | Every credential class invalidated; the control row idle with a new incarnation                                                                                          | audit `operator.restore_begin`, `operator.restore_invalidate` (counts) |
| 7    | `host.env` gets the new incarnation and host instance id; api and provisioner start; gate `closed` + `verifying`                                                         | `pair <id> restored; closed + verifying; incarnation <uuid>`           |

It also prints the measurements (`measured (FR-1.69): …`) and checks two old credentials it holds: the pair's root token and the old `maintenance` password, both must be refused.

New role passwords go where they were: `api_runtime` and `provisioner_runtime` on the host, the others in `~/.mykey/secrets/hosts/<host>/<role>`. The restore's root token waits in `~/.mykey/secrets/hosts/<host>/restore-root-token` (0600) for step 9; the hand-off in `restore.json` beside it.

**When it stops.** Each step writes `/var/lib/mykey/restore-state.json` on the host. Run the same command again: it starts from step 1 and does every step again (nothing is skipped on the word of an earlier run). Until a report opens it, the host stays closed whatever step it stopped at.

## Between 7 and 8: the owner comes back

Every account is `recovery_pending` and every machine token is revoked.

1. `host.ts <host> ops verify-organization --organization <id>` and `host.ts <host> ops reconcile-credentials --environment <id>` for every environment.
2. `host.ts <host> ops reset-account --email <owner> --kind mfa` (`operator-accounts.md`). Give the link to the owner.
3. `host.ts <host> tunnel verify` opens a local port to the verification listener. Through it the owner completes the reset, enrols a new authenticator, signs in, reveals one secret they know and checks its value, and tries one change (it must answer `quarantined`). Then the owner signs out: the report requires that no session exists.

## Steps 8–9: `restore-verify`

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> restore-verify --confirm-members <count> --owner-confirmed
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> restore-verify --confirm-members <count> --owner-confirmed --open
```

- The report goes to `~/.mykey/secrets/hosts/<host>/restore-report.json` and the measurements to `restore-measurements.json`. It lists every check; a check not `ok` is printed with what was observed.
- `--confirm-members <count>`: the restored memberships are the pair's, which may hold someone removed since. Read the count the report prints, check the list in the database, then confirm it. A wrong count fails `members_confirmed`.
- `--owner-confirmed`: the owner did the journey above in a browser. `--journey` (the operator runs it with the owner's credentials) arrives with the drill.
- `--open`: `gate open` with the report, after re-checking sessions, accessors, the control row and the incarnation. Then the restore's root token is revoked and its copy and the state files are removed. A report older than 30 minutes is refused: run `restore-verify` again.

After opening: every person signs in after a reset, every machine needs a new token, and every `uncertain` operation needs review (`reconciliation.md`).

## Production

The same commands with the owner's permission for each one that touches the host. The owner completes the reset and the journey in their own browser through `tunnel verify` and says so; the operator then runs `restore-verify … --owner-confirmed`.
