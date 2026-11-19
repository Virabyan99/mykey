// ops operations --organization <id>   (Run 4.5, P-75)
//
// One line per unresolved operation of the organization — uncertain and not
// closed, or accepted/executing with a stale heartbeat: id, action,
// environment, name, state, age. `none` when there is none. Reads only.
import { LIMITS, organizationIdSchema } from "@mykey/contracts";
import { createPool, listUnresolved } from "@mykey/db";
import { EXIT, type OpsCommand } from "../cli.ts";

export const operationsCommand: OpsCommand = {
  flags: ["organization"],
  summary: "list the organization's unresolved operations (reads only)",
  async run(flags, io) {
    const parsed = organizationIdSchema.safeParse(flags.organization);
    if (!parsed.success) {
      io.stderr.write("operations: --organization <uuid> is required\n");
      return EXIT.usage;
    }
    if (io.env.database === undefined) {
      io.stderr.write("operations: run through host.ts <host> ops (no database)\n");
      return EXIT.failed;
    }
    const pool = createPool(io.env.database, { max: LIMITS.db.opsPool });
    try {
      const rows = await listUnresolved(pool, parsed.data);
      if (rows.length === 0) io.stdout.write("none\n");
      for (const row of rows) {
        const line = [
          row.id,
          row.action,
          row.environmentId ?? "-",
          row.secretName ?? "-",
          row.stale ? `${row.state} (stale)` : row.state,
          `${String(row.ageSeconds)}s`,
        ];
        io.stdout.write(`${line.join(" ")}\n`);
      }
      return EXIT.ok;
    } catch (error) {
      io.stderr.write(
        `operations failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    } finally {
      await pool.end();
    }
  },
};
