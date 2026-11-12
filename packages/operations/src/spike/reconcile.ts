// THROW-AWAY (Run 2.4). Settles one operation that an executor left open, as
// an operator would: logged in as `maintenance`, reading OpenBao with an
// operator token. Rules:
//   - a terminal operation is never changed;
//   - not dispatched: `rejected` only when every executor is excluded;
//   - dispatched: `succeeded` when the backend holds a version whose envelope
//     carries this operation id; `rejected` when executors are excluded, no
//     version carries it and the current version still equals the expected
//     one; `uncertain` in every other case;
//   - every reconciliation writes a fresh state tag and returns its evidence.
// It writes no audit event: `maintenance` has no INSERT on audit.event (a
// finding for Run 4.5: which identity records a reconciliation?).
import type { OpenBaoClient } from "@mykey/openbao";
import type pg from "pg";
import { freshStateTag, spikeSecretPath } from "./executor.ts";

export interface ReconcileDeps {
  /** Logged in as maintenance. */
  maintenancePool: pg.Pool;
  /** An operator token in the organization's namespace. */
  operatorBao: OpenBaoClient;
}

export type ReconcileState = "succeeded" | "rejected" | "uncertain";

interface Row {
  id: string;
  organization_id: string;
  state: string;
  target: string;
  expected: { version: number };
  dispatched_at: Date | null;
  project_id: string;
}

export async function reconcile(
  deps: ReconcileDeps,
  operationId: string,
  opts: { executorsExcluded: boolean },
): Promise<{ state: ReconcileState; evidence: string[] }> {
  const evidence: string[] = [];
  const client = await deps.maintenancePool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<Row>(
      `SELECT o.id, o.organization_id, o.state, o.target, o.expected, o.dispatched_at, e.project_id
         FROM app.operation o
         JOIN app.environment e ON e.id = split_part(o.target, '/', 1)::uuid
        WHERE o.id = $1 FOR UPDATE OF o`,
      [operationId],
    );
    const operation = found.rows[0];
    if (operation === undefined) throw new Error("no such operation");
    if (operation.state === "succeeded" || operation.state === "rejected") {
      await client.query("ROLLBACK");
      return { state: operation.state, evidence: [`terminal: ${operation.state}`] };
    }
    const [environmentId, name] = operation.target.split("/") as [string, string];
    const expected = operation.expected.version;

    let state: ReconcileState = "uncertain";
    let version: number | null = null;
    if (operation.dispatched_at === null) {
      evidence.push("never dispatched");
      if (opts.executorsExcluded) state = "rejected";
    } else {
      evidence.push(`dispatched at ${operation.dispatched_at.toISOString()}`);
      const path = spikeSecretPath(operation.project_id, environmentId, name);
      const metadata = await deps.operatorBao.kvMetadata(path);
      let current = 0;
      let carried: number | null = null;
      if (metadata.ok) {
        current = metadata.data.currentVersion;
        for (const key of Object.keys(metadata.data.versions)) {
          const read = await deps.operatorBao.kvRead(path, Number(key));
          if (read.ok && read.data.envelope.operation_id === operationId) carried = Number(key);
        }
        evidence.push(`backend current version ${current}`);
      } else if (metadata.kind === "not_found") {
        evidence.push("backend holds no version");
      } else {
        evidence.push(`backend unreadable: ${metadata.kind}`);
        current = -1;
      }
      if (carried !== null) {
        evidence.push(`version ${carried} carries this operation`);
        state = "succeeded";
        version = carried;
      } else if (opts.executorsExcluded && current === expected) {
        evidence.push("no version carries this operation; current version is the expected one");
        state = "rejected";
      } else {
        evidence.push(
          opts.executorsExcluded
            ? "no version carries this operation, but the current version moved"
            : "executors are not excluded: the request may still arrive",
        );
      }
    }

    const tag = freshStateTag();
    if (state === "succeeded" && version !== null) {
      await client.query(
        `UPDATE app.operation SET state = 'succeeded', result = $2, completed_at = now() WHERE id = $1`,
        [operationId, { version, reconciled: true }],
      );
      await client.query(
        `INSERT INTO app.secret_index (environment_id, name, organization_id, current_version, state_tag,
                                       state, last_changed_at, last_operation_id)
         VALUES ($1, $2, $3, $4, $5, 'live', now(), $6)
         ON CONFLICT (environment_id, name) DO UPDATE SET current_version = $4, state_tag = $5,
           state = 'live', last_changed_at = now(), last_operation_id = $6`,
        [environmentId, name, operation.organization_id, version, tag, operationId],
      );
      await client.query(
        "UPDATE app.environment SET metadata_generation = metadata_generation + 1 WHERE id = $1",
        [environmentId],
      );
      await client.query("DELETE FROM app.effect_slot WHERE operation_id = $1", [operationId]);
    } else if (state === "rejected") {
      // Settled as not applied; a replay answers with this code.
      await client.query(
        `UPDATE app.operation SET state = 'rejected', error_code = 'state_conflict', completed_at = now()
          WHERE id = $1`,
        [operationId],
      );
      // The index returns to what the backend holds: the expected version, or no row at all.
      if (expected === 0) {
        await client.query("DELETE FROM app.secret_index WHERE environment_id = $1 AND name = $2", [
          environmentId,
          name,
        ]);
      } else {
        await client.query(
          `UPDATE app.secret_index SET current_version = $3, state_tag = $4, state = 'live',
                  last_changed_at = now()
            WHERE environment_id = $1 AND name = $2`,
          [environmentId, name, expected, tag],
        );
      }
      await client.query("DELETE FROM app.effect_slot WHERE operation_id = $1", [operationId]);
    } else {
      await client.query(
        `UPDATE app.secret_index SET state_tag = $3, state = 'needs_review', last_changed_at = now()
          WHERE environment_id = $1 AND name = $2`,
        [environmentId, name, tag],
      );
    }
    await client.query("COMMIT");
    evidence.push(`state tag renewed`);
    return { state, evidence };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
