// Run 6.7 Task A (P-122, D-54): the gate is bound to the database's
// incarnation too, and the record is written in the right order. A gate
// opens only after operator.gate_open is in the audit table; it closes with
// PostgreSQL stopped.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { REQUIRED_CHECKS, type VerificationReport } from "@mykey/contracts";
import { readGate } from "@mykey/operations";
import { closeGate, openGate, type GateWriter } from "@mykey/operations/operator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApi, type TestApi } from "../../harness/api.ts";
import { setIncarnation } from "../../harness/gate.ts";
import { prepareDatabase, type TestDatabase } from "../database/setup.ts";

describe("the API's gate and the database's incarnation (P-122)", () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await startTestApi();
  }, 300_000);
  afterAll(async () => {
    await api.close();
  });

  it("the database's incarnation differs from the expected one → every product route answers quarantined although the file says open", async () => {
    expect((await api.request("GET", "/v1/version")).status).toBe(200);
    await setIncarnation(api.superuser, randomUUID());
    await sleep(5_200); // the API reuses its reading for 5 s
    const refused = await api.request("GET", "/v1/version");
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("quarantined");
    expect((await api.request("GET", "/health")).status).toBe(503);
    expect(api.logs.some((e) => e.event === "gate_closed" && e.cause === "incarnation")).toBe(true);
    await setIncarnation(api.superuser, api.gate.backendIncarnation);
    await sleep(5_200);
    expect((await api.request("GET", "/v1/version")).status).toBe(200);
  }, 60_000);
});

describe("gate open and gate close (P-122)", () => {
  let db: TestDatabase;
  let dir: string;
  const expect3 = {
    hostInstanceId: randomUUID(),
    backendIncarnation: randomUUID(),
    releaseBuild: "abcdef123456",
  };
  const fileWriter = (path: string): GateWriter => ({
    read: () => Promise.resolve(existsSync(path) ? readFileSync(path, "utf8") : null),
    write: (text) => {
      writeFileSync(`${path}.tmp`, text);
      renameSync(`${path}.tmp`, path);
      return Promise.resolve();
    },
  });
  const report = (): VerificationReport => ({
    format: "mykey-verification/1",
    host: "local",
    ...expect3,
    origin: { kind: "fresh_install", id: randomUUID() },
    createdAt: new Date().toISOString(),
    checks: REQUIRED_CHECKS.deploy.map((id) => ({ id, state: "ok", observed: "test" })),
    members: 1,
  });
  const events = async (action: string): Promise<{ gateEpoch: number }[]> =>
    (
      await db.pool("superuser").query<{
        details: { gateEpoch: number };
      }>("SELECT details FROM audit.event WHERE action = $1 ORDER BY occurred_at", [action])
    ).rows.map((r) => r.details);

  beforeAll(async () => {
    db = await prepareDatabase({ migrate: true });
    dir = mkdtempSync(join(tmpdir(), "mykey-gate-write-"));
  }, 300_000);
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  });

  it("gate open writes operator.gate_open before the file, and the file names the report's hash", async () => {
    const path = join(dir, "open.json");
    const writer = fileWriter(path);
    const closed = await closeGate({
      writer,
      pool: db.pool("maintenance"),
      expect: expect3,
      origin: { kind: "fresh_install", id: randomUUID() },
      phase: "verifying",
      now: () => new Date(),
    });
    expect(closed.audited).toBe(true);
    expect(readGate(path, expect3).admits).toBe("verification");
    let auditedBeforeWrite = false;
    const opened = await openGate({
      writer: {
        read: () => writer.read(),
        write: async (text) => {
          auditedBeforeWrite = (await events("operator.gate_open")).length === 1;
          await writer.write(text);
        },
      },
      pool: db.pool("maintenance"),
      expect: expect3,
      report: report(),
      kind: "deploy",
      now: () => new Date(),
    });
    expect(opened.ok).toBe(true);
    expect(auditedBeforeWrite).toBe(true);
    const reading = readGate(path, expect3);
    expect(reading.admits).toBe("all");
    expect(reading.record?.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reading.record?.gateEpoch).toBe(closed.record.gateEpoch + 1);
    expect(await events("operator.gate_open")).toEqual([
      { gateEpoch: closed.record.gateEpoch + 1, origin: "fresh_install" },
    ]);
  });

  it("with audit unavailable the file is unchanged and the open is refused", async () => {
    const path = join(dir, "no-audit.json");
    const writer = fileWriter(path);
    await closeGate({
      writer,
      pool: null,
      expect: expect3,
      origin: { kind: "fresh_install", id: randomUUID() },
      phase: "verifying",
      now: () => new Date(),
    });
    const before = readFileSync(path, "utf8");
    const broken = new pg.Pool({
      ...db.targets.maintenance,
      port: 1,
      connectionTimeoutMillis: 500,
    });
    try {
      const result = await openGate({
        writer,
        pool: broken,
        expect: expect3,
        report: report(),
        kind: "deploy",
        now: () => new Date(),
      });
      expect(result).toEqual({ ok: false, cause: "audit unavailable: the gate stays as it is" });
    } finally {
      await broken.end();
    }
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("gate close works with PostgreSQL unreachable, and says it could not audit", async () => {
    const path = join(dir, "close.json");
    const writer = fileWriter(path);
    const broken = new pg.Pool({
      ...db.targets.maintenance,
      port: 1,
      connectionTimeoutMillis: 500,
    });
    try {
      const closed = await closeGate({
        writer,
        pool: broken,
        expect: expect3,
        origin: { kind: "fresh_install", id: randomUUID() },
        phase: "serving",
        now: () => new Date(),
      });
      expect(closed.audited).toBe(false);
    } finally {
      await broken.end();
    }
    const reading = readGate(path, expect3);
    expect([reading.admits, reading.cause]).toEqual(["none", "closed"]);
  });

  it("an open refused by its report (another incarnation, a failed recheck) changes nothing", async () => {
    const path = join(dir, "refused.json");
    const writer = fileWriter(path);
    const other = { ...report(), backendIncarnation: randomUUID() };
    expect(
      await openGate({
        writer,
        pool: db.pool("maintenance"),
        expect: expect3,
        report: other,
        kind: "deploy",
        now: () => new Date(),
      }),
    ).toEqual({ ok: false, cause: "the report is of another incarnation" });
    expect(
      await openGate({
        writer,
        pool: db.pool("maintenance"),
        expect: expect3,
        report: report(),
        kind: "deploy",
        now: () => new Date(),
        recheck: () => Promise.resolve([{ id: "sessions_none", state: "failed" as const }]),
      }),
    ).toEqual({ ok: false, cause: "check sessions_none is failed now" });
    expect(existsSync(path)).toBe(false);
  });
});
