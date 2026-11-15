// The operator's settlement of an environment's machine credentials (Run 5.2,
// P-90, FR-1.43, D-40). Under the environment's lock (2 s, else busy), with
// the operator's OpenBao authority in the organization's namespace:
//
// 0. The sweep's credential rules for this environment (all executing work at
//    once when the executors are excluded).
// 1. Every accessor of the namespace is looked up; those whose policies name
//    `machine-env-<environmentId>` are kept. The AppRoles' login tokens are in
//    the list too and are left alone (they carry no machine policy).
// 2. Each kept accessor that is not the accessor of an `active`, unexpired
//    row (nor of a `revoking` row, step 3) is revoked and its absence proven:
//    `unrecordedRevoked`. The `meta.operation_id` of each is remembered.
// 3. Each `revoking` row is revoked again and proven: `revoked`, its uncertain
//    revocations `succeeded`, an uncertain issuance of it `rejected`.
// 4. Each `needs_review` row → `revoked`, its issuance `rejected`
//    (`dependency_unavailable`) — only when its operation's token was found and
//    revoked in step 2, or the executors are excluded (D-20: a create that was
//    sent may still arrive; only exclusion ends that). Otherwise it is left
//    with `needs_exclusion` and the command exits 3 after doing the rest.
// 5. One audit row `operator.reconcile_credentials` with the counts.
//
// It never prints or stores an accessor; ids and counts only.
import { randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import { LIMITS, credentialIdSchema, type CredentialId, type OperationId } from "@mykey/contracts";
import {
  environmentCounters,
  moveCredential,
  settleOperation,
  settleRevocations,
  type EnvironmentScope,
} from "@mykey/db";
import { machineName, namespaceFor, type OpenBaoClient } from "@mykey/openbao";
import type { OpenBaoAdmin } from "@mykey/openbao/admin";
import type pg from "pg";
import { sweepCredentials } from "../credentials/sweep.ts";
import { revokeAndVerify } from "../credentials/verify.ts";
import { Busy, inTransaction, withEnvironmentLock, type Locked } from "../secrets/lock.ts";
import { RECONCILE_LOCK_WAIT_MS } from "./environment.ts";
import { BackendUnreadable } from "./rebuild.ts";

export interface CredentialReconcileDeps {
  /** Logged in as `maintenance`. */
  pool: pg.Pool;
  /** The operator's authority: lists the namespace's accessors. */
  admin: OpenBaoAdmin;
  /** The operator's token in the organization's namespace: lookups and revocations. */
  bao: OpenBaoClient;
  requestId: string;
}

export interface CredentialReconciliation {
  kind: "done";
  unrecordedRevoked: number;
  revocationsCompleted: number;
  issuancesSettled: number;
  /** credentialId null: a token no row names whose meta names no credential either. */
  left: { credentialId: CredentialId | null; reason: "needs_exclusion" | "unproven" }[];
}

interface Row {
  id: CredentialId;
  state: string;
  accessor: string | null;
  issuance_operation_id: OperationId;
  live: boolean;
}

const RETENTION = LIMITS.operation.terminalRetentionDays;

export async function reconcileCredentials(
  deps: CredentialReconcileDeps,
  request: { scope: EnvironmentScope; executorsExcluded: boolean },
): Promise<CredentialReconciliation | { kind: "busy" }> {
  const { lockKey } = await environmentCounters(deps.pool, request.scope);
  try {
    return await withEnvironmentLock(
      deps.pool,
      lockKey,
      (locked) => settle(deps, request, locked),
      RECONCILE_LOCK_WAIT_MS,
    );
  } catch (error) {
    if (error instanceof Busy) return { kind: "busy" };
    throw error;
  }
}

async function settle(
  deps: CredentialReconcileDeps,
  request: { scope: EnvironmentScope; executorsExcluded: boolean },
  locked: Locked,
): Promise<CredentialReconciliation> {
  const { scope, executorsExcluded } = request;
  // 0. Executing work whose executor stopped (all of it once the executors are excluded).
  await sweepCredentials(deps.pool, {
    environmentId: scope.environmentId,
    ...(executorsExcluded ? { staleSeconds: 0 } : {}),
  });
  const session = { client: deps.bao, close: () => Promise.resolve() };
  const correlation = () => ({ operationId: deps.requestId, dispatchId: randomUUID() });
  const left: CredentialReconciliation["left"] = [];

  // 1. The environment's tokens in the backend.
  const policy = machineName(scope.environmentId);
  const kept: { accessor: string; meta: Record<string, string> | null }[] = [];
  for (const accessor of await deps.admin.listAccessors(namespaceFor(scope.organizationId))) {
    const lookup = await deps.bao.tokenLookupAccessor(accessor);
    if (!lookup.ok) {
      if (lookup.kind === "invalid" && lookup.status === 400) continue; // gone since the list
      throw new BackendUnreadable(lookup.kind);
    }
    if (lookup.data.policies.includes(policy)) kept.push({ accessor, meta: lookup.data.meta });
  }

  const rows = (
    await locked.client.query<Row>(
      `SELECT id, state, accessor, issuance_operation_id,
              (effective_expires_at IS NOT NULL AND effective_expires_at > now()) AS live
         FROM app.machine_credential
        WHERE organization_id = $1 AND environment_id = $2`,
      [scope.organizationId, scope.environmentId],
    )
  ).rows;
  const named = new Set(
    rows
      .filter((row) => (row.state === "active" && row.live) || row.state === "revoking")
      .map((row) => row.accessor),
  );

  // 2. Tokens nobody records.
  let unrecordedRevoked = 0;
  const found = new Map<string, string>();
  for (const token of kept) {
    if (named.has(token.accessor)) continue;
    const proof = await revokeAndVerify(session, token.accessor, correlation());
    if (proof !== "absent") {
      const credentialId = credentialIdSchema.safeParse(token.meta?.credential_id);
      left.push({
        credentialId: credentialId.success ? credentialId.data : null,
        reason: "unproven",
      });
      continue;
    }
    unrecordedRevoked += 1;
    const operationId = token.meta?.operation_id;
    if (operationId !== undefined) found.set(operationId, token.accessor);
  }

  // 3. Revocations not yet proven.
  let revocationsCompleted = 0;
  for (const row of rows) {
    if (row.state !== "revoking" || row.accessor === null) continue;
    const proof = await revokeAndVerify(session, row.accessor, correlation());
    if (proof !== "absent") {
      left.push({ credentialId: row.id, reason: "unproven" });
      continue;
    }
    await inTransaction(locked.client, async (tx) => {
      if (!(await moveCredential(tx, row.id, ["revoking"], "revoked"))) return;
      await settleRevocations(tx, row.id, RETENTION);
      await settleOperation(
        tx,
        row.issuance_operation_id,
        { state: "rejected", errorCode: "dependency_unavailable" },
        RETENTION,
      );
      revocationsCompleted += 1;
    });
  }
  // A credential revoked by someone else may still have uncertain revocations.
  await inTransaction(locked.client, async (tx) => {
    for (const row of rows) {
      if (row.state !== "revoked") continue;
      revocationsCompleted += (await settleRevocations(tx, row.id, RETENTION)).length;
    }
  });

  // 4. Issuances whose outcome is unknown.
  let issuancesSettled = 0;
  for (const row of rows) {
    if (row.state !== "needs_review" && row.state !== "issuing") continue;
    const accessor = found.get(row.issuance_operation_id);
    if (row.state === "issuing" || (accessor === undefined && !executorsExcluded)) {
      left.push({ credentialId: row.id, reason: "needs_exclusion" });
      continue;
    }
    await inTransaction(locked.client, async (tx) => {
      if (!(await moveCredential(tx, row.id, ["needs_review"], "revoked", accessor))) return;
      await settleOperation(
        tx,
        row.issuance_operation_id,
        { state: "rejected", errorCode: "dependency_unavailable" },
        RETENTION,
      );
      issuancesSettled += 1;
    });
  }

  // 5. One audit row with the counts.
  await appendAudit(locked.client, {
    action: "operator.reconcile_credentials",
    actor: { kind: "operator", id: null },
    source: "operator",
    organizationId: scope.organizationId,
    target: { kind: "environment", id: scope.environmentId },
    outcome: left.length === 0 ? "success" : "failure",
    requestId: deps.requestId,
    operationId: null,
    details: {
      unrecordedRevoked,
      revocationsCompleted,
      issuancesSettled,
      left: left.length,
      executorsExcluded,
    },
  });
  return { kind: "done", unrecordedRevoked, revocationsCompleted, issuancesSettled, left };
}
