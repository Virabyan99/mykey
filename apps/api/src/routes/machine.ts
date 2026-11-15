// machine.keys and machine.resolve (Run 5.4, P-94, FR-1.44, D-42). The
// pipeline has authenticated the presented token and bound it to its own
// environment; every backend read here uses the client built from that token
// (`reader`), never the runtime identity. The recheck re-reads the parents and
// the credential under the read's lock connection (parents first, as every
// admission), and the gate. The audit row is committed before the body leaves;
// the body is one buffer with its length, never compressed.
import { appendAudit } from "@mykey/audit";
import { API_MAJOR, type ErrorCode } from "@mykey/contracts";
import { lockParents } from "@mykey/db";
import {
  readEnvironment,
  readEnvironmentNames,
  readGate,
  type EnvironmentReadRequest,
} from "@mykey/operations";
import type pg from "pg";
import type { LargeGate } from "../large.ts";
import { ApiError, type ApiContext, type AppDeps, type Handler } from "../pipeline/context.ts";
import type { MachinePrincipal } from "../pipeline/machine.ts";
import { readDeps, refusedOf } from "./secrets.ts";

function parentCode(state: string | null): ErrorCode | null {
  if (state === "active") return null;
  if (state === "needs_review") return "backend_inconsistent";
  return "action_denied";
}

/** The admission recheck (FR-1.10) of a machine read: the parents, the credential, the gate. */
function machineRecheck(deps: AppDeps, machine: MachinePrincipal) {
  return async (tx: pg.PoolClient): Promise<ErrorCode | null> => {
    const parents = await lockParents(tx, machine.scope, null);
    for (const state of [parents.organization, parents.project, parents.environment]) {
      const code = parentCode(state);
      if (code !== null) return code;
    }
    const credential = await tx.query<{ state: string; live: boolean }>(
      `SELECT state, coalesce(effective_expires_at > now(), false) AS live
         FROM app.machine_credential WHERE id = $1 FOR SHARE`,
      [machine.credentialId],
    );
    const row = credential.rows[0];
    if (row?.state !== "active" || !row.live) return "unauthenticated";
    if (!readGate(deps.config.gatePath, deps.config.hostInstanceId).open) return "quarantined";
    return null;
  };
}

function machineRead(
  ctx: ApiContext,
  deps: AppDeps,
  action: "machine.keys" | "machine.resolve",
): EnvironmentReadRequest {
  const machine = ctx.machine;
  if (machine === null) throw new ApiError("dependency_unavailable");
  const { scope, reader } = machine;
  return {
    scope,
    routeId: ctx.route.id,
    requestId: ctx.requestId,
    recheck: machineRecheck(deps, machine),
    reader: {
      client: reader,
      alive: async () => (await reader.tokenLookupSelf()).ok,
    },
    audit: async (tx, read) => {
      await appendAudit(tx, {
        action,
        actor: { kind: "machine", id: machine.credentialId },
        source: "api",
        organizationId: scope.organizationId,
        target: { kind: "environment", id: scope.environmentId },
        outcome: "success",
        requestId: ctx.requestId,
        operationId: null,
        details: { names: read.names, generation: read.generation.toString() },
      });
    },
  };
}

export const machineKeysHandler: Handler = async (ctx, deps) => {
  const request = machineRead(ctx, deps, "machine.keys");
  const outcome = await readEnvironmentNames(readDeps(deps), request);
  if (outcome.kind === "refused") refusedOf(outcome);
  return {
    status: 200,
    buffered: true,
    body: {
      apiMajor: API_MAJOR,
      environmentId: request.scope.environmentId,
      generation: outcome.generation.toString(),
      count: outcome.names.length,
      names: outcome.names,
      complete: true,
    },
  };
};

export function machineResolveHandler(large: LargeGate): Handler {
  return (ctx, deps) =>
    large.run(async () => {
      const request = machineRead(ctx, deps, "machine.resolve");
      const outcome = await readEnvironment(readDeps(deps), request);
      if (outcome.kind === "refused") refusedOf(outcome);
      const entries = outcome.read.entries.map(({ name, value }) => ({ name, value }));
      return {
        status: 200,
        buffered: true,
        body: {
          apiMajor: API_MAJOR,
          environmentId: request.scope.environmentId,
          generation: outcome.read.generation.toString(),
          count: entries.length,
          entries,
          complete: true,
        },
      };
    });
}
