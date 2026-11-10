// Creates the five roles and sets their passwords.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { connectionConfig, type DbTarget } from "./pool.ts";

export const ROLE_NAMES = [
  "migration_owner",
  "api_runtime",
  "provisioner_runtime",
  "backup_reader",
  "maintenance",
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

const ROLES_FILE = resolve(import.meta.dirname, "../roles/roles.sql");
const MIN_PASSWORD_LENGTH = 16;
const SCRAM_ITERATIONS = 4096;
const VERIFIER_PATTERN = /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

/**
 * The value PostgreSQL stores for a SCRAM-SHA-256 password (RFC 5802). Sending
 * this instead of the password keeps the password out of the statement text,
 * and so out of the server log.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

function checkPasswords(passwords: Record<RoleName, string>): void {
  for (const role of ROLE_NAMES) {
    const password = passwords[role] as string | undefined;
    // Printable ASCII only: other characters would need SASLprep normalisation.
    if (
      password === undefined ||
      password.length < MIN_PASSWORD_LENGTH ||
      !/^[\x21-\x7e]+$/.test(password)
    ) {
      throw new Error(
        `password for role ${role} must be at least ${MIN_PASSWORD_LENGTH} printable ASCII characters without spaces`,
      );
    }
  }
}

/**
 * Creates the five roles (idempotent), sets their passwords, and makes
 * `migration_owner` the owner of the database `superuser` connects to.
 *
 * Roles are shared by every database of the server, so the whole change runs
 * in one transaction that holds a lock on the role catalog: two callers, even
 * in different databases, run one after the other.
 */
export async function applyRoles(
  superuser: DbTarget,
  passwords: Record<RoleName, string>,
): Promise<void> {
  checkPasswords(passwords);
  const rolesSql = readFileSync(ROLES_FILE, "utf8");
  const client = new pg.Client(connectionConfig(superuser));
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE");
      await client.query(rolesSql);
      for (const role of ROLE_NAMES) {
        const verifier = scramSha256Verifier(passwords[role]);
        if (!VERIFIER_PATTERN.test(verifier)) throw new Error("unexpected verifier format");
        // Role names are the constants above and the verifier matches the pattern
        // above, so neither can break out of the statement.
        await client.query(`ALTER ROLE ${role} PASSWORD '${verifier}'`);
      }
      await client.query(
        `DO $owner$ BEGIN
           EXECUTE format('ALTER DATABASE %I OWNER TO migration_owner', current_database());
         END $owner$`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end();
  }
}
