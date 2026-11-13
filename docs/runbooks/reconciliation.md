# Reconciliation

What to do when a secret change's outcome is unknown, or an environment's index no longer matches OpenBao (Run 4.5, P-75, D-38).

## The alert

The probe raises `operations_unresolved` when the host's last heartbeat counted at least one unresolved operation (`status` → `operationsUnresolved`). It opens at once and resolves when the count is back to 0, like `review_open`.

An operation is **unresolved** when it is `uncertain` and not closed, or `accepted`/`executing` with a heartbeat older than 120 s. The API's sweep (every 30 s) turns a stale `executing` operation into `uncertain` (the key goes to review, the slot stays held) and a stale `accepted` one into `rejected` (nothing was sent).

While an operation holds its environment's slot, every change in that environment answers `409 key_under_review` with that operation's id. Reveals of other keys still answer.

## Step 1 — list

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops operations --organization <organizationId>
```

One line per unresolved operation: id, action, environment, name, state, age. No value is ever printed.

## Step 2 — the decision tree

Run without exclusion first. It settles every write that landed:

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops reconcile-operation --operation <id>
```

| Output (exit)                               | Meaning                                                                                     | Next                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `succeeded <id> version <n>` (0)            | A version carries the operation's id: the write landed. Index, counters and replay are set. | Done.                                    |
| `undetermined … executors_not_excluded` (3) | A write that did not land (yet), or any delete/undelete: a late twin could still arrive.    | Step 3.                                  |
| `undetermined … evidence_conflict` (3)      | The backend shows a change that is not this operation's, or the expected version is gone.   | Step 4.                                  |
| `undetermined … backend_unreadable` (3)     | OpenBao was unreachable or sealed.                                                          | Make it answer (`status`), run it again. |
| `undetermined … not_unresolved` (3)         | The operation is already finished, or still inside its heartbeat.                           | Nothing to do (`ops operations` again).  |

## Step 3 — exclude the executors, then decide

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> quiesce      # gate close, stop api + provisioner, restart OpenBao
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops reconcile-operation --operation <id> --executors-excluded yes
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> resume       # start api + provisioner; the gate stays closed
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> gate open
```

`quiesce` prints `executors: stopped` once OpenBao answers again. Restarting OpenBao ends any request it still held (D-20). `--executors-excluded yes` is your statement that this happened. Never give it without `quiesce`.

With exclusion:

- A write with no version above its start is **rejected**. The key is live at its old version with a new tag, and the original request replays `503 dependency_unavailable`.
- A delete or undelete whose expected version is in the target state is **succeeded**. In the state before, it is **rejected**.

## Step 4 — evidence that does not decide

Read the key's versions with the operator token. If the conflict cannot be explained and no executor can run (after `quiesce`), close it as unknown:

```sh
… ops reconcile-operation --operation <id> --executors-excluded yes --close-unknown yes
```

The operation stays `uncertain` for ever (its replay keeps answering `503 outcome_unknown`), stops counting as unresolved, releases the slot, and the key is rebuilt from what OpenBao holds.

## An environment in review

An environment goes to review when OpenBao refuses the runtime identity (`system.drift_detected`, object `kv_data`), or when the provisioner finds drift. First fix the cause: `ops verify-organization`, and for an environment its objects (`provisioning.md`). Then:

```sh
MSYS_NO_PATHCONV=1 node scripts/host.ts <host> ops reconcile-environment --environment <environmentId>
```

- `rebuilt names <n> changed <m>` (exit 0): every name of OpenBao and of the index is rebuilt from OpenBao, the counters are summed again, and the environment is `active`.
- `refused unresolved_operations` (exit 3): settle those first (steps 1–4).
- `refused busy` (exit 3): a request held the lock for 2 s; run it again.

It needs no exclusion: the environment's lock and the empty slot prove that no change is in flight.

## Never

- Edit `app.operation`, `app.secret_index`, `app.effect_slot` or an environment's state by hand.
- Send the change again under a new idempotency key while the slot is held.
- Clear a review through the superuser.
