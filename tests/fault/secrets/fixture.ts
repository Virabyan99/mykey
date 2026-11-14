// The fault suite of the secret protocol (Run 4.6, AC-1.38): a private stack
// (OpenBao and PostgreSQL may be restarted), the secret fixture's in-process
// API and one child-process API that really dies (a fault `crash` is SIGKILL
// inside the hook). Every OpenBao call of both passes the TLS relay. The
// helpers settle with the library call of Run 4.5 as `maintenance`.
import { randomBytes, randomUUID } from "node:crypto";
import type { OperationId } from "@mykey/contracts";
import {
  reconcileOperation,
  type OperationVerdict,
  type ReconcileDeps,
} from "@mykey/operations/operator";
import { sweepStaleOperations, type SweepResult } from "@mykey/operations";
import type { FaultAction } from "../../harness/api-process.ts";
import {
  createSecretsFixture,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";
import { restartService } from "../../harness/stack.ts";

export type Kind = "create" | "update" | "delete" | "undelete" | "restore";
export const KINDS: readonly Kind[] = ["create", "update", "delete", "undelete", "restore"];

export interface Current {
  version: number;
  stateTag: string;
}

export interface Prepared {
  env: EnvName;
  kind: Kind;
  name: string;
  /** The tag the action expects (null for a create). */
  expected: Current | null;
  /** The value the action writes (create, update) — for searching output; restore writes version 1's. */
  values: string[];
  /** The request, with its own idempotency key and body; `to` picks the API. */
  send(to?: "first" | "second"): Promise<Answer>;
}

export interface FaultFixture {
  f: SecretsFixture;
  /** Brings a fresh key to where `kind` applies; answers the request to send. */
  prepare(env: EnvName, kind: Kind): Promise<Prepared>;
  /** Restarts the child process with one fault (or none). */
  child(fault?: { point: string; action: FaultAction }): Promise<void>;
  settle(operationId: string, opts: { excluded: boolean }): Promise<OperationVerdict>;
  /** Kill the child process, restart OpenBao (its open requests die), wait until it serves. */
  excludeExecutors(): Promise<void>;
  /** KV changes the audit device recorded for this operation id. */
  changes(operationId: string): Promise<number>;
  sweepNow(): Promise<SweepResult>;
  /** The operation row as the superuser reads it. */
  operation(operationId: string): Promise<{ state: string; error_code: string | null } | null>;
  slotHolder(env: EnvName): Promise<string | null>;
  /** The newest operation that names this key (the client of a dead process got no id). */
  operationOf(name: string): Promise<string>;
  close(): Promise<void>;
}

const synthetic = (): string => `fault-${randomBytes(12).toString("hex")}`;
export const unique = (): string => `FT_${randomBytes(5).toString("hex").toUpperCase()}`;

const currentOf = (answer: Answer): Current => {
  if (answer.status >= 300)
    throw new Error(`setup answered ${String(answer.status)} ${answer.code ?? ""}`);
  return answer.body.result as Current;
};

export async function faultFixture(): Promise<FaultFixture> {
  const f = await createSecretsFixture({ private: true, processes: 2 });
  const maintenance = f.api.database.pool("maintenance");

  const fixture: FaultFixture = {
    f,
    async prepare(env, kind) {
      const name = unique();
      const values: string[] = [];
      let expected: Current | null = null;
      if (kind !== "create") {
        const first = synthetic();
        values.push(first);
        expected = currentOf(await f.create(env, name, first));
        if (kind === "restore") {
          const second = synthetic();
          values.push(second);
          expected = currentOf(await f.update(env, name, second, expected));
        }
        if (kind === "undelete") expected = currentOf(await f.act(env, name, "delete", expected));
      }
      const key = randomUUID();
      const value = synthetic();
      if (kind === "create" || kind === "update") values.push(value);
      const tag = expected;
      return {
        env,
        kind,
        name,
        expected,
        values,
        send(to = "first") {
          if (kind === "create") return f.create(env, name, value, { key, to });
          if (tag === null) throw new Error("a versioned action needs its expected tag");
          if (kind === "update") return f.update(env, name, value, tag, { key, to });
          return f.act(env, name, kind, tag, {
            key,
            to,
            ...(kind === "restore" ? { sourceVersion: 1 } : {}),
          });
        },
      };
    },
    async child(fault) {
      await f.restartSecond(fault);
    },
    settle(operationId, opts) {
      const deps: ReconcileDeps = {
        database: maintenance,
        bao: f.operatorBao(),
        operatorId: null,
        requestId: randomUUID(),
      };
      return reconcileOperation(deps, operationId as OperationId, {
        executorsExcluded: opts.excluded,
      });
    },
    async excludeExecutors() {
      await f.second?.kill("SIGKILL");
      await restartService(f.stack, "openbao");
    },
    changes(operationId) {
      return f.auditedChanges(operationId);
    },
    sweepNow() {
      return sweepStaleOperations(f.api.pool, { staleSeconds: 0 });
    },
    async operation(operationId) {
      const result = await f.api.superuser.query<{ state: string; error_code: string | null }>(
        "SELECT state, error_code FROM app.operation WHERE id = $1",
        [operationId],
      );
      return result.rows[0] ?? null;
    },
    async slotHolder(env) {
      const result = await f.api.superuser.query<{ operation_id: string }>(
        "SELECT operation_id FROM app.effect_slot WHERE scope_key = $1",
        [`env:${f.env(env).environmentId}`],
      );
      return result.rows[0]?.operation_id ?? null;
    },
    async operationOf(name) {
      const result = await f.api.superuser.query<{ id: string }>(
        "SELECT id FROM app.operation WHERE secret_name = $1 ORDER BY created_at DESC LIMIT 1",
        [name],
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error(`no operation names ${name}`);
      return id;
    },
    close() {
      return f.close();
    },
  };
  return fixture;
}

export { synthetic };
