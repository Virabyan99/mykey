// `ops capture --step begin|record|abort` (Run 6.5, P-118, P-120, D-51): the
// coordinator of a paired capture, as maintenance. backup.sh calls begin, takes
// the artifacts, writes the manifest and calls record; its ExecStopPost and the
// boot unit call abort. begin prints one JSON line { pairId, captureStartedAt,
// boundary } and exits 75 (EX_TEMPFAIL) when another capture runs or the
// drain did not finish in 30 s.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "@mykey/contracts";
import { createPool } from "@mykey/db";
import {
  abortCapture,
  beginCapture,
  recordCapture,
  type CaptureRecord,
} from "@mykey/operations/operator";
import { EXIT, type OpsCommand } from "../cli.ts";

/** EX_TEMPFAIL: a capture is not possible now; the timer tries again. */
export const CAPTURE_BUSY = 75;

const STEPS = ["begin", "record", "abort"] as const;
type Step = (typeof STEPS)[number];

export const captureCommand: OpsCommand = {
  flags: ["step", "owner", "pair", "manifest", "reason"],
  summary:
    "a paired capture: --step begin (prints the pair), record --pair <id> --manifest <file>, abort [--reason deadline]",
  async run(flags, io) {
    const step = flags.step as Step | undefined;
    if (step === undefined || !STEPS.includes(step)) {
      io.stderr.write("capture: --step begin|record|abort\n");
      return EXIT.usage;
    }
    if (io.env.database === undefined) {
      io.stderr.write("capture: runs as a host job (backup.sh)\n");
      return EXIT.failed;
    }
    const owner = flags.owner ?? "backup";
    const pool = createPool(io.env.database, { max: LIMITS.db.opsPool });
    try {
      if (step === "begin") {
        const result = await beginCapture(pool, owner);
        if (result.kind === "busy") {
          io.stderr.write(`capture: busy (${result.reason})\n`);
          return CAPTURE_BUSY;
        }
        io.stdout.write(
          `${JSON.stringify({
            pairId: result.pairId,
            captureStartedAt: result.captureStartedAt.toISOString(),
            boundary: result.boundary,
          })}\n`,
        );
        return EXIT.ok;
      }
      if (step === "record") {
        const pairId = flags.pair;
        const path = flags.manifest;
        if (pairId === undefined || path === undefined) {
          io.stderr.write("capture: record needs --pair and --manifest\n");
          return EXIT.usage;
        }
        const record = JSON.parse(readFileSync(path, "utf8")) as CaptureRecord;
        await recordCapture(pool, pairId, record);
        io.stdout.write(`recorded ${pairId}\n`);
        return EXIT.ok;
      }
      const reason = flags.reason === "deadline" ? "deadline" : "aborted";
      const released = await abortCapture(pool, owner, reason);
      // Session 2 M2: the artifacts of a capture that did not finish do not stay.
      if (released.released && released.pairId !== null && io.env.pairScratch !== undefined) {
        rmSync(join(io.env.pairScratch, released.pairId), { recursive: true, force: true });
      }
      io.stdout.write(
        released.released
          ? `released ${released.pairId ?? "no pair"}\n`
          : released.pairId === null
            ? "nothing to release: idle\n"
            : `nothing to release: ${released.pairId} is another owner's\n`,
      );
      return EXIT.ok;
    } catch (error) {
      io.stderr.write(
        `capture ${step} failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    } finally {
      await pool.end();
    }
  },
};
