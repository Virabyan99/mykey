// Applies the roles and every pending migration to the local development stack.
// Run: pnpm run db:migrate   (starts the stack first if it is not running)
//
// Development only. Role passwords are generated once and kept in
// .stack/mykey-dev/db-role-passwords.json (git-ignored). They are never printed.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_NAMES, applyRoles, migrate, type DbTarget, type RoleName } from "@mykey/db";
import { DEV_PROJECT, stackDirectory, startStack } from "../tests/harness/stack.ts";

function rolePasswords(file: string): Record<RoleName, string> {
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Record<RoleName, string>;
  const fresh = (): string => randomBytes(24).toString("base64url");
  const passwords: Record<RoleName, string> = {
    migration_owner: fresh(),
    api_runtime: fresh(),
    provisioner_runtime: fresh(),
    backup_reader: fresh(),
    maintenance: fresh(),
  };
  writeFileSync(file, `${JSON.stringify(passwords, null, 2)}\n`, { mode: 0o600 });
  return passwords;
}

if (import.meta.main) {
  const stack = await startStack({ project: DEV_PROJECT, fixedPorts: true });
  const base = {
    host: stack.pg.host,
    port: stack.pg.port,
    database: stack.pg.database,
    caCertPath: stack.pg.caCertPath,
  };
  const passwords = rolePasswords(join(stackDirectory(DEV_PROJECT), "db-role-passwords.json"));
  const superuser: DbTarget = { ...base, ...stack.pg.superuser };
  await applyRoles(superuser, passwords);
  const owner: DbTarget = { ...base, user: "migration_owner", password: passwords.migration_owner };
  const result = await migrate(owner);
  console.log(`roles: ${ROLE_NAMES.join(", ")}`);
  console.log(`applied: ${result.applied.length === 0 ? "nothing" : result.applied.join(", ")}`);
  console.log(`already applied: ${String(result.alreadyApplied.length)}`);
}
