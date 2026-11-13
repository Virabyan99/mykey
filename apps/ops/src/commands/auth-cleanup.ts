// ops auth-cleanup   (Run 3.5): removes used TOTP steps older than a day,
// consumed recovery codes and codes of retired enrollments. Prints the counts.
import { cleanUpFactors } from "@mykey/auth/operator";
import { createPool } from "@mykey/db";
import { EXIT, type OpsCommand } from "../cli.ts";

export const authCleanupCommand: OpsCommand = {
  flags: [],
  summary: "remove spent TOTP steps and recovery codes (maintenance)",
  async run(_flags, io) {
    if (io.env.database === undefined) {
      io.stderr.write("auth-cleanup: run through host.ts <host> ops (no database)\n");
      return EXIT.failed;
    }
    const pool = createPool(io.env.database, { max: 1 });
    try {
      const removed = await cleanUpFactors(pool);
      io.stdout.write(`steps ${String(removed.steps)} codes ${String(removed.codes)}\n`);
      return EXIT.ok;
    } catch (error) {
      io.stderr.write(
        `auth-cleanup failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    } finally {
      await pool.end();
    }
  },
};
