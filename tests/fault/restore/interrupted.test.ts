// Run 6.7 Task C (P-124, D-55): a restore stopped after each of its steps.
// Each time: the target serves nothing (the record is not open; a running API
// answers quarantined and /health down), gate open is refused, and running the
// restore again from step 1 ends in a product whose report has every store
// check ok. Before anything is written, a restore refuses a target that holds
// another database, a pair whose KMS key is not usable here, and a
// globals.sql that creates a role nobody listed.
//
// Run 9.7 (Session 8's review R4-2, R4-3): the target's OpenBao is now one
// instance for all the runs of a target, as a host's is, so a rerun meets
// the store the stopped run left. After the last run, generate-root with the
// source's recovery key makes the restored OpenBao's next root token.
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { REQUIRED_CHECKS, type VerificationReport } from "@mykey/contracts";
import { readGate } from "@mykey/operations";
import { openGate } from "@mykey/operations/operator";
import {
  RESTORE_STEPS,
  RestoreRefused,
  recheckForOpen,
  restoreToVerifying,
  restoreVerify,
  type Restored,
  type VerifyDeps,
} from "@mykey/ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_BUILD } from "../../harness/gate.ts";
import { createLostWorld, type LostWorld } from "../../harness/restore-fixture.ts";
import { localRestoreTarget, type LocalTarget } from "../../harness/restore-target.ts";
import { baoFetch } from "../../harness/stack.ts";
import {
  generateRoot,
  rootTokenCandidates,
  writeCustodyAfterRestore,
  type SysCall,
} from "../../../scripts/host-restore.ts";

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

/** The target's OpenBao answers lookup-self for `token`: its HTTP status. */
const lookup = async (target: LocalTarget, token: string): Promise<number> => {
  if (target.scratch === null) throw new Error("no scratch OpenBao yet");
  return (await baoFetch(target.scratch.stack, "/v1/auth/token/lookup-self", { token })).status;
};

/** generate-root's sys/ calls to the target's OpenBao, with the restore's own root token. */
const sysCallTo =
  (target: LocalTarget, token: string): SysCall =>
  async (method, path, body) => {
    if (target.scratch === null) throw new Error("no scratch OpenBao yet");
    const answer = await baoFetch(target.scratch.stack, `/v1/${path}`, {
      method,
      token,
      ...(body === undefined ? {} : { body }),
    });
    const text = await answer.text();
    return { status: answer.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
  };

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
      const verifyDeps: VerifyDeps = {
        pool: restored.pool,
        admin: restored.admin,
        host: "local",
        expect: {
          hostInstanceId: restored.hostInstanceId,
          backendIncarnation: restored.backendIncarnation,
          releaseBuild: TEST_BUILD,
        },
        origin: { kind: "restore" as const, pairId: world.pair.pairId },
        schemaRevision: "0019_automation_and_runtime",
        restoreStartedAt,
        given: { ...restored.given, old_credentials_refused: { state: "ok", observed: "test" } },
        confirmMembers: members,
        boundCidrs: { runtime: [], issuer: [], provisioner: [] },
      };
      const report = await restoreVerify(verifyDeps, null);
      expect(report.checks.filter((c) => c.state !== "ok").map((c) => c.id)).toEqual([
        "journey_owner_enrolled",
        "journey_reveal_digest",
        "journey_mutation_refused",
      ]);
      const pub = await target.request("public", "GET", "/v1/organizations");
      expect(await codeOf(pub)).toBe("quarantined");
      expect((await target.request("verify", "GET", "/v1/version")).status).toBe(200);

      // R4-2: after restore-verify --open, a new root token is made with the source's
      // recovery key (generate-root), written to the target's custody copy, and the old
      // one is revoked; ops and deploy work after the restore.
      const sourceKey = world.f.stack.bao.recoveryKey ?? "";
      expect(sourceKey, "the source stack's recovery key (stack.json)").not.toBe("");
      const scratchKey = target.scratch?.own.recoveryKey ?? "";
      expect(scratchKey).not.toBe("");
      // The snapshot carries the source's recovery configuration: the target's own key fails.
      await expect(
        generateRoot(sysCallTo(target, restored.rootToken), scratchKey),
      ).rejects.toThrow();
      const next = await generateRoot(sysCallTo(target, restored.rootToken), sourceKey);
      expect(await lookup(target, next)).toBe(200);
      // Review RR-1: the opening's recheck runs after the next root token exists. Its
      // accessor, and only it, is the operator's own; any other is still refused.
      if (target.scratch === null) throw new Error("no scratch OpenBao yet");
      const nextSelf = (await (
        await baoFetch(target.scratch.stack, "/v1/auth/token/lookup-self", { token: next })
      ).json()) as { data: { accessor: string } };
      const accessorsCheck = async (operatorAccessors?: readonly string[]) =>
        (
          await recheckForOpen({
            ...verifyDeps,
            ...(operatorAccessors === undefined ? {} : { operatorAccessors }),
          })
        ).find((c) => c.id === "machine_accessors_none")?.state;
      expect(await accessorsCheck()).toBe("failed");
      expect(await accessorsCheck([nextSelf.data.accessor])).toBe("ok");
      expect(await accessorsCheck(["not-this-one"])).toBe("failed");
      const home = mkdtempSync(join(tmpdir(), "mykey-restore-custody-"));
      try {
        const sourceAnswer = `${JSON.stringify({ root_token: world.old.rootToken, recovery_keys_base64: [sourceKey] })}\n`;
        writeCustodyAfterRestore("local", sourceAnswer, next, new Date(), home);
        // What ops and a deploy read (opsRootToken: the custody copy, no restore token left).
        const offered = rootTokenCandidates("local", home);
        expect(offered.map((c) => c.from)).toEqual(["custody"]);
        expect(await lookup(target, offered[0]?.token ?? "")).toBe(200);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
      // The restore's own token is revoked at the opening; the new one stays.
      await restored.admin.revokeSelf();
      expect(await lookup(target, restored.rootToken)).toBe(403);
      expect(await lookup(target, next)).toBe(200);
    } finally {
      await restored?.pool.end();
      await target.stop();
    }
  }, 1_800_000);

  it("a restore stopped after its OpenBao step can be run again: the step records that the target's token was replaced, and the rerun uses the custody copy written in that step", async () => {
    const target = await localRestoreTarget(world);
    let restored: Restored | null = null;
    try {
      // The scratch cluster holds this pair's database from the test above: this target's
      // state line says the same pair's restore stopped there, so it starts over.
      await target.state.write({ pairId: world.pair.pairId, step: "start" });
      // Stopped right after the snapshot: the target's own token is gone, the pair's is live.
      await expect(
        restoreToVerifying(target, {
          crashAt: (at) => {
            if (at === "snapshot") throw new Error("stopped after snapshot");
          },
        }),
      ).rejects.toThrow("stopped after snapshot");
      expect(await target.state.read()).toEqual({ pairId: world.pair.pairId, step: "snapshot" });
      const own = target.scratch?.own.rootToken ?? "";
      expect(await lookup(target, own)).toBe(403);
      expect(target.keptRootToken).toBeNull();

      // Stopped after step 5: the pair's token is revoked; only the kept one is live.
      await expect(
        restoreToVerifying(target, {
          crashAt: (at) => {
            if (at === "invalidate") throw new Error("stopped after invalidate");
          },
        }),
      ).rejects.toThrow("stopped after invalidate");
      const kept = target.keptRootToken ?? "";
      expect(kept).not.toBe("");
      expect(await lookup(target, kept)).toBe(200);
      expect(await lookup(target, world.old.rootToken)).toBe(403);

      // The rerun offers the kept token first and completes.
      restored = await restoreToVerifying(target);
      expect(restored.rootToken).not.toBe(kept);
      expect(await lookup(target, restored.rootToken)).toBe(200);
      expect(target.keptRootToken).toBe(restored.rootToken);
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
