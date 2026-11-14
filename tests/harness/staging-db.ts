// The staging database as a TestDatabase (Run 2.9): the real `postgres`
// database of staging through the tunnel, logged in with the real role
// passwords. Roles belong to the whole server, so nothing here ever runs
// applyRoles (that would change the passwords the API and the operator use).
// `drop()` only closes the pools; nothing is removed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPool, ROLE_NAMES, type DbTarget } from "@mykey/db";
import type pg from "pg";
import type { Login, RoleName, TestDatabase } from "../integration/database/setup.ts";
import type { Stack } from "./stack.ts";
import { expectSuccess, registerSecret, sshExec, type StagingStack } from "./staging.ts";

// The runtime roles' passwords live only on the host (the workstation copies of
// provisioner_runtime were shredded in Run 4.10); the other roles' on the workstation.
const ON_HOST: Partial<Record<RoleName, string>> = {
  api_runtime: "/etc/mykey/secrets/api/db-password",
  provisioner_runtime: "/etc/mykey/secrets/provisioner/db-password",
};

export async function stagingDatabase(staging: StagingStack): Promise<TestDatabase> {
  const base = {
    host: staging.pg.host,
    port: staging.pg.port,
    database: "postgres",
    caCertPath: staging.pg.caCertPath,
  };
  const passwords = {} as Record<RoleName, string>;
  for (const role of ROLE_NAMES) {
    const onHost = ON_HOST[role];
    if (onHost !== undefined) {
      passwords[role] = expectSuccess(
        await sshExec(staging.host, `cat ${onHost}`, {
          sudo: true,
          secretOutput: true,
        }),
        `reading the ${role} password`,
      ).stdout.trim();
    } else {
      passwords[role] = readFileSync(
        join(homedir(), ".mykey", "secrets", "hosts", "staging", role),
        "utf8",
      ).trim();
      registerSecret(passwords[role]);
    }
  }
  const superuser: DbTarget = { ...base, ...staging.pg.superuser };
  const targets = Object.fromEntries(
    ROLE_NAMES.map((role) => [role, { ...base, user: role, password: passwords[role] }]),
  ) as Record<RoleName, DbTarget>;
  const pools = new Map<Login, pg.Pool>();
  return {
    stack: staging as unknown as Stack,
    database: "postgres",
    superuser,
    targets,
    pool(login) {
      let pool = pools.get(login);
      if (pool === undefined) {
        pool = createPool(login === "superuser" ? superuser : targets[login], { max: 2 });
        pools.set(login, pool);
      }
      return pool;
    },
    drop: async () => {
      await Promise.all([...pools.values()].map((pool) => pool.end()));
      pools.clear();
    },
  };
}
