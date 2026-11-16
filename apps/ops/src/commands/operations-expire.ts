import { LIMITS } from "@mykey/contracts";
// ops operations-expire   (Run 4.1, P-65): terminal operations whose replay
// record has expired get a tombstone and lose their fingerprint, expected
// state and result; the rows stay. Unfinished operations never expire. One
// transaction as `maintenance`, one audit row. Prints the count. The host
// timer that runs it is Run 6.9.
import { randomUUID } from "node:crypto";
import { appendAudit } from "@mykey/audit";
import { createPool, expireOperations, withTransaction } from "@mykey/db";
import { EXIT, type OpsCommand } from "../cli.ts";

export const operationsExpireCommand: OpsCommand = {
  flags: [],
  summary: "expire terminal operation records past their replay window (maintenance)",
  async run(_flags, io) {
    if (io.env.database === undefined) {
      io.stderr.write("operations-expire: run through host.ts <host> ops (no database)\n");
      return EXIT.failed;
    }
    const pool = createPool(io.env.database, { max: LIMITS.db.opsPool });
    try {
      const expired = await withTransaction(pool, async (tx) => {
        const count = await expireOperations(tx);
        await appendAudit(tx, {
          action: "operator.operations_expire",
          actor: { kind: "operator", id: null },
          source: "operator",
          organizationId: null,
          target: null,
          outcome: "success",
          requestId: randomUUID(),
          operationId: null,
          details: { expired: count },
        });
        return count;
      });
      io.stdout.write(`expired ${String(expired)}\n`);
      return EXIT.ok;
    } catch (error) {
      io.stderr.write(
        `operations-expire failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    } finally {
      await pool.end();
    }
  },
};
