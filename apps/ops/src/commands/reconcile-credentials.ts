// ops reconcile-credentials --environment <id> [--executors-excluded yes]
// (Run 5.2, P-90, D-40; runbooks machine-credentials.md, reconciliation.md)
//
// Settles an environment's machine credentials from OpenBao: revokes every
// token of the environment's machine policy that no live row names, finishes
// every `revoking` row, and closes every `needs_review` issuance whose token
// was found — or all of them with `--executors-excluded yes` (the operator's
// statement that no API process can still send a create: `host.ts <host>
// quiesce`). Exit 0 when nothing is left; 3 (review) when something is left,
// with the next step; 2 for an unknown environment. Prints ids and counts,
// never an accessor or a token.
import { randomUUID } from "node:crypto";
import { LIMITS, environmentIdSchema, type OrganizationId, type ProjectId } from "@mykey/contracts";
import { createPool } from "@mykey/db";
import { OpenBaoClient, namespaceFor } from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { BackendUnreadable, reconcileCredentials } from "@mykey/operations/operator";
import { EXIT, type OpsCommand } from "../cli.ts";

const NEXT_STEP: Record<string, string> = {
  needs_exclusion:
    "next: host.ts <host> quiesce, then reconcile-credentials --executors-excluded yes, then resume and gate open",
  unproven: "next: make OpenBao reachable and unsealed, then run this again",
};

export const reconcileCredentialsCommand: OpsCommand = {
  flags: ["environment", "executors-excluded"],
  summary:
    "settle an environment's machine credentials from OpenBao (runbook machine-credentials.md)",
  async run(flags, io) {
    const parsed = environmentIdSchema.safeParse(flags.environment);
    const excluded = flags["executors-excluded"];
    if (!parsed.success || (excluded !== undefined && excluded !== "yes")) {
      io.stderr.write(
        "reconcile-credentials: --environment <uuid> [--executors-excluded yes] is required\n",
      );
      return EXIT.usage;
    }
    const { database, openBao } = io.env;
    if (database === undefined || openBao === undefined) {
      io.stderr.write(
        "reconcile-credentials: run through host.ts <host> ops (no database or OpenBao)\n",
      );
      return EXIT.failed;
    }
    const pool = createPool(database, { max: LIMITS.db.opsPool });
    try {
      const found = await pool.query<{ organization_id: OrganizationId; project_id: ProjectId }>(
        "SELECT organization_id, project_id FROM app.environment WHERE id = $1",
        [parsed.data],
      );
      const environment = found.rows[0];
      if (environment === undefined) {
        io.stderr.write(`reconcile-credentials: no environment ${parsed.data}\n`);
        return EXIT.refused;
      }
      const result = await reconcileCredentials(
        {
          pool,
          admin: new OpenBaoAdmin(openBao.target, openBao.rootToken),
          bao: new OpenBaoClient(openBao.target, {
            namespace: namespaceFor(environment.organization_id),
            token: openBao.rootToken,
          }),
          requestId: randomUUID(),
        },
        {
          scope: {
            organizationId: environment.organization_id,
            projectId: environment.project_id,
            environmentId: parsed.data,
          },
          executorsExcluded: excluded === "yes",
        },
      );
      if (result.kind === "busy") {
        io.stdout.write("refused busy\nnext: run this again\n");
        return EXIT.review;
      }
      const counts = [
        `unrecorded-revoked ${String(result.unrecordedRevoked)}`,
        `revocations-completed ${String(result.revocationsCompleted)}`,
        `issuances-settled ${String(result.issuancesSettled)}`,
      ].join(" ");
      const changed =
        result.unrecordedRevoked + result.revocationsCompleted + result.issuancesSettled;
      io.stdout.write(`${counts}\n`);
      if (changed === 0 && result.left.length === 0) io.stdout.write("nothing to change\n");
      for (const entry of result.left) {
        io.stdout.write(`left ${entry.credentialId ?? "-"} ${entry.reason}\n`);
      }
      const reasons = [...new Set(result.left.map((entry) => entry.reason))];
      for (const reason of reasons) io.stdout.write(`${NEXT_STEP[reason] ?? ""}\n`);
      return result.left.length === 0 ? EXIT.ok : EXIT.review;
    } catch (error) {
      if (error instanceof BackendUnreadable) {
        io.stdout.write(
          "refused backend_unreadable\nnext: make OpenBao reachable and unsealed, then run this again\n",
        );
        return EXIT.review;
      }
      io.stderr.write(
        `reconcile-credentials failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    } finally {
      await pool.end();
    }
  },
};
