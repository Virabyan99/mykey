// ops reconcile-operation --operation <id> [--executors-excluded yes] [--close-unknown yes]
// (Run 4.5, P-75, D-38; runbook reconciliation.md)
//
// Settles one unresolved secret operation from the backend's evidence. Exit 0
// with the verdict that settled it (succeeded, rejected, closed_unknown); exit
// 3 (review) when the evidence does not decide, with the reason and the next
// step; exit 2 for an unknown operation. `--executors-excluded yes` is the
// operator's statement that no API process can still send the change
// (`host.ts <host> quiesce`). Never prints a value.
import { randomUUID } from "node:crypto";
import { operationIdSchema } from "@mykey/contracts";
import { createPool, findOperation } from "@mykey/db";
import { OpenBaoClient, namespaceFor } from "@mykey/openbao";
import { Busy } from "@mykey/operations";
import { reconcileOperation } from "@mykey/operations/operator";
import { EXIT, type OpsCommand } from "../cli.ts";

const NEXT_STEP: Record<string, string> = {
  executors_not_excluded:
    "next: host.ts <host> quiesce, then reconcile-operation --executors-excluded yes, then resume and gate open",
  evidence_conflict:
    "next: read the key's versions with the operator token; when no executor can run, --executors-excluded yes --close-unknown yes closes it as unknown",
  backend_unreadable: "next: make OpenBao reachable and unsealed, then run this again",
  not_unresolved:
    "nothing to settle: the operation is finished, or still running inside its heartbeat",
};

/** A yes/no flag: absent is no, `yes` is yes, anything else is a usage error (null). */
const yes = (value: string | undefined): boolean | null =>
  value === undefined ? false : value === "yes" ? true : null;

export const reconcileOperationCommand: OpsCommand = {
  flags: ["operation", "executors-excluded", "close-unknown"],
  summary: "settle an unresolved operation from the backend's evidence (runbook reconciliation.md)",
  async run(flags, io) {
    const parsed = operationIdSchema.safeParse(flags.operation);
    const executorsExcluded = yes(flags["executors-excluded"]);
    const closeUnknown = yes(flags["close-unknown"]);
    if (!parsed.success || executorsExcluded === null || closeUnknown === null) {
      io.stderr.write(
        "reconcile-operation: --operation <uuid> [--executors-excluded yes] [--close-unknown yes]\n",
      );
      return EXIT.usage;
    }
    const { database, openBao } = io.env;
    if (database === undefined || openBao === undefined) {
      io.stderr.write(
        "reconcile-operation: run through host.ts <host> ops (no database or OpenBao)\n",
      );
      return EXIT.failed;
    }
    const pool = createPool(database, { max: 2 });
    try {
      const row = await findOperation(pool, parsed.data);
      if (row === null) {
        io.stderr.write(`reconcile-operation: no operation ${parsed.data}\n`);
        return EXIT.refused;
      }
      if (row.organizationId === null) {
        io.stdout.write(`undetermined ${row.id} not_unresolved\n${NEXT_STEP.not_unresolved}\n`);
        return EXIT.review;
      }
      const bao = new OpenBaoClient(openBao.target, {
        namespace: namespaceFor(row.organizationId),
        token: openBao.rootToken,
      });
      const verdict = await reconcileOperation(
        { database: pool, bao, operatorId: null, requestId: randomUUID() },
        row.id,
        { executorsExcluded, closeUnknown },
      );
      switch (verdict.kind) {
        case "succeeded":
          io.stdout.write(`succeeded ${row.id} version ${String(verdict.version)}\n`);
          return EXIT.ok;
        case "rejected":
        case "closed_unknown":
          io.stdout.write(`${verdict.kind} ${row.id}\n`);
          return EXIT.ok;
        case "undetermined":
          io.stdout.write(
            `undetermined ${row.id} ${verdict.reason}\n${NEXT_STEP[verdict.reason] ?? ""}\n`,
          );
          return EXIT.review;
      }
    } catch (error) {
      if (error instanceof Busy) {
        io.stderr.write("reconcile-operation: the environment is busy; run it again\n");
        return EXIT.failed;
      }
      io.stderr.write(
        `reconcile-operation failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    } finally {
      await pool.end();
    }
  },
};
