// THROW-AWAY (Run 2.4, G-EFFECT spike). Run 4.2 writes the real protocol; Run
// 2.9 uses this one to create load and a held effect. One secret write per
// operation, following Doc 06 §6.2:
//
//   1. replay lookup — an existing operation is answered from its row
//   2. advisory lock on environment.lock_key; one transaction: capture mode
//      idle, no effect slot, expected version → operation, step, slot, audit
//      intent                                                  → after_intent
//   3. one transaction: executing, executor_boot_id, dispatched_at,
//      dispatch_attempt_id                                     → after_dispatch_marker
//   4. one kvWrite                                             → after_backend_success
//   5. finalize: ok → index, state tag, generation, succeeded, slot removed
//      cas_mismatch/denied/invalid/sealed → rejected, slot removed
//      unknown → uncertain, index needs_review, SLOT KEPT      → after_finalize
import { randomBytes, randomUUID } from "node:crypto";
import { LIMITS, environmentIdSchema, projectIdSchema, type ErrorCode } from "@mykey/contracts";
import { createPool, type DbTarget } from "@mykey/db";
import { secretPath, type BaoResult, type OpenBaoClient } from "@mykey/openbao";
import type pg from "pg";

export type Boundary =
  "after_intent" | "after_dispatch_marker" | "after_backend_success" | "after_finalize";

export interface SpikeDeps {
  /** Logged in as api_runtime. */
  runtimePool: pg.Pool;
  /** For the session advisory lock: one dedicated connection per write. */
  lockTarget: DbTarget;
  bao: OpenBaoClient;
  bootId: string;
  /** The process kills itself (SIGKILL) at this boundary. */
  crashAt?: Boundary;
  /** The write is sent and the process never goes on (the runner gives the client a long deadline). */
  hangAfterSend?: boolean;
}

export interface SpikeWrite {
  organizationId: string;
  projectId: string;
  environmentId: string;
  name: string;
  value: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export type SpikeOutcome =
  | { operationId: string; state: "succeeded"; version: number }
  | { operationId: string; state: "rejected"; code: ErrorCode }
  | { operationId: string; state: "uncertain" };

export const SPIKE_PRINCIPAL = { kind: "system", id: "g-effect-spike" } as const;
export const SPIKE_ACTION = "secret.write";

export const targetOf = (input: { environmentId: string; name: string }): string =>
  `${input.environmentId}/${input.name}`;
export const scopeKeyOf = (environmentId: string): string => `env:${environmentId}`;
export const freshStateTag = (): string => randomBytes(16).toString("base64url");

/** The OpenBao path of a secret, from plain ids (validated here). */
export function spikeSecretPath(projectId: string, environmentId: string, name: string): string {
  return secretPath(
    projectIdSchema.parse(projectId),
    environmentIdSchema.parse(environmentId),
    name,
  );
}

class Refusal extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

function hit(deps: SpikeDeps, boundary: Boundary): void {
  if (deps.crashAt === boundary) process.kill(process.pid, "SIGKILL");
}

async function transaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface OperationRow {
  id: string;
  state: string;
  result: { version?: number } | null;
  error_code: string | null;
}

function answerFrom(row: OperationRow): SpikeOutcome {
  if (row.state === "succeeded") {
    return { operationId: row.id, state: "succeeded", version: Number(row.result?.version) };
  }
  if (row.state === "rejected") {
    return {
      operationId: row.id,
      state: "rejected",
      code: (row.error_code ?? "state_conflict") as ErrorCode,
    };
  }
  return { operationId: row.id, state: "uncertain" };
}

async function existing(pool: pg.Pool, input: SpikeWrite): Promise<OperationRow | undefined> {
  const found = await pool.query<OperationRow>(
    `SELECT id, state, result, error_code FROM app.operation
      WHERE principal_kind = $1 AND principal_id = $2 AND action = $3 AND target = $4 AND idempotency_key = $5`,
    [SPIKE_PRINCIPAL.kind, SPIKE_PRINCIPAL.id, SPIKE_ACTION, targetOf(input), input.idempotencyKey],
  );
  return found.rows[0];
}

/** A refusal before anything was sent: recorded as a rejected operation so a replay gives the same answer. */
async function recordRefusal(
  deps: SpikeDeps,
  input: SpikeWrite,
  code: ErrorCode,
): Promise<SpikeOutcome> {
  const operationId = randomUUID();
  await deps.runtimePool.query(
    `INSERT INTO app.operation (id, organization_id, principal_kind, principal_id, action, target,
                                idempotency_key, expected, state, error_code, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'rejected', $9, now())
     ON CONFLICT ON CONSTRAINT operation_idempotency_key DO NOTHING`,
    [
      operationId,
      input.organizationId,
      SPIKE_PRINCIPAL.kind,
      SPIKE_PRINCIPAL.id,
      SPIKE_ACTION,
      targetOf(input),
      input.idempotencyKey,
      { version: input.expectedVersion },
      code,
    ],
  );
  const row = await existing(deps.runtimePool, input);
  return row === undefined ? { operationId, state: "rejected", code } : answerFrom(row);
}

/** Step 2, under the environment's advisory lock. Returns the operation and step ids. */
async function recordIntent(
  deps: SpikeDeps,
  input: SpikeWrite,
): Promise<{ operationId: string; stepId: string }> {
  const lockClient = createPool(deps.lockTarget, { max: 1 });
  const connection = await lockClient.connect();
  try {
    const key = await connection.query<{ lock_key: string }>(
      "SELECT lock_key FROM app.environment WHERE id = $1",
      [input.environmentId],
    );
    const lockKey = key.rows[0]?.lock_key;
    if (lockKey === undefined) throw new Refusal("not_found");
    await connection.query(`SET lock_timeout = '${LIMITS.deadlines.advisoryLockMs}ms'`);
    try {
      await connection.query("SELECT pg_advisory_lock($1::bigint)", [lockKey]);
    } catch {
      throw new Refusal("busy");
    }
    try {
      return await transaction(deps.runtimePool, async (client) => {
        const control = await client.query<{ capture_mode: string }>(
          "SELECT capture_mode FROM app.service_control FOR SHARE",
        );
        if (control.rows[0]?.capture_mode !== "idle") throw new Refusal("busy");
        const slot = await client.query("SELECT 1 FROM app.effect_slot WHERE scope_key = $1", [
          scopeKeyOf(input.environmentId),
        ]);
        if (slot.rowCount !== 0) throw new Refusal("state_conflict");
        const index = await client.query<{ current_version: number | null }>(
          "SELECT current_version FROM app.secret_index WHERE environment_id = $1 AND name = $2",
          [input.environmentId, input.name],
        );
        if ((index.rows[0]?.current_version ?? 0) !== input.expectedVersion) {
          throw new Refusal("version_conflict");
        }
        const operationId = randomUUID();
        const stepId = randomUUID();
        await client.query(
          `INSERT INTO app.operation (id, organization_id, principal_kind, principal_id, action, target,
                                      idempotency_key, expected, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'accepted')`,
          [
            operationId,
            input.organizationId,
            SPIKE_PRINCIPAL.kind,
            SPIKE_PRINCIPAL.id,
            SPIKE_ACTION,
            targetOf(input),
            input.idempotencyKey,
            { version: input.expectedVersion },
          ],
        );
        await client.query(
          "INSERT INTO app.operation_step (id, operation_id, ordinal, target) VALUES ($1, $2, 0, $3)",
          [stepId, operationId, targetOf(input)],
        );
        await client.query(
          `INSERT INTO app.effect_slot (scope_key, operation_id, step_id, generation, acquired_at)
           VALUES ($1, $2, $3, 1, now())`,
          [scopeKeyOf(input.environmentId), operationId, stepId],
        );
        await audit(client, input, operationId, "intent");
        return { operationId, stepId };
      });
    } finally {
      await connection.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
    }
  } finally {
    connection.release();
    await lockClient.end();
  }
}

async function audit(
  client: pg.PoolClient | pg.Pool,
  input: SpikeWrite,
  operationId: string,
  outcome: string,
): Promise<void> {
  await client.query(
    `INSERT INTO audit.event (id, actor_kind, actor_id, organization_id, action, target_kind,
                              target_id, outcome, operation_id)
     VALUES ($1, $2, $3, $4, $5, 'secret', $6, $7, $8)`,
    [
      randomUUID(),
      SPIKE_PRINCIPAL.kind,
      SPIKE_PRINCIPAL.id,
      input.organizationId,
      SPIKE_ACTION,
      targetOf(input),
      outcome,
      operationId,
    ],
  );
}

const DEFINITE: Partial<Record<string, ErrorCode>> = {
  cas_mismatch: "version_conflict",
  denied: "action_denied",
  sealed: "backend_sealed",
  invalid: "backend_inconsistent",
  not_found: "backend_inconsistent",
};

/** Step 5. Every change requires this executor to still own the operation. */
export async function finalize(
  deps: SpikeDeps,
  input: SpikeWrite,
  operationId: string,
  sent: BaoResult<{ version: number }>,
): Promise<SpikeOutcome> {
  return transaction(deps.runtimePool, async (client) => {
    const owned = async (
      state: string,
      result: unknown,
      errorCode: string | null,
    ): Promise<void> => {
      const updated = await client.query(
        `UPDATE app.operation SET state = $3, result = $4, error_code = $5,
                completed_at = CASE WHEN $3 IN ('succeeded', 'rejected') THEN now() END
          WHERE id = $1 AND executor_boot_id = $2 AND state = 'executing'`,
        [operationId, deps.bootId, state, result, errorCode],
      );
      if (updated.rowCount !== 1) throw new Error("this executor no longer owns the operation");
    };
    if (sent.ok) {
      const version = sent.data.version;
      await owned("succeeded", { version }, null);
      await client.query(
        `INSERT INTO app.secret_index (environment_id, name, organization_id, current_version, state_tag,
                                       state, live_value_bytes, last_changed_at, last_operation_id)
         VALUES ($1, $2, $3, $4, $5, 'live', $6, now(), $7)
         ON CONFLICT (environment_id, name) DO UPDATE SET current_version = $4, state_tag = $5,
           state = 'live', live_value_bytes = $6, last_changed_at = now(), last_operation_id = $7`,
        [
          input.environmentId,
          input.name,
          input.organizationId,
          version,
          freshStateTag(),
          Buffer.byteLength(input.value),
          operationId,
        ],
      );
      await client.query(
        "UPDATE app.environment SET metadata_generation = metadata_generation + 1 WHERE id = $1",
        [input.environmentId],
      );
      await client.query("DELETE FROM app.effect_slot WHERE operation_id = $1", [operationId]);
      await audit(client, input, operationId, "succeeded");
      return { operationId, state: "succeeded", version } as const;
    }
    if (sent.kind !== "unknown") {
      const code = DEFINITE[sent.kind] ?? "backend_inconsistent";
      await owned("rejected", null, code);
      await client.query("DELETE FROM app.effect_slot WHERE operation_id = $1", [operationId]);
      await audit(client, input, operationId, "rejected");
      return { operationId, state: "rejected", code } as const;
    }
    // The write may have landed: nothing is trusted until reconciliation.
    await owned("uncertain", { cause: sent.cause }, null);
    await client.query(
      `INSERT INTO app.secret_index (environment_id, name, organization_id, current_version, state_tag,
                                     state, last_changed_at, last_operation_id)
       VALUES ($1, $2, $3, NULL, $4, 'needs_review', now(), $5)
       ON CONFLICT (environment_id, name) DO UPDATE SET state = 'needs_review', state_tag = $4,
         last_changed_at = now(), last_operation_id = $5`,
      [input.environmentId, input.name, input.organizationId, freshStateTag(), operationId],
    );
    await audit(client, input, operationId, "uncertain");
    return { operationId, state: "uncertain" } as const;
  });
}

export async function executeWrite(deps: SpikeDeps, input: SpikeWrite): Promise<SpikeOutcome> {
  const replay = await existing(deps.runtimePool, input);
  if (replay !== undefined) return answerFrom(replay);

  let intent: { operationId: string; stepId: string };
  try {
    intent = await recordIntent(deps, input);
  } catch (error) {
    if (error instanceof Refusal) return recordRefusal(deps, input, error.code);
    throw error;
  }
  hit(deps, "after_intent");

  const dispatchId = randomUUID();
  await transaction(deps.runtimePool, async (client) => {
    await client.query(
      `UPDATE app.operation SET state = 'executing', executor_boot_id = $2, dispatched_at = now()
        WHERE id = $1 AND state = 'accepted'`,
      [intent.operationId, deps.bootId],
    );
    await client.query("UPDATE app.operation_step SET dispatch_attempt_id = $2 WHERE id = $1", [
      intent.stepId,
      dispatchId,
    ]);
  });
  hit(deps, "after_dispatch_marker");

  const path = spikeSecretPath(input.projectId, input.environmentId, input.name);
  let sent = await deps.bao.kvWrite(
    path,
    { value: input.value, operation_id: intent.operationId, format: 1 },
    input.expectedVersion,
    { operationId: intent.operationId, dispatchId },
  );
  if (deps.hangAfterSend === true) await new Promise<never>(() => undefined);
  hit(deps, "after_backend_success");
  if (sent.ok) {
    // Read back: the version must carry this operation's id.
    const back = await deps.bao.kvRead(path, sent.data.version);
    if (!back.ok || back.data.envelope.operation_id !== intent.operationId) {
      sent = { ok: false, kind: "unknown", cause: "unclear_answer" };
    }
  }

  const outcome = await finalize(deps, input, intent.operationId, sent);
  hit(deps, "after_finalize");
  return outcome;
}
