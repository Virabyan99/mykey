// ops reconcile-environment --environment <id>   (Run 4.5, P-75; runbook reconciliation.md)
//
// Rebuilds the environment's index from OpenBao and brings an environment in
// review back to active. Exit 0 `rebuilt names <n> changed <m>`; exit 3 when
// refused (an operation unresolved, OpenBao unreadable, the environment busy);
// exit 2 for an unknown environment. Never prints a value.
import { randomUUID } from "node:crypto";
import { environmentIdSchema, type OrganizationId, type ProjectId } from "@mykey/contracts";
import { createPool } from "@mykey/db";
import { OpenBaoClient, namespaceFor } from "@mykey/openbao";
import { reconcileEnvironment } from "@mykey/operations/operator";
import { EXIT, type OpsCommand } from "../cli.ts";

const NEXT_STEP: Record<string, string> = {
  unresolved_operations: "next: ops operations, then reconcile-operation for each",
  backend_unreadable:
    "next: make OpenBao reachable and unsealed (verify-organization), then run this again",
  busy: "next: run this again",
};

export const reconcileEnvironmentCommand: OpsCommand = {
  flags: ["environment"],
  summary:
    "rebuild an environment's index from OpenBao; ends its review (runbook reconciliation.md)",
  async run(flags, io) {
    const parsed = environmentIdSchema.safeParse(flags.environment);
    if (!parsed.success) {
      io.stderr.write("reconcile-environment: --environment <uuid> is required\n");
      return EXIT.usage;
    }
    const { database, openBao } = io.env;
    if (database === undefined || openBao === undefined) {
      io.stderr.write(
        "reconcile-environment: run through host.ts <host> ops (no database or OpenBao)\n",
      );
      return EXIT.failed;
    }
    const pool = createPool(database, { max: 2 });
    try {
      const found = await pool.query<{ organization_id: OrganizationId; project_id: ProjectId }>(
        "SELECT organization_id, project_id FROM app.environment WHERE id = $1",
        [parsed.data],
      );
      const environment = found.rows[0];
      if (environment === undefined) {
        io.stderr.write(`reconcile-environment: no environment ${parsed.data}\n`);
        return EXIT.refused;
      }
      const bao = new OpenBaoClient(openBao.target, {
        namespace: namespaceFor(environment.organization_id),
        token: openBao.rootToken,
      });
      const verdict = await reconcileEnvironment(
        { database: pool, bao, operatorId: null, requestId: randomUUID() },
        {
          organizationId: environment.organization_id,
          projectId: environment.project_id,
          environmentId: parsed.data,
        },
      );
      if (verdict.kind === "rebuilt") {
        io.stdout.write(
          `rebuilt names ${String(verdict.names)} changed ${String(verdict.changed)}\n`,
        );
        return EXIT.ok;
      }
      io.stdout.write(`refused ${verdict.reason}\n${NEXT_STEP[verdict.reason] ?? ""}\n`);
      return EXIT.review;
    } catch (error) {
      io.stderr.write(
        `reconcile-environment failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    } finally {
      await pool.end();
    }
  },
};
