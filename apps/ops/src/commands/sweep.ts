// ops sweep   (Run 6.9, P-129): the PostgreSQL-only sweeps once — the stale
// secret and credential operations — as maintenance, for the minutes the API
// (whose own sweep runs every 30 s) is down. The archives need OpenBao and
// stay with the API. While a pair is captured (the mode is not idle) it does
// nothing (P-118). The host timer mykey-sweep runs it every 5 minutes.
import { LIMITS } from "@mykey/contracts";
import { captureMode, createPool } from "@mykey/db";
import { sweepCredentials, sweepStaleOperations } from "@mykey/operations";
import { EXIT, type OpsCommand } from "../cli.ts";

export const sweepCommand: OpsCommand = {
  flags: [],
  summary: "settle stale operations once, as the API's sweep does (maintenance)",
  async run(_flags, io) {
    if (io.env.database === undefined) {
      io.stderr.write("sweep: run through host.ts <host> ops (no database)\n");
      return EXIT.failed;
    }
    const pool = createPool(io.env.database, { max: LIMITS.db.opsPool });
    try {
      if ((await captureMode(pool)).mode !== "idle") {
        io.stdout.write("skipped: capture\n");
        return EXIT.ok;
      }
      const secrets = await sweepStaleOperations(pool);
      const credentials = await sweepCredentials(pool);
      const uncertain = secrets.uncertain.length + credentials.uncertain.length;
      io.stdout.write(
        `swept: uncertain ${String(uncertain)}, rejected ${String(secrets.rejected.length)}\n`,
      );
      return EXIT.ok;
    } catch (error) {
      io.stderr.write(`sweep: ${error instanceof Error ? error.constructor.name : "error"}\n`);
      return EXIT.failed;
    } finally {
      await pool.end();
    }
  },
};
