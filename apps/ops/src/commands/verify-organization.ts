// ops verify-organization --organization <id>   (Run 3.8, P-55)
//
// The read-only half of provisioning: every object of the namespace read back
// with the operator token and compared with the plan; nothing is written.
// Prints `equal` (exit 0) or the names of the objects that differ (exit 3).
import { organizationIdSchema } from "@mykey/contracts";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { verifyOrganization } from "@mykey/operations/operator";
import { EXIT, type OpsCommand } from "../cli.ts";

export const verifyOrganizationCommand: OpsCommand = {
  flags: ["organization"],
  summary: "compare the organization's OpenBao objects with the plan; writes nothing",
  async run(flags, io) {
    const parsed = organizationIdSchema.safeParse(flags.organization);
    if (!parsed.success) {
      io.stderr.write("verify-organization: --organization <uuid> is required\n");
      return EXIT.usage;
    }
    const { openBao, boundCidrs } = io.env;
    if (openBao === undefined) {
      io.stderr.write("verify-organization: run through host.ts <host> ops (no OpenBao)\n");
      return EXIT.failed;
    }
    try {
      const { differs } = await verifyOrganization(
        {
          admin: new OpenBaoAdmin(openBao.target, openBao.rootToken),
          boundCidrs: boundCidrs ?? { runtime: [], issuer: [], provisioner: [] },
        },
        parsed.data,
      );
      if (differs.length === 0) {
        io.stdout.write("equal\n");
        return EXIT.ok;
      }
      io.stdout.write(`differs: ${differs.join(", ")}\n`);
      return EXIT.review;
    } catch (error) {
      io.stderr.write(
        `verify-organization failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    }
  },
};
