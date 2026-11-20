// Run 8.0 Task B (P-147, D-64): the first opening of a host with a real owner,
// and every later deploy of one. Production never holds a workstation copy of
// the owner's password or authenticator, so the owner does the journey in
// their own browser (`tunnel verify`) and the deploy records it as confirmed.
// A host with no secret yet has nothing to reveal: the reveal check says so,
// counted in the database. A standalone `gate open --report` takes a deploy
// report only and runs the four store checks again before it writes.
// Real PostgreSQL and OpenBao on a stack of the test's own: the store checks
// read every namespace of OpenBao, and the shared one holds other tests'.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationReport } from "@mykey/contracts";
import { createPool, writeIncarnation } from "@mykey/db";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { readGate } from "@mykey/operations";
import { closeGate, type GateWriter } from "@mykey/operations/operator";
import { deployVerify, openWithDeployReport, ownerConfirmedJourney } from "@mykey/ops";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, stopStack, type Stack } from "../../harness/stack.ts";
import { prepareDatabase, type TestDatabase } from "../database/setup.ts";

let stack: Stack;
let db: TestDatabase;
let dir: string;
let maintenance: pg.Pool;
let admin: OpenBaoAdmin;
let lastMigration: string;
const expectBinding = {
  hostInstanceId: randomUUID(),
  backendIncarnation: randomUUID(),
  releaseBuild: "0123456789ab",
};
const origin = { kind: "fresh_install" as const, id: expectBinding.hostInstanceId };

beforeAll(async () => {
  stack = await startStack();
  db = await prepareDatabase({ stack, migrate: true });
  const superPool = createPool(db.superuser, { max: 1 });
  await writeIncarnation(superPool, expectBinding.backendIncarnation, null);
  await superPool.end();
  admin = new OpenBaoAdmin(stack.bao, stack.bao.rootToken);
  await admin.writeIncarnation("", expectBinding.backendIncarnation);
  maintenance = createPool(db.targets.maintenance, { max: 2 });
  lastMigration = (
    await db
      .pool("superuser")
      .query<{ name: string }>("SELECT name FROM meta.schema_migration ORDER BY name DESC LIMIT 1")
  ).rows[0]!.name.replace(/\.sql$/, "");
  dir = mkdtempSync(join(tmpdir(), "mykey-first-opening-"));
}, 900_000);

afterAll(async () => {
  await (maintenance as pg.Pool | undefined)?.end();
  await (db as TestDatabase | undefined)?.drop();
  if ((stack as Stack | undefined) !== undefined) await stopStack(stack.project);
  if ((dir as string | undefined) !== undefined) rmSync(dir, { recursive: true, force: true });
}, 300_000);

/** A gate file of the test's own, closed by a deploy (phase verifying). */
async function closedGate(): Promise<{ writer: GateWriter; path: string }> {
  const path = join(dir, `gate-${randomUUID()}.json`);
  const writer: GateWriter = {
    read: () => Promise.resolve(existsSync(path) ? readFileSync(path, "utf8") : null),
    write: (text) => {
      writeFileSync(`${path}.tmp`, text);
      renameSync(`${path}.tmp`, path);
      return Promise.resolve();
    },
  };
  await closeGate({
    writer,
    pool: maintenance,
    expect: expectBinding,
    origin,
    phase: "verifying",
    now: () => new Date(),
  });
  return { writer, path };
}

async function report(
  writer: GateWriter,
  journey: Parameters<typeof deployVerify>[1],
  schemaRevision = lastMigration,
): Promise<VerificationReport> {
  return deployVerify(
    {
      pool: maintenance,
      admin,
      host: "local",
      expect: expectBinding,
      origin,
      schemaRevision,
      previousGate: await writer.read(),
    },
    journey,
  );
}

const byId = (r: VerificationReport) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

/** One organization, project and environment as rows, and one secret in the index. */
async function seedOneSecret(): Promise<() => Promise<void>> {
  const su = db.pool("superuser");
  const [organization, project, environment] = [randomUUID(), randomUUID(), randomUUID()];
  await su.query("INSERT INTO app.organization (id, namespace, state) VALUES ($1, $2, 'active')", [
    organization,
    `org-${organization}`,
  ]);
  await su.query(
    "INSERT INTO app.project (id, organization_id, name, state) VALUES ($1, $2, 'shop', 'active')",
    [project, organization],
  );
  await su.query(
    "INSERT INTO app.environment (id, organization_id, project_id, name, state) VALUES ($1, $2, $3, 'production', 'active')",
    [environment, organization, project],
  );
  await su.query(
    "INSERT INTO app.secret_index (environment_id, name, organization_id, state_tag, state, last_changed_at) VALUES ($1, 'API_KEY', $2, 'tag-1', 'live', now())",
    [environment, organization],
  );
  return async () => {
    await su.query("DELETE FROM app.secret_index WHERE organization_id = $1", [organization]);
    await su.query("DELETE FROM app.environment WHERE organization_id = $1", [organization]);
    await su.query("DELETE FROM app.project WHERE organization_id = $1", [organization]);
    await su.query("DELETE FROM app.organization WHERE id = $1", [organization]);
  };
}

describe("the first opening of a host with a real owner (P-147)", () => {
  it('a host with an enrolled owner and no secret: the report\'s eight checks are ok, the reveal check says "no secret in the index", and the gate opens', async () => {
    const { writer, path } = await closedGate();
    const made = await report(writer, ownerConfirmedJourney());
    expect(made.checks).toHaveLength(8);
    expect(made.checks.filter((c) => c.state !== "ok")).toEqual([]);
    expect(byId(made).journey_reveal_digest).toMatchObject({
      state: "ok",
      observed: "no secret in the index",
    });
    const opened = await openWithDeployReport({
      writer,
      pool: maintenance,
      admin,
      expect: expectBinding,
      report: made,
      now: () => new Date(),
    });
    expect(opened).toMatchObject({ ok: true });
    expect(readGate(path, expectBinding).admits).toBe("all");
  });

  it("with one secret in the index and no journey the reveal check is not ok and the gate stays closed", async () => {
    const unseed = await seedOneSecret();
    try {
      const { writer, path } = await closedGate();
      const made = await report(writer, null);
      expect(byId(made).journey_reveal_digest?.state).not.toBe("ok");
      const opened = await openWithDeployReport({
        writer,
        pool: maintenance,
        admin,
        expect: expectBinding,
        report: made,
        now: () => new Date(),
      });
      expect(opened.ok).toBe(false);
      expect(readGate(path, expectBinding).admits).not.toBe("all");
    } finally {
      await unseed();
    }
  });

  it("owner-confirmed records the three journey checks as confirmed by the owner, and the report still fails when a store check fails", async () => {
    const unseed = await seedOneSecret();
    try {
      const { writer } = await closedGate();
      const confirmed = await report(writer, ownerConfirmedJourney());
      for (const id of ["journey_sign_in", "journey_reveal_digest", "journey_mutation_refused"]) {
        expect(byId(confirmed)[id], id).toMatchObject({
          state: "ok",
          observed: "owner confirmed (--owner-confirmed)",
        });
      }
      const stale = await report(writer, ownerConfirmedJourney(), "0000_not_this_schema");
      expect(byId(stale).schema_revision?.state).toBe("failed");
      expect(byId(stale).journey_sign_in?.observed).toBe("owner confirmed (--owner-confirmed)");
    } finally {
      await unseed();
    }
  });
});

describe("a standalone gate open --report (P-147 d)", () => {
  it("a standalone open with a deploy report whose control row is no longer idle is refused, and the gate stays closed", async () => {
    const { writer, path } = await closedGate();
    const made = await report(writer, ownerConfirmedJourney());
    expect(made.checks.filter((c) => c.state !== "ok")).toEqual([]);
    const su = db.pool("superuser");
    await su.query("UPDATE app.service_control SET capture_mode = 'draining', owner = 'test'");
    try {
      const opened = await openWithDeployReport({
        writer,
        pool: maintenance,
        admin,
        expect: expectBinding,
        report: made,
        now: () => new Date(),
      });
      expect(opened).toMatchObject({ ok: false });
      expect(opened.ok ? "" : opened.cause).toMatch(/control_row_idle/);
      expect(readGate(path, expectBinding).admits).not.toBe("all");
    } finally {
      await su.query("UPDATE app.service_control SET capture_mode = 'idle', owner = NULL");
    }
  });

  it("a standalone open with a restore report is refused and names restore-verify --open", async () => {
    const { writer, path } = await closedGate();
    const made = await report(writer, ownerConfirmedJourney());
    const restoreReport = {
      ...made,
      origin: { kind: "restore", pairId: randomUUID() },
    };
    const opened = await openWithDeployReport({
      writer,
      pool: maintenance,
      admin,
      expect: expectBinding,
      report: restoreReport,
      now: () => new Date(),
    });
    expect(opened).toMatchObject({ ok: false });
    expect(opened.ok ? "" : opened.cause).toContain("restore-verify --open");
    expect(readGate(path, expectBinding).admits).not.toBe("all");
  });
});
