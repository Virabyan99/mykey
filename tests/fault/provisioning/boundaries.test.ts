// Run 3.8 Task B (FR-1.08, AC-1.06): the organization operation stopped for
// real at each of its 39 points, then run again to the end. Every time the
// clean run ends `active` with one namespace, every object equal to the plan,
// exactly one secret-id accessor per role, only the last delivered credential
// working, one operation id, and `active` exactly once in the audit trail.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizationIdSchema, type OrganizationId } from "@mykey/contracts";
import { appRoleLogin, namespaceFor, type AppRoleName } from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { ORGANIZATION_POINTS, verifyOrganization } from "@mykey/operations/operator";
import { prepareDatabase, type TestDatabase } from "../../integration/database/setup.ts";
import { baoFetch, getSharedStack, type Stack } from "../../harness/stack.ts";
import type { ProvisionJob } from "./runner.ts";

const RUNNER = resolve(import.meta.dirname, "runner.ts");
const ROLES: readonly AppRoleName[] = ["runtime", "issuer", "provisioner"];
const NO_CIDRS = { runtime: [], issuer: [], provisioner: [] };

let db: TestDatabase;
let stack: Stack;
let admin: OpenBaoAdmin;
let directory: string;

beforeAll(async () => {
  stack = await getSharedStack();
  db = await prepareDatabase({ stack });
  admin = new OpenBaoAdmin(stack.bao, stack.bao.rootToken);
  directory = mkdtempSync(join(tmpdir(), "mykey-provision-fault-"));
}, 300_000);

afterAll(async () => {
  await db.drop();
  rmSync(directory, { recursive: true, force: true });
});

function runChild(job: Omit<ProvisionJob, "maintenance" | "bao">): Promise<{
  code: number | null;
  outcome: string | null;
}> {
  const full: ProvisionJob = {
    ...job,
    maintenance: db.targets.maintenance,
    bao: { url: stack.bao.url, caCertPath: stack.bao.caCertPath, rootToken: stack.bao.rootToken },
  };
  const child = spawn(process.execPath, [RUNNER], { stdio: ["pipe", "pipe", "pipe"] });
  let outcome: string | null = null;
  createInterface({ input: child.stdout }).on("line", (line) => {
    outcome = (JSON.parse(line) as { outcome: string }).outcome;
  });
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.stdin.end(JSON.stringify(full));
  return new Promise((resolveExit) => {
    child.once("exit", (code) => {
      resolveExit({ code, outcome });
    });
  });
}

async function seedOrganization(): Promise<OrganizationId> {
  const organizationId = organizationIdSchema.parse(randomUUID());
  const superuser = db.pool("superuser");
  await superuser.query(
    "INSERT INTO app.organization (id, namespace, state) VALUES ($1, $2, 'provisioning')",
    [organizationId, namespaceFor(organizationId)],
  );
  const userId = randomUUID();
  await superuser.query(
    `INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, 'Owner', $2, true)`,
    [userId, `owner-${userId.slice(0, 8)}@mykey.invalid`],
  );
  await superuser.query(
    `INSERT INTO app.membership (id, organization_id, user_id, role, state)
     VALUES (gen_random_uuid(), $1, $2, 'owner', 'active')`,
    [organizationId, userId],
  );
  return organizationId;
}

interface DeliveredLine {
  run: number;
  name: AppRoleName;
  roleId: string;
  secretId: string;
}

describe("organization provisioning stopped at every point", () => {
  // 14 steps × 3 points; Run 6.7 added the step `incarnation`.
  it("has 42 points", () => {
    expect(ORGANIZATION_POINTS).toHaveLength(42);
  });

  for (const point of ORGANIZATION_POINTS) {
    it(`stopped at ${point}, then run again: one correct namespace`, async () => {
      const organizationId = await seedOrganization();
      const namespace = namespaceFor(organizationId);
      const deliveredFile = join(directory, `${organizationId}.jsonl`);
      try {
        const killed = await runChild({ organizationId, crashAt: point, run: 1, deliveredFile });
        expect(killed.code, point).toBe(137);
        const clean = await runChild({ organizationId, run: 2, deliveredFile });
        expect(clean, point).toEqual({ code: 0, outcome: "active" });

        const namespaces = await baoFetch(stack, "/v1/sys/namespaces?list=true");
        const keys = ((await namespaces.json()) as { data: { keys: string[] } }).data.keys;
        expect(keys.filter((key) => key === `${namespace}/`)).toHaveLength(1);
        expect(await verifyOrganization({ admin, boundCidrs: NO_CIDRS }, organizationId)).toEqual({
          differs: [],
        });

        const delivered = existsSync(deliveredFile)
          ? readFileSync(deliveredFile, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as DeliveredLine)
          : [];
        for (const name of ROLES) {
          expect(await admin.listSecretIdAccessors(namespace, name), name).toHaveLength(1);
          const mine = delivered.filter((line) => line.name === name);
          const last = mine.at(-1);
          expect(last?.run, name).toBe(2);
          for (const credential of mine) {
            const login = await appRoleLogin(
              stack.bao,
              namespace,
              credential.roleId,
              credential.secretId,
            );
            expect(login.ok, `${name} run ${String(credential.run)}`).toBe(credential === last);
          }
        }

        const superuser = db.pool("superuser");
        const operations = await superuser.query<{ state: string }>(
          "SELECT state FROM app.operation WHERE action = 'organization.provision' AND target = $1",
          [organizationId],
        );
        expect(operations.rows).toEqual([{ state: "succeeded" }]);
        const actives = await superuser.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit.event
            WHERE action = 'operator.organization_provision' AND organization_id = $1
              AND details->>'outcome' = 'active'`,
          [organizationId],
        );
        expect(actives.rows[0]?.n, point).toBe(1);
        const organization = await superuser.query<{ state: string }>(
          "SELECT state FROM app.organization WHERE id = $1",
          [organizationId],
        );
        expect(organization.rows[0]?.state).toBe("active");
      } finally {
        await baoFetch(stack, `/v1/sys/namespaces/${namespace}`, { method: "DELETE" });
      }
    }, 120_000);
  }
});
