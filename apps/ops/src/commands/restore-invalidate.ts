// Run 6.7 Task B (P-124 step 5 and 6, D-55): a restored world loses every
// credential by class, not by list. The pair is days old: it holds sessions,
// reset links, machine tokens, AppRole secret ids and root tokens that were
// valid when it was captured, and some that were withdrawn since. None of
// them may work again.
//
// The database part is one transaction: the control row becomes idle with a
// new incarnation and the pair it came from (the barrier refuses every other
// write while the restored row still says capturing), then sessions, reset
// tokens and verifications are deleted, every account not disabled is
// recovery_pending with a higher epoch, every credential row not revoked is
// revoked, and every operation that is not terminal is uncertain.
//
// The backend part walks the root namespace and every namespace of
// `LIST sys/namespaces` (D-18: the catalog may not know one): every token
// accessor is revoked but the restore's own, the AppRoles get a new secret id
// (the old ones destroyed), and the namespace's incarnation copy is written
// last. A namespace that already names the new incarnation is done, so a
// second call changes nothing and a call stopped half-way is completed.
import { randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import { withTransaction } from "@mykey/db";
import type { AppRoleName } from "@mykey/openbao";
import type { OpenBaoAdmin } from "@mykey/openbao/admin";
import type pg from "pg";

const ORGANIZATION_APPROLES: readonly AppRoleName[] = ["runtime", "issuer", "provisioner"];

export type RestorePoint = "database" | "namespace";

export interface RestoreDeps {
  /** The restored database, as its superuser (the restore owns the new cluster). */
  pool: pg.Pool;
  /** The restored OpenBao, with the restore's own root token (never revoked here). */
  admin: OpenBaoAdmin;
  /** The pair the world was restored from. */
  pairId: string;
  /** Installs an AppRole's new credential where its process reads it. */
  deliver: (
    namespace: string,
    name: AppRoleName | "backup",
    credential: { roleId: string; secretId: string },
  ) => Promise<void>;
  /** Tests only: called after the database part, and before each namespace's last write. */
  crashAt?: (point: RestorePoint) => void;
}

/**
 * The credential step of the invalidation (D-55; Session 11, P-190): every row
 * of both tables that is not revoked, and their number. A machine credential
 * of either kind and an automation credential are refused by the product from
 * this transaction on, whatever OpenBao still holds. A project keeps the
 * chain that manages it: one automation credential issued with `replaces`
 * takes the chain up again (runbook automation.md).
 */
export async function revokeEveryCredential(tx: pg.PoolClient): Promise<number> {
  const machine =
    (await tx.query("UPDATE app.machine_credential SET state = 'revoked' WHERE state <> 'revoked'"))
      .rowCount ?? 0;
  const automation =
    (
      await tx.query(
        `UPDATE app.automation_credential SET state = 'revoked', revoked_at = now()
          WHERE state <> 'revoked'`,
      )
    ).rowCount ?? 0;
  return machine + automation;
}

export interface InvalidateCounts {
  sessions: number;
  accounts: number;
  resetTokens: number;
  credentials: number;
  accessorsRevoked: number;
  namespaces: number;
  secretIdsRotated: number;
  operationsClosed: number;
}

const audit = (
  tx: pg.PoolClient,
  action: "operator.restore_begin" | "operator.restore_invalidate",
  details: Record<string, unknown>,
): Promise<string> =>
  appendAudit(tx, {
    action,
    actor: { kind: "operator", id: null },
    source: "operator",
    organizationId: null,
    target: null,
    outcome: "success",
    requestId: null,
    operationId: null,
    details,
  } as Parameters<typeof appendAudit>[1]);

async function databasePart(deps: RestoreDeps): Promise<{
  incarnation: string;
  counts: Omit<InvalidateCounts, "accessorsRevoked" | "namespaces" | "secretIdsRotated">;
}> {
  return withTransaction(deps.pool, async (tx) => {
    const control = await tx.query<{ incarnation: string | null; restored: string | null }>(
      `SELECT backend_incarnation AS incarnation, restored_from_pair AS restored
         FROM app.service_control FOR UPDATE`,
    );
    const row = control.rows[0];
    if (row === undefined) throw new Error("restore: the control row is missing");
    if (row.restored === deps.pairId && row.incarnation !== null) {
      // Done by an earlier call: nothing to change.
      return {
        incarnation: row.incarnation,
        counts: { sessions: 0, accounts: 0, resetTokens: 0, credentials: 0, operationsClosed: 0 },
      };
    }
    const incarnation = randomUUID();
    await tx.query(
      `UPDATE app.service_control
          SET capture_mode = 'idle', owner = NULL, pair_id = NULL,
              backend_incarnation = $1, restored_from_pair = $2, updated_at = now()`,
      [incarnation, deps.pairId],
    );
    await audit(tx, "operator.restore_begin", { pairId: deps.pairId });
    const sessions = (await tx.query("DELETE FROM auth.session")).rowCount ?? 0;
    await tx.query("DELETE FROM auth.verification");
    const resetTokens = (await tx.query("DELETE FROM auth.reset_token")).rowCount ?? 0;
    const accounts =
      (
        await tx.query(
          `UPDATE auth.account_state
              SET state = 'recovery_pending', auth_epoch = auth_epoch + 1, updated_at = now()
            WHERE state <> 'disabled'`,
        )
      ).rowCount ?? 0;
    const credentials = await revokeEveryCredential(tx);
    const operationsClosed =
      (
        await tx.query(
          `UPDATE app.operation SET state = 'uncertain', heartbeat_at = NULL
            WHERE state IN ('accepted', 'executing', 'awaiting_input')`,
        )
      ).rowCount ?? 0;
    return {
      incarnation,
      counts: { sessions, accounts, resetTokens, credentials, operationsClosed },
    };
  });
}

export async function restoreInvalidate(deps: RestoreDeps): Promise<InvalidateCounts> {
  const crash = deps.crashAt ?? (() => undefined);
  const { incarnation, counts } = await databasePart(deps);
  crash("database");

  const { admin } = deps;
  const self = await admin.lookupSelf();
  let accessorsRevoked = 0;
  let secretIdsRotated = 0;
  let namespaces = 0;
  for (const namespace of ["", ...(await admin.listNamespaces())]) {
    if ((await admin.readIncarnation(namespace)) === incarnation) continue;
    for (const accessor of await admin.listAccessors(namespace)) {
      if (accessor === self.accessor) continue;
      await admin.revokeAccessor(namespace, accessor);
      accessorsRevoked += 1;
    }
    const left = (await admin.listAccessors(namespace)).filter((a) => a !== self.accessor);
    if (left.length > 0) {
      throw new Error(`restore: ${String(left.length)} accessors are still present in a namespace`);
    }
    const roles: readonly (AppRoleName | "backup")[] =
      namespace === "" ? ["backup"] : ORGANIZATION_APPROLES;
    for (const name of roles) {
      if ((await admin.readAppRole(namespace, name)) === null) continue;
      await deps.deliver(namespace, name, await admin.rotateSecretId(namespace, name));
      secretIdsRotated += 1;
    }
    crash("namespace");
    await admin.writeIncarnation(namespace, incarnation);
    if (namespace !== "") namespaces += 1;
  }

  const result: InvalidateCounts = {
    ...counts,
    accessorsRevoked,
    namespaces,
    secretIdsRotated,
  };
  if (Object.values(result).some((n) => n > 0)) {
    await withTransaction(deps.pool, (tx) =>
      audit(tx, "operator.restore_invalidate", {
        sessions: result.sessions,
        accounts: result.accounts,
        credentials: result.credentials,
        namespaces: result.namespaces,
      }),
    );
  }
  return result;
}
