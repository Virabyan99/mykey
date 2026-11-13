// ops bootstrap-owner --email <address>   (Run 3.2, D-27)
//
// The password is read from stdin (one line) and never printed. Prints the
// outcome and the two ids. Exit 0 for `created` and `already_present`, 2 for
// `refused`, 1 when the command could not run.
import { createAuth, loadAuthKeys } from "@mykey/auth";
import { bootstrapOwner } from "@mykey/auth/operator";
import { createPool } from "@mykey/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { EXIT, readSecretLine, type OpsCommand } from "../cli.ts";

export const bootstrapOwnerCommand: OpsCommand = {
  flags: ["email"],
  summary: "create the first owner and its organization; the password on stdin",
  async run(flags, io) {
    const email = flags.email;
    if (email === undefined) {
      io.stderr.write("bootstrap-owner: --email is required\n");
      return EXIT.usage;
    }
    const { database, keysDirectory, baseUrl } = io.env;
    if (database === undefined || keysDirectory === undefined || baseUrl === undefined) {
      io.stderr.write("bootstrap-owner: run through host.ts <host> ops (no database or keys)\n");
      return EXIT.failed;
    }
    const password = await readSecretLine(io.stdin);
    const pool = createPool(database, { max: 2 });
    try {
      const auth = createAuth({
        db: drizzle(pool),
        keys: loadAuthKeys(keysDirectory),
        baseURL: baseUrl,
      });
      const result = await bootstrapOwner({ auth, pool }, { email, password });
      if (result.outcome === "refused") {
        io.stdout.write(`refused: ${result.reason}\n`);
        return EXIT.refused;
      }
      io.stdout.write(
        `${result.outcome} user ${result.userId} organization ${result.organizationId}\n`,
      );
      return EXIT.ok;
    } catch (error) {
      // The class only: a database message could quote input.
      io.stderr.write(
        `bootstrap-owner failed: ${error instanceof Error ? error.constructor.name : "error"}\n`,
      );
      return EXIT.failed;
    } finally {
      await pool.end();
    }
  },
};
