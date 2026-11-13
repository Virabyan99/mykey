# Operator accounts

In Stage 1 an account comes into being only through the operator's tool, never through the API (FR-1.01, D-27). Operator commands live in `apps/ops` and run on the operator's workstation; on a host they reach the database through an SSH tunnel as the role `maintenance`, whose password never leaves the workstation.

## How an operator command runs

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <staging|prod> ops <command> [--flag value]…
```

`host.ts` opens the PostgreSQL tunnel, reads the `maintenance` password from `~/.mykey/secrets/hosts/<host>/maintenance` and the auth keys from `~/.mykey/secrets/hosts/<host>/auth-keys/`, and runs the command in-process. Rules every command follows:

- **No secret on the command line.** A flag whose name looks like a secret (`--password`, `--token`, `--secret`, `--code`, `--key`, `--link`, `--seed`, …) is refused with exit 64 for every command. A secret the command needs is read from stdin.
- **No secret on the terminal.** A secret the command produces (a reset link from Run 3.6, later a delivered credential) is written to a new file `~/.mykey/out/<utc-timestamp>-<name>` (file 0600, directory 0700) and only the path is printed.
- **Exit codes:** 0 done, 1 failed (the class of the error is printed, never a database message), 2 refused, 3 needs review, 64 usage.

## Before the first command on a host: the key rings

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> keys init
```

Creates `<ring>.k1.key` (32 random bytes) on the workstation for every ring that has no file yet — existing files are never touched — and installs each file the host does not have yet under `/etc/mykey/secrets/api-keys/` (owner 1000:1000, 0600). Prints file names only. Run it again at any time; it changes nothing that exists. The API reads the directory read-only at `/run/mykey/keys`.

## Bootstrap of the owner

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops bootstrap-owner --email <address> < <password file>
```

- The password is the first line of stdin: 12 to 1,024 characters and at most 1,024 bytes (P-46). Generate it into a 0600 file on the workstation and feed the file; never type it on a command line.
- One transaction as `maintenance`: user (e-mail stored lower-case), credential account with Better Auth's hash, account state `enrollment_pending`, organization (namespace `org-<id>`, state `provisioning`), owner membership, audit `operator.bootstrap` (ids only).
- Output: `created user <id> organization <id>` (exit 0); repeated with the same e-mail: `already_present user <id> organization <id>` (exit 0, nothing changes, the password included); another e-mail while an owner exists: `refused: another_owner_exists` (exit 2); a password outside the rule: `refused: password_rejected` (exit 2).
- Interrupted anywhere, it leaves nothing; run it again.
- Afterwards the owner signs in with the password and must enroll TOTP before any product route answers (Run 3.4). The organization becomes `active` with `ops provision-organization` (Run 3.8).

The staging owner is `owner@mykey-staging.invalid` (synthetic), password in `~/.mykey/secrets/hosts/staging/owner-password`; ids in `docs/evidence/session-3/run-3.2.md`.

## Reset of a lost password or second factor (Run 3.6, D-30)

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops reset-account --email <address> --kind password
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops reset-account --email <address> --kind mfa
```

- Use `password` when the owner still has the authenticator app or a recovery code, `mfa` when the second factor is lost.
- The command blocks the account at once (`recovery_pending`; every session ends; no password signs in), supersedes any earlier link, and clears the account's throttle locks. Output: `issued for user <id>; link in <path>; expires <time>` (exit 0), or `refused: no_such_account | disabled` (exit 2). The link is in the file only; give it to the owner by a channel only they read, then shred the file.
- The link lives **15 minutes**. An expired link leaves the account blocked: run the command again; the new link supersedes the old one.
- **What the owner sees.** The link opens the reset page (Session 7). With `password`: a new password and a current TOTP code or one recovery code; afterwards the owner signs in with the new password and their existing authenticator. With `mfa`: a new password, then enrollment of a new authenticator right away (the reset session can do nothing else, and ends with the link); activation shows ten new recovery codes once, and the owner signs in afresh. The old authenticator and every old recovery code stop working when the `mfa` reset is completed.
- Every failure of the page (an unknown, expired, superseded or used link, a wrong code) is the same answer; the audit log has the reason (`auth.reset_failed`).

## Shredding output files

Files under `~/.mykey/out/` hold secrets for one use. After use: overwrite and remove the file (`shred -u <file>` in Git Bash), or delete it and empty the recycle bin. Nothing there is kept as custody; a lost file is replaced by running the command again (for a reset, a new link supersedes the old one).

## The `maintenance` role

`maintenance` is the operator identity in the database (P-45): it may insert users, credential accounts, account states and audit events, change an account's state and epochs, and delete sessions. It may not create tables, change a stored password hash or a session, or delete a user. The API's role `api_runtime` cannot create a user or a credential account at all (migration `0005`).
