// ops provision-organization --organization <id>   (Run 3.8, P-54, P-55)
//
// Provisions the organization's OpenBao namespace with the operator token:
// compare, then act; a foreign object stops the run for review and is never
// overwritten. Run it again after any stop: it is the reconciliation too.
// Exit 0 active, 1 retry (an unclear answer), 2 refused or already running,
// 3 review.
import { LIMITS, organizationIdSchema } from "@mykey/contracts";
import { createPool } from "@mykey/db";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { provisionOrganization } from "@mykey/operations/operator";
import { EXIT, type OpsCommand } from "../cli.ts";

export const provisionOrganizationCommand: OpsCommand = {
  flags: ["organization"],
  summary: "provision the organization's OpenBao namespace (repeat to resume or reconcile)",
  async run(flags, io) {
    const parsed = organizationIdSchema.safeParse(flags.organization);
    if (!parsed.success) {
      io.stderr.write("provision-organization: --organization <uuid> is required\n");
      return EXIT.usage;
    }
    const { database, openBao, deliver, boundCidrs } = io.env;
    if (database === undefined || openBao === undefined || deliver === undefined) {
      io.stderr.write("provision-organization: run through host.ts <host> ops (no OpenBao)\n");
      return EXIT.failed;
    }
    const pool = createPool(database, { max: LIMITS.db.opsPool });
    try {
      const result = await provisionOrganization(
        {
          pool,
          admin: new OpenBaoAdmin(openBao.target, openBao.rootToken),
          deliver,
          boundCidrs: boundCidrs ?? { runtime: [], issuer: [], provisioner: [] },
        },
        parsed.data,
      );
      switch (result.outcome) {
        case "active":
          io.stdout.write(`active organization ${parsed.data} operation ${result.operationId}\n`);
          return EXIT.ok;
        case "review":
          io.stdout.write(
            `review: ${result.step} differs from the plan; nothing was overwritten; organization needs_review (operation ${result.operationId})\n`,
          );
          return EXIT.review;
        case "retry":
          io.stdout.write(`retry: ${result.step} (${result.cause}); run the command again\n`);
          return EXIT.failed;
        case "refused":
          io.stdout.write(`refused: ${result.reason}\n`);
          return EXIT.refused;
        case "busy":
          io.stdout.write("already running\n");
          return EXIT.refused;
      }
    } catch (error) {
      io.stderr.write(
        `provision-organization failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    } finally {
      await pool.end();
    }
  },
};
