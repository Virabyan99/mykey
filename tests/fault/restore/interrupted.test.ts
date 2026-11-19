// Run 6.7 Task C (P-124, D-55): a restore stopped after each of its steps.
// Each time: the target serves nothing (the record is not open; a running API
// answers quarantined and /health down), gate open is refused, and running the
// restore again from step 1 ends in a product whose report has every store
// check ok. Before anything is written, a restore refuses a target that holds
// another database, a pair whose KMS key is not usable here, and a
// globals.sql that creates a role nobody listed.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { REQUIRED_CHECKS, type VerificationReport } from "@mykey/contracts";
import { readGate } from "@mykey/operations";
import { openGate } from "@mykey/operations/operator";
import {
  RESTORE_STEPS,
  RestoreRefused,
  restoreToVerifying,
  restoreVerify,
  type Restored,
} from "@mykey/ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_BUILD } from "../../harness/gate.ts";
import { createLostWorld, type LostWorld } from "../../harness/restore-fixture.ts";
import { localRestoreTarget } from "../../harness/restore-target.ts";

let world: LostWorld;

beforeAll(async () => {
  world = await createLostWorld();
}, 900_000);

afterAll(async () => {
  await (world as LostWorld | undefined)?.close();
}, 300_000);

const fileWriter = (path: string) => ({
  read: () => Promise.resolve(existsSync(path) ? readFileSync(path, "utf8") : null),
  write: (text: string) => {
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
    return Promise.resolve();
  },
});

const codeOf = async (r: Response) => {
  try {
    return ((await r.json()) as { error?: { code?: string } }).error?.code ?? "";
  } catch {
    return "";
  }
};

/** A report for this target, all checks ok, bound to `incarnation`. */
function reportFor(incarnation: string, hostInstanceId: string): VerificationReport {
  return {
    format: "mykey-verification/1",
    host: "local",
    hostInstanceId,
    backendIncarnation: incarnation,
    releaseBuild: TEST_BUILD,
    origin: { kind: "restore", pairId: world.pair.pairId },
    createdAt: new Date().toISOString(),
    checks: REQUIRED_CHECKS.restore.map((id) => ({ id, state: "ok", observed: "test" })),
    members: 1,
  };
}

describe("a restore stopped after each step (P-124)", () => {
  it("serves nothing and refuses to open after each stop; started again from step 1 it completes", async () => {
    const target = await localRestoreTarget(world);
    let restored: Restored | null = null;
    try {
      const previous = { incarnation: world.f.api.gate.backendIncarnation, host: randomUUID() };
      for (const step of RESTORE_STEPS) {
        await expect(
          restoreToVerifying(target, {
            crashAt: (at) => {
              if (at === step) throw new Error(`stopped after ${at}`);
            },
          }),
          step,
        ).rejects.toThrow(`stopped after ${step}`);
        // The record is not open, whatever it binds.
        if (existsSync(target.gatePath)) {
          const reading = readGate(target.gatePath, {
            hostInstanceId: previous.host,
            backendIncarnation: previous.incarnation,
            releaseBuild: TEST_BUILD,
          });
          expect(reading.admits, step).not.toBe("all");
        }
        // A running API (the stop after `start`) is quarantined, /health down.
        if (target.api !== null) {
          const pub = await target.request("public", "GET", "/v1/organizations");
          expect([pub.status, await codeOf(pub)], step).toEqual([503, "quarantined"]);
          expect((await target.request("public", "GET", "/health")).status, step).toBe(503);
        }
        // gate open: no report is refused; a report of another incarnation is refused.
        const opening = {
          writer: fileWriter(target.gatePath),
          pool: world.f.api.superuser,
          expect: {
            hostInstanceId: previous.host,
            backendIncarnation: randomUUID(),
            releaseBuild: TEST_BUILD,
          },
          kind: "restore" as const,
          now: () => new Date(),
        };
        expect((await openGate({ ...opening, report: null })).ok, step).toBe(false);
        expect(
          await openGate({ ...opening, report: reportFor(previous.incarnation, previous.host) }),
          step,
        ).toEqual({ ok: false, cause: "the report is of another incarnation" });
      }

      // From step 1 again, to the end.
      const restoreStartedAt = new Date();
      restored = await restoreToVerifying(target);
      const members = Number(
        (await restored.pool.query<{ n: string }>("SELECT count(*) AS n FROM app.membership"))
          .rows[0]?.n,
      );
      const report = await restoreVerify(
        {
          pool: restored.pool,
          admin: restored.admin,
          host: "local",
          expect: {
            hostInstanceId: restored.hostInstanceId,
            backendIncarnation: restored.backendIncarnation,
            releaseBuild: TEST_BUILD,
          },
          origin: { kind: "restore", pairId: world.pair.pairId },
          schemaRevision: "0018_incarnation",
          restoreStartedAt,
          given: { ...restored.given, old_credentials_refused: { state: "ok", observed: "test" } },
          confirmMembers: members,
          boundCidrs: { runtime: [], issuer: [], provisioner: [] },
        },
        null,
      );
      expect(report.checks.filter((c) => c.state !== "ok").map((c) => c.id)).toEqual([
        "journey_owner_enrolled",
        "journey_reveal_digest",
        "journey_mutation_refused",
      ]);
      const pub = await target.request("public", "GET", "/v1/organizations");
      expect(await codeOf(pub)).toBe("quarantined");
      expect((await target.request("verify", "GET", "/v1/version")).status).toBe(200);
    } finally {
      await restored?.pool.end();
      await target.stop();
    }
  }, 1_800_000);
});

describe("refused before anything is written (P-124 steps 1 to 3)", () => {
  it("a target that holds another database is refused", async () => {
    // The scratch cluster holds `restored` from the test above; this target has no state line.
    const target = await localRestoreTarget(world);
    try {
      await expect(restoreToVerifying(target)).rejects.toThrow(
        new RestoreRefused("the target holds a database already"),
      );
    } finally {
      await target.stop();
    }
  });

  it("a manifest whose KMS key is not usable here stops the restore before anything is written", async () => {
    const target = await localRestoreTarget(world, { kmsUsable: false });
    try {
      await target.state.write({ pairId: world.pair.pairId, step: "fetch" });
      const before = target.passwords;
      await expect(restoreToVerifying(target)).rejects.toThrow(
        "the pair's KMS key local-static-seal is not usable on this host",
      );
      expect(target.passwords).toBe(before);
      expect(target.api).toBeNull();
    } finally {
      await target.stop();
    }
  });

  it("a globals.sql that creates a role nobody listed stops the restore with the role's name", async () => {
    const target = await localRestoreTarget(world, { extraGlobals: "CREATE ROLE intruder;\n" });
    try {
      await target.state.write({ pairId: world.pair.pairId, step: "fetch" });
      await expect(restoreToVerifying(target)).rejects.toThrow(
        "globals.sql creates roles the inventory does not hold: intruder",
      );
      expect(target.passwords).toBeNull();
    } finally {
      await target.stop();
    }
  });
});
