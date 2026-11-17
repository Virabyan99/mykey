// Run 6.9 Task B (P-128): a deploy whose migration fails. A rehearsal release
// adds a migration that creates a table and then raises: migrate fails, the
// table does not exist, meta.schema_migration is unchanged, and the deploy
// stops with the gate closed. Deploying the previous release again brings the
// product back open with a fresh report. Real PostgreSQL and OpenBao on a stack
// of the test's own (the shared OpenBao holds other tests' namespaces); the
// load, start and journey steps are the host's and are recorded only here.
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationReport } from "@mykey/contracts";
import { createPool, migrate, writeIncarnation } from "@mykey/db";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { readGate } from "@mykey/operations";
import { closeGate, openGate } from "@mykey/operations/operator";
import { deployVerify } from "@mykey/ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Release } from "../../../infra/release/release-schema.ts";
import {
  deployPlan,
  runDeploy,
  type DeployIo,
  type DeployState,
} from "../../../scripts/host-deploy.ts";
import { startStack, stopStack, type Stack } from "../../harness/stack.ts";
import { prepareDatabase, type TestDatabase } from "../database/setup.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
let stack: Stack;
let db: TestDatabase;
let dir: string;
const binding = {
  hostInstanceId: randomUUID(),
  backendIncarnation: randomUUID(),
  releaseBuild: "",
};

beforeAll(async () => {
  stack = await startStack();
  db = await prepareDatabase({ stack, migrate: true });
  const superPool = createPool(db.superuser, { max: 1 });
  await writeIncarnation(superPool, binding.backendIncarnation, null);
  await superPool.end();
  dir = mkdtempSync(join(tmpdir(), "mykey-failed-migration-"));
  // The rehearsal's migrations: every real one, then one that fails after creating a table.
  mkdirSync(join(dir, "rehearsal"));
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"))) {
    copyFileSync(join(MIGRATIONS, name), join(dir, "rehearsal", name));
  }
  writeFileSync(
    join(dir, "rehearsal", "0019_rehearsal_fails.sql"),
    "CREATE TABLE app.rehearsal (id int);\nSELECT 1 / 0;\n",
  );
}, 900_000);

afterAll(async () => {
  await (db as TestDatabase | undefined)?.drop();
  if ((stack as Stack | undefined) !== undefined) await stopStack(stack.project);
  rmSync(dir, { recursive: true, force: true });
}, 300_000);

const image = (c: string) => `sha256:${c.repeat(64)}`;
function release(version: string, commit: string, last: string): Release {
  return {
    format: "mykey-host-release/1",
    version,
    commit,
    builtAt: new Date().toISOString(),
    images: [
      { name: "api", imageId: image("a"), archive: "api.tar", archiveSha256: "1".repeat(64) },
      {
        name: "provisioner",
        imageId: image("b"),
        archive: "provisioner.tar",
        archiveSha256: "2".repeat(64),
      },
      { name: "ops", imageId: image("c"), archive: "ops.tar", archiveSha256: "3".repeat(64) },
    ],
    baseDigests: { node: image("d") },
    migrations: { last },
    scans: { secrets: "pass", dependencies: "pass", images: "pass" },
  };
}
const PREVIOUS = release("0.5.9", "c96b83d".padEnd(40, "0"), "0018_incarnation");
const REHEARSAL = release("0.6.1", "d1e2f3a".padEnd(40, "0"), "0019_rehearsal_fails");

/** A local DeployIo: the gate file, migrate and the report are real. */
function localIo(target: Release, migrationsDir: string, reports: VerificationReport[]) {
  let state: DeployState | null = null;
  const gatePath = join(dir, "gate.json");
  const expect = { ...binding, releaseBuild: target.commit.slice(0, 12) };
  const writer = {
    read: () => Promise.resolve(existsSync(gatePath) ? readFileSync(gatePath, "utf8") : null),
    write: (text: string) => {
      writeFileSync(`${gatePath}.tmp`, text);
      renameSync(`${gatePath}.tmp`, gatePath);
      return Promise.resolve();
    },
  };
  const maintenance = createPool(db.targets.maintenance, { max: 2 });
  const admin = new OpenBaoAdmin(stack.bao, stack.bao.rootToken);
  let previousGate: string | null = null;
  const io: DeployIo = {
    state: {
      read: () => Promise.resolve(state),
      write: (s) => {
        state = s;
        return Promise.resolve();
      },
    },
    step: async (step) => {
      switch (step) {
        case "gate_close":
          previousGate = await writer.read();
          await closeGate({
            writer,
            pool: maintenance,
            expect,
            origin: { kind: "fresh_install", id: binding.hostInstanceId },
            phase: "verifying",
            now: () => new Date(),
          });
          break;
        case "migrate":
          await migrate(db.targets.migration_owner, { dir: migrationsDir });
          if ((await admin.readIncarnation("")) === null) {
            await admin.writeIncarnation("", binding.backendIncarnation);
          }
          break;
        case "report":
          reports.push(
            await deployVerify(
              {
                pool: maintenance,
                admin,
                host: "local",
                expect,
                origin: { kind: "fresh_install", id: binding.hostInstanceId },
                schemaRevision: target.migrations.last,
                previousGate,
              },
              {
                // The journey runs against a host's listener (deploy.staging.test.ts).
                checks: {
                  journey_sign_in: { state: "ok", observed: "local" },
                  journey_reveal_digest: { state: "ok", observed: "local" },
                  journey_mutation_refused: { state: "ok", observed: "local" },
                },
              },
            ),
          );
          break;
        case "gate_open": {
          const opened = await openGate({
            writer,
            pool: maintenance,
            expect,
            report: reports.at(-1),
            kind: "deploy",
            now: () => new Date(),
          });
          if (!opened.ok) throw new Error(opened.cause);
          break;
        }
        default:
          break; // verify_release, load_images, start, journey: the host's
      }
    },
  };
  return {
    io,
    gate: () => readGate(gatePath, expect),
    close: () => maintenance.end(),
  };
}

const schemaRows = async () =>
  (
    await db
      .pool("superuser")
      .query<{ name: string }>("SELECT name FROM meta.schema_migration ORDER BY name")
  ).rows.map((r) => r.name);

describe("a deploy whose migration fails (P-128)", () => {
  it("stops with the gate closed and nothing migrated; the previous release brings the product back open", async () => {
    const reports: VerificationReport[] = [];
    // The host runs the previous release, open.
    const first = localIo(PREVIOUS, MIGRATIONS, reports);
    const plan = deployPlan({ build: "", lastMigration: "0018_incarnation" }, PREVIOUS, {
      related: true,
    });
    if (!("steps" in plan)) throw new Error(plan.refused);
    await runDeploy(first.io, PREVIOUS, plan);
    expect(first.gate().admits).toBe("all");
    await first.close();

    // The rehearsal: its migration creates a table, then raises.
    const before = await schemaRows();
    const failing = localIo(REHEARSAL, join(dir, "rehearsal"), reports);
    const rehearsalPlan = deployPlan(
      { build: PREVIOUS.commit.slice(0, 12), lastMigration: "0018_incarnation" },
      REHEARSAL,
      { related: true },
    );
    if (!("steps" in rehearsalPlan)) throw new Error(rehearsalPlan.refused);
    await expect(runDeploy(failing.io, REHEARSAL, rehearsalPlan)).rejects.toThrow();
    expect(failing.gate().admits).not.toBe("all");
    expect(await failing.io.state.read()).toMatchObject({ done: "gate_close" });
    const table = await db.pool("superuser").query("SELECT to_regclass('app.rehearsal') AS t");
    expect((table.rows[0] as { t: string | null }).t).toBeNull();
    expect(await schemaRows()).toEqual(before);
    await failing.close();

    // deploy --release <previous>: every step again, a fresh report, open.
    const back = localIo(PREVIOUS, MIGRATIONS, reports);
    const backPlan = deployPlan(
      { build: REHEARSAL.commit.slice(0, 12), lastMigration: "0018_incarnation" },
      PREVIOUS,
      { related: true },
    );
    if (!("steps" in backPlan)) throw new Error(backPlan.refused);
    await runDeploy(back.io, PREVIOUS, backPlan);
    expect(back.gate().admits).toBe("all");
    expect(reports).toHaveLength(2);
    expect(Date.parse(reports[1]!.createdAt)).toBeGreaterThanOrEqual(
      Date.parse(reports[0]!.createdAt),
    );
    expect(reports[1]!.checks.filter((c) => c.state !== "ok")).toEqual([]);
    await back.close();
  }, 600_000);
});
