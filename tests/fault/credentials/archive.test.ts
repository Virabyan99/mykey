// Run 5.3 Task D (AC-1.11, P-91, D-41): archive under interruption and in
// races, with two API processes. A process killed at any of the three fault
// points leaves an archive the other process's tick finishes; an issuance
// racing an archive never leaves a usable token; no environment is active or
// pending under an archived project; the request and the tick driving one
// archive at once finish it once. Tokens are compared by booleans and counts.
import { randomInt, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHIVE_FAULT_POINTS } from "@mykey/operations";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { machineAccessors } from "../../harness/credentials-fixture.ts";
import {
  accessorAnswer,
  accessorsOf,
  archiveDriver,
  issueAt,
  newProject,
  reactivate,
  resourceState,
  successRows,
  type Place,
} from "../../harness/lifecycle-fixture.ts";
import { credentialFaults, type CredentialFaults } from "./fixture.ts";

let faults: CredentialFaults;
const TICK = { intervalMs: 200, staleSeconds: 0 };

beforeAll(async () => {
  faults = await credentialFaults();
}, 600_000);

afterAll(async () => {
  await faults.close();
});

afterEach(() => {
  faults.f.setFaults(null);
  faults.f.relay.clear();
});

/** How the rounds of the races ended, for the fault table (counts of status codes only). */
const record = (name: string, outcomes: Record<string, number>): void => {
  writeFileSync(join(tmpdir(), `mykey-archive-${name}.json`), JSON.stringify(outcomes));
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends `a`, then `b` after `offsetMs`; a negative offset sends `b` first. */
async function race<A, B>(a: () => Promise<A>, b: () => Promise<B>, offsetMs: number) {
  if (offsetMs >= 0) {
    const first = a();
    await sleep(offsetMs);
    return Promise.all([first, b()]);
  }
  const second = b();
  await sleep(-offsetMs);
  return Promise.all([a(), second]);
}

function archiveTo(place: Place, to: "first" | "second", key = randomUUID(), path = place.path) {
  return faults.f.send("POST", `${path}/archive`, { body: { confirmed: true }, key, to });
}

/** Waits until the operation reads `succeeded` (the tick's period is 200 ms). */
async function succeeded(operationId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await faults.operation(operationId))?.state === "succeeded") return;
    await sleep(100);
  }
  expect((await faults.operation(operationId))?.state, "archive operation").toBe("succeeded");
}

async function credentialStates(environmentId: string): Promise<string[]> {
  const rows = await faults.f.api.superuser.query<{ state: string }>(
    "SELECT state FROM app.machine_credential WHERE environment_id = $1 ORDER BY state",
    [environmentId],
  );
  return rows.rows.map((row) => row.state);
}

async function expectRevokedEverywhere(place: Place): Promise<void> {
  expect(new Set(await credentialStates(place.environmentId))).toEqual(new Set(["revoked"]));
  for (const accessor of await accessorsOf(faults.f, place.environmentId)) {
    expect(await accessorAnswer(faults.f, accessor)).toBe(400);
  }
  expect((await machineAccessors(faults.f, place.environmentId)).length).toBe(0);
}

describe("an archive interrupted", () => {
  it.each(ARCHIVE_FAULT_POINTS)(
    "killed at %s: the second process's tick ends the archive; every accessor answers 400; exactly one success audit row",
    async (point) => {
      const place = await newProject(faults.f);
      for (let i = 0; i < 3; i += 1) await issueAt(faults.f, place);
      await faults.child(point);
      const key = randomUUID();
      const answer = await faults.toChild(() => archiveTo(place, "second", key));
      expect(answer, "an answer from a killed process").toBeNull();
      await faults.f.second?.exited;
      const operationId = await faults.operationByKey(key);
      expect(operationId).not.toBeNull();
      expect((await faults.operation(operationId!))?.state).toBe("executing");
      // A process with the tick takes over.
      await faults.f.restartSecond(undefined, { archiveTick: TICK });
      await succeeded(operationId!);
      expect((await resourceState(faults.f, "environment", place.environmentId)).state).toBe(
        "archived",
      );
      await expectRevokedEverywhere(place);
      expect(await successRows(faults.f, operationId!)).toBe(1);
      expect(faults.f.second?.output().includes("archive_tick_failed")).toBe(false);
    },
  );
});

describe("races", () => {
  it("an issuance racing an archive leaves no usable token (50 rounds)", async () => {
    const place = await newProject(faults.f);
    await faults.child();
    const driver = archiveDriver(faults.f);
    const outcomes: Record<string, number> = {};
    // The archive is sent from just before the issuance to just after its
    // finalize: the issuance's own duration, measured once, sets the spread.
    await faults.f.freshen();
    const started = Date.now();
    const timed = await faults.f.send("POST", `${place.path}/credentials`, {
      body: { name: "timed", ttlSeconds: 600 },
      key: randomUUID(),
    });
    expect(timed.status).toBe(201);
    const spread = Math.ceil((Date.now() - started) * 1.3) + 1;
    try {
      for (let round = 0; round < 50; round += 1) {
        await faults.f.freshen();
        const [issued, answer] = await race(
          () =>
            faults.f.send("POST", `${place.path}/credentials`, {
              body: { name: "race", ttlSeconds: 600 },
              key: randomUUID(),
            }),
          () => archiveTo(place, "second"),
          randomInt(-20, spread),
        );
        expect([200, 202], `archive: ${answer.code ?? ""}`).toContain(answer.status);
        for (let pass = 0; pass < 50; pass += 1) {
          if (
            (await resourceState(faults.f, "environment", place.environmentId)).state === "archived"
          )
            break;
          await driver.run(0);
          await sleep(100);
        }
        expect((await resourceState(faults.f, "environment", place.environmentId)).state).toBe(
          "archived",
        );
        expect((await machineAccessors(faults.f, place.environmentId)).length).toBe(0);
        const label = `${String(issued.status)} ${issued.code ?? ""}`;
        outcomes[label] = (outcomes[label] ?? 0) + 1;
        if (issued.status === 201) {
          const credential = issued.body.credential as { credentialId: string };
          expect(await faults.stateOf(credential.credentialId)).toBe("revoked");
          expect(await faults.alive(issued.body.token as string)).toBe(false);
        }
        const back = await reactivate(faults.f, place.path);
        expect(back.status, `reactivate: ${back.code ?? ""}`).toBe(200);
      }
    } finally {
      await driver.close();
    }
    record("issuance-race", { spreadMs: spread, ...outcomes });
    // Both orders were met: issuances that finished first, and ones the archive refused.
    expect(outcomes["201 "] ?? 0, "issuances answered 201").toBeGreaterThan(0);
    expect(outcomes["409 state_conflict"] ?? 0, "issuances refused").toBeGreaterThan(0);
  }, 900_000);

  it("an environment created while its project is archived (20 rounds): never an active or pending environment under an archived project", async () => {
    const f = faults.f;
    await faults.child();
    const driver = archiveDriver(f);
    const outcomes: Record<string, number> = {};
    try {
      for (let round = 0; round < 20; round += 1) {
        const projectId = randomUUID();
        await f.api.superuser.query(
          "INSERT INTO app.project (id, organization_id, name, state) VALUES ($1, $2, $3, 'active')",
          [projectId, f.tenants.a.organizationId, `race-${String(round)}-${projectId.slice(0, 8)}`],
        );
        const projectPath = `/v1/organizations/${f.tenants.a.organizationId}/projects/${projectId}`;
        const [made, answer] = await race(
          () =>
            f.send("POST", `${projectPath}/environments`, {
              body: { name: `e${String(round)}` },
              key: randomUUID(),
            }),
          () =>
            f.send("POST", `${projectPath}/archive`, {
              body: { confirmed: true },
              key: randomUUID(),
              to: "second",
            }),
          randomInt(-15, 16),
        );
        const label = `create ${String(made.status)} / archive ${String(answer.status)}`;
        outcomes[label] = (outcomes[label] ?? 0) + 1;
        expect([201, 409], `create: ${made.code ?? ""}`).toContain(made.status);
        expect([200, 202, 409], `archive: ${answer.code ?? ""}`).toContain(answer.status);
        if (answer.status === 202) {
          for (let pass = 0; pass < 50; pass += 1) {
            if ((await resourceState(f, "project", projectId)).state === "archived") break;
            await driver.run(0);
            await sleep(100);
          }
        }
        const wrong = await f.api.superuser.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM app.environment e
             JOIN app.project p ON p.organization_id = e.organization_id AND p.id = e.project_id
            WHERE p.state IN ('revoking', 'archived') AND e.state IN ('active', 'pending')`,
        );
        expect(wrong.rows[0]?.count).toBe(0);
      }
    } finally {
      await driver.close();
    }
    record("create-race", outcomes);
  }, 600_000);

  it("the request and the tick drive one archive at once: one success audit row, no error, every credential revoked", async () => {
    const place = await newProject(faults.f);
    for (let i = 0; i < 3; i += 1) await issueAt(faults.f, place);
    await faults.f.restartSecond(undefined, { archiveTick: { intervalMs: 10, staleSeconds: 0 } });
    const key = randomUUID();
    const answer = await archiveTo(place, "first", key);
    expect([200, 202], `archive: ${answer.code ?? ""}`).toContain(answer.status);
    const operationId = await faults.operationByKey(key);
    await succeeded(operationId!);
    await expectRevokedEverywhere(place);
    expect(await successRows(faults.f, operationId!)).toBe(1);
    expect(faults.f.second?.output().includes("archive_tick_failed")).toBe(false);
  });
});
