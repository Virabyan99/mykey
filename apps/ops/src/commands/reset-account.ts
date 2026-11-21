import { LIMITS } from "@mykey/contracts";
// ops reset-account --email <address> --kind password|mfa   (Run 3.6, D-30)
//
// Blocks the account, ends its sessions, supersedes earlier links and issues a
// new one. The link is written to ~/.mykey/out/<timestamp>-reset-link (0600);
// only the path and the expiry are printed. Exit 0 issued, 2 refused.
import { createThrottle, loadAuthKeys } from "@mykey/auth";
import { initiateReset, resetLink } from "@mykey/auth/operator";
import { createPool } from "@mykey/db";
import { EXIT, type OpsCommand } from "../cli.ts";
import { writeSecretFile } from "../output.ts";

export const resetAccountCommand: OpsCommand = {
  flags: ["email", "kind"],
  summary: "operator reset of a lost password (--kind password) or second factor (--kind mfa)",
  async run(flags, io) {
    const { email, kind } = flags;
    if (email === undefined || (kind !== "password" && kind !== "mfa")) {
      io.stderr.write("reset-account: --email and --kind password|mfa are required\n");
      return EXIT.usage;
    }
    const { database, keysDirectory, baseUrl } = io.env;
    if (database === undefined || keysDirectory === undefined || baseUrl === undefined) {
      io.stderr.write("reset-account: run through host.ts <host> ops (no database or keys)\n");
      return EXIT.failed;
    }
    const keys = loadAuthKeys(keysDirectory);
    const pool = createPool(database, { max: LIMITS.db.opsPool });
    try {
      const result = await initiateReset(
        { pool, keys, throttle: createThrottle({ pool, ring: keys.rateLimit }) },
        { email, kind },
      );
      if (result.outcome === "refused") {
        io.stdout.write(`refused: ${result.reason}\n`);
        if (result.reason === "restored_factor") {
          // R1-2: after a restore the factor came from the pair; it is never trusted.
          io.stdout.write("the active factor is older than the restore: use --kind mfa\n");
        }
        return EXIT.refused;
      }
      const path = writeSecretFile(
        "reset-link",
        `${resetLink(baseUrl, result.token, kind)}\n`,
        io.env.home === undefined ? {} : { home: io.env.home },
      );
      io.stdout.write(
        `issued for user ${result.userId}; link in ${path}; expires ${result.expiresAt.toISOString()}\n`,
      );
      return EXIT.ok;
    } catch (error) {
      io.stderr.write(
        `reset-account failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    } finally {
      await pool.end();
    }
  },
};
