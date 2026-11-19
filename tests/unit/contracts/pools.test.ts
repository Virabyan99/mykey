// Run 6.3 Task B (P-114, Doc 06 §11): every connection the product can open
// to PostgreSQL fits the server's `max_connections`. Two API processes (each:
// its pool, its lock pool, its health connection), the provisioner, one ops
// container per job of the host's job table at once, and the superuser
// reserve; the host's postgresql.conf holds LIMITS.db.maxConnections.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CONNECTIONS } from "@mykey/api";
import { LIMITS } from "@mykey/contracts";
import { PROVISIONER_CONNECTIONS } from "@mykey/provisioner";
import { describe, expect, it } from "vitest";
import { readOpsJobs } from "../../../scripts/ops-jobs.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const setting = (text: string, name: string): number | null => {
  const match = new RegExp(`^${name}\\s*=\\s*(\\d+)`, "m").exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
};

describe("connections (P-114)", () => {
  it("one API process opens at most LIMITS.db.apiPool, its health connection included", () => {
    const { pool, lockPool, health } = API_CONNECTIONS;
    expect(pool + lockPool + health).toBe(LIMITS.db.apiPool);
  });

  it("the provisioner's pool is LIMITS.db.provisionerPool", () => {
    expect(PROVISIONER_CONNECTIONS).toBe(LIMITS.db.provisionerPool);
  });

  it("every ops command's pool is LIMITS.db.opsPool", () => {
    const directory = join(ROOT, "apps", "ops", "src", "commands");
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(join(directory, file), "utf8");
      for (const call of text.matchAll(/createPool\([^)]*\)/g)) {
        expect(call[0], file).toContain("LIMITS.db.opsPool");
      }
    }
  });

  it("the sum of all pools is at most the server's max_connections, which is LIMITS.db.maxConnections", () => {
    const conf = readFileSync(join(ROOT, "infra", "compose", "host", "postgresql.conf"), "utf8");
    const max = setting(conf, "max_connections");
    expect(max).toBe(LIMITS.db.maxConnections);
    const reserve = setting(conf, "superuser_reserved_connections") ?? 3;
    const opsContainers = Object.keys(readOpsJobs().jobs).length;
    const total =
      LIMITS.concurrency.apiProcesses * LIMITS.db.apiPool +
      PROVISIONER_CONNECTIONS +
      opsContainers * LIMITS.db.opsPool +
      reserve;
    expect(total).toBeLessThanOrEqual(LIMITS.db.maxConnections);
  });
});
