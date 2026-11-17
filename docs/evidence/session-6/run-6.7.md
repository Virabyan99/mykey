# Run 6.7 — Quarantine gate v2 and restore tooling (D08-S42)

**Date:** 18 Nov 2026. **Branch:** `session-6`. **Decisions:** D-54 (gate v2), D-55 (restore by class). **Runbooks:** `restore.md` (new), `service-gate.md`, `custody-map.md`, `db-globals-inventory.md`, `credential-custody.md`, `audit.md`.

Everything here is proven locally. Staging and production keep their v1 gate until Run 6.9's first v2 deploy; the host restore runs whole first in the drill (Run 6.8).

## What was done

- **Task A — the record, the listener, the opening (P-122, P-123).**
  - Gate record v2 binds host instance, backend incarnation and release build. `readGate` admits `all`, `verification` (closed + `verifying`) or `none`, with a cause.
  - The incarnation lives in three places:
    - `app.service_control` (migration `0018`);
    - `host.env`;
    - a KV v2 mount `mykey-meta` in each organization namespace.

    The API compares the database's value (reused 5 s); the provisioner compares its namespace's copy and defers jobs.

  - `mayOpen` refuses a stale, foreign or incomplete report. `openGate` audits `operator.gate_open` before writing; `closeGate` writes first.
  - A second listener (`MYKEY_VERIFY_LISTEN`, `10.78.2.3:8444` on a host) serves reads, `/v1/auth/*` and reveal while the record is closed + `verifying`.
  - `host.ts`:
    - `gate open --report`, `gate close --verifying`, `tunnel verify`;
    - db-init writes the incarnation.
  - An import parks its remaining entries when the gate closes.
- **Task B — restore and invalidate (P-124).**
  - `OpenBaoAdmin` gains `listNamespaces`, `createRootToken`, `revokeSelf`, accessor lookup and revocation, `rotateSecretId` and the incarnation copy.
  - `restoreInvalidate` invalidates by class:
    - sessions, reset tokens and verifications are deleted;
    - accounts become `recovery_pending` with `auth_epoch + 1`;
    - credentials become `revoked`, and operations in flight become `uncertain`;
    - every accessor in every namespace of `sys/namespaces` is revoked;
    - the secret ids of the four AppRoles are rotated;
    - the control row goes idle with a new incarnation.

    It is idempotent and completes when stopped halfway.

  - `restoreVerify` writes the report of every required check. `fetchEligiblePair`, `preflightKms`, `globalsUnknownRoles` and the host step builders (`restore-steps.ts`) are added.
- **Task C — the whole restore, locally (P-124).**
  - `restoreToVerifying(target)` runs steps 1–7 against a `RestoreTarget`. Locally that is a second PostgreSQL cluster and a fresh scratch OpenBao (`tests/harness/restore-target.ts`).
  - `verifyJourney` is the owner's path through the listener: reset, enrolment, sign-in, reveal digest, a refused change, sign-out.
  - The P-125 changes happen after the capture: a password is changed, an admin is removed, a secret is written. Then the restore runs, and nine old credentials are each refused:
    - on the public and verification listeners: the old password, the changed password, an old TOTP code, an unused recovery code, the unused reset link, the live session cookie, the live machine token;
    - by OpenBao: every old machine token, the old `runtime` secret id and the old root token.
  - Other results:
    - the old `api_runtime` password is refused;
    - the removed admin is back, and the report fails until the members are confirmed;
    - a session inserted after the report makes `gate open` refuse through its re-check;
    - after opening, a write succeeds and the first issuance's token resolves; three denied actions answer 404;
    - a fresh capture on the restored database is not busy.
  - A restore stopped after each step serves nothing and refuses to open. Run again from step 1, it completes.
  - Before anything is written, a restore refuses a target that holds data, a pair whose KMS key is unusable here, and a `globals.sql` with an unknown role.
  - `host.ts <host> restore --source <host> (--pair <id> | --newest)` covers steps 1–7 over SSH (`scripts/host-restore.ts`). `restore-verify --confirm-members <n> --owner-confirmed [--open]` covers 8–9.
- **Close.**
  - A finding, fixed: a restore never ran `applyDatabaseAccess`, so the restored database gave `CREATE` and `TEMP` to every role.
  - FR-1.69's measurements were added (`restoreMeasurements`).
  - The audit coverage table lists `restore` and `verify-journey`.

## Commits

- `e942abf` feat(gate): bound to host, incarnation, release and a verification report
- `901abed` feat(ops): restore invalidates every credential class and reports
- `cbdcc1f` feat(host): a restore that stays closed until a report says open
- `b2d73db` fix(ops): a restore applies database access and measures itself
- the docs commit of this note (D-54, D-55, runbooks, registry)

## Commands and results

| Command                                                                                                       | Result                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vitest --project integration tests/integration/restore/{gate,listener}.test.ts`                              | 12/12; mutation-checked (no listener check, no incarnation compare → fail)                                                                             |
| `vitest --project integration tests/integration/provisioning/environment.test.ts -t …`                        | 2/2 (incarnation, gate closed); mutation-checked                                                                                                       |
| `vitest --project integration tests/integration/openbao/admin-restore.test.ts`                                | 4/4, RED first                                                                                                                                         |
| `vitest --project integration tests/integration/restore/invalidate.test.ts`                                   | 5/5; mutation (no namespace walk) → 4 fail                                                                                                             |
| `vitest --project integration tests/integration/restore/verify.test.ts`                                       | 7/7                                                                                                                                                    |
| `vitest --project integration tests/integration/restore/full.test.ts tests/fault/restore/interrupted.test.ts` | 9/9 + 4/4 (with the database-access test: RED on 4 roles, then GREEN); 301 s for both, one worker                                                      |
| Mutation: `recheckForOpen` checks nothing                                                                     | "a report made, then one session inserted" fails                                                                                                       |
| `vitest --project unit` new files                                                                             | `backup/restore` 7/7, `backup/restore-steps` 7/7, `hosts/host-restore` 5/5, `ops/restore-measurements` 2/2; `hosts/host-cli` restore parsers RED first |
| `pnpm test`                                                                                                   | 1173/1173                                                                                                                                              |
| `pnpm run check`                                                                                              | green                                                                                                                                                  |

The full integration suite runs at the gate (owner's rule, 17 Nov 2026).

## Deviations and decisions

- **Per-organization incarnation copy** (not the root namespace): the provisioner's only identity is its organization namespace.
- **The verification listener serves all of `/v1/auth/*`**: the owner's reset and enrolment happen there.
- **`createRootToken` instead of `generate-root`**: with an auto-unseal seal, `sys/generate-root` needs the recovery keys of the instance the snapshot came from. The restore mints an orphan 2 h root token with the pair's root token, then revokes it at the end.
- **The first authenticated request to a restored OpenBao takes about 5.6 s** (the token store loads). That is past the clients' 5 s deadline, so the restore warms it first (`baoWarm`, `warm`).
- **The lost world's unfinished operation is `accepted`**, not `executing`: a pair never holds an executing operation (the capture drains them).
- **`accounts_recovery_pending` and `reset_tokens_none` count against the restore's start.** An account is accepted only through a reset issued after the restore began. Literal "zero rows" would refuse the journey's own reset.
- **The journey signs out at its end**: the report requires that no session exists.
- **Local restores** use the stack's second cluster (`scratch-pg.override.yml`) and a fresh scratch OpenBao, not a second whole stack. The local fetch skips R2 and the signature; their refusals are unit-proven. "Killed after step N" is a throw after each step's state line.
- **`host.ts restore` is two commands.** The restore's root token waits on the workstation (0600) between them. `restore-verify --journey` on a host waits for the drill; `--owner-confirmed` works now. The host path is unit-tested with a fake shell; its whole run is Run 6.8's.
- **On a host, `old_credentials_refused`** checks the pair's root token and the old `maintenance` password. The nine-credential presentation is local and the drill's.
- **The host's PostgreSQL reset drops the product schemas** in the existing cluster. The plan says a new cluster; the globals comparison covers cluster-level objects.
- **`host.ts gate` keeps the v1 path** while `host.env` has no incarnation (staging and production until Run 6.9).
- **The registry unit test gets a 30 s timeout**: six whole registry scans take about 5 s on a loaded workstation.

## Registry

- FR-1.67 SPIKE_PASS
- FR-1.68 SPIKE_PASS
- FR-1.69 SPIKE_PASS
- FR-1.86 SPIKE_PASS
- FR-1.87 SPIKE_PASS

AC-1.28, AC-1.43, AC-1.44 and PO-22 wait for the drill (Run 6.8).

## Open issues

- **Staging's organization reads as drifted** (`policy:provisioner`) until Run 6.9 re-runs `provision-organization` there. That run also writes the namespace's incarnation copy.
- **Staging and production run v1 gates** until Run 6.9's first v2 deploy (`gate close`, a report, `gate open`).
- **`restore-verify --journey` on a host** and the whole host restore: Run 6.8.
- **An import's gate race:** if the gate closes between the per-entry check and the child's dispatch, that one entry is still rejected, not parked.
