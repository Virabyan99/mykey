// Run 6.5 Task B (P-120, Session 2 M2): the coordinator killed in draining, in
// capturing and after the artifacts. Each time the recover unit's command
// (`ops capture --step abort`) releases the freeze, the product writes again
// within the deadline, the pair is ineligible, and the scratch directory is
// empty.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { runOps } from "@mykey/ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";

const CHILD = resolve(import.meta.dirname, "../../harness/capture-process.ts");
const OWNER = "backup@local";
/** How soon after the release the product must write again. */
const WRITE_DEADLINE_MS = 10_000;

let f: CredentialsFixture;
let scratchRoot: string;

beforeAll(async () => {
  f = await createCredentialsFixture();
  scratchRoot = mkdtempSync(join(tmpdir(), "mykey-pair-scratch-"));
}, 600_000);

afterAll(async () => {
  rmSync(scratchRoot, { recursive: true, force: true });
  await f.close();
}, 300_000);

function start(stopAt: "draining" | "capturing" | "artifacts"): {
  child: ChildProcessWithoutNullStreams;
  line: (match: (entry: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
} {
  const child = spawn(process.execPath, [CHILD], { stdio: ["pipe", "pipe", "pipe"] });
  const entries: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let buffered = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let end = buffered.indexOf("\n");
    while (end !== -1) {
      entries.push(JSON.parse(buffered.slice(0, end)) as Record<string, unknown>);
      buffered = buffered.slice(end + 1);
      end = buffered.indexOf("\n");
      for (const wake of waiters.splice(0)) wake();
    }
  });
  child.stdin.write(
    `${JSON.stringify({
      database: f.api.database.targets.maintenance,
      owner: OWNER,
      stopAt,
      scratchRoot,
    })}\n`,
  );
  return {
    child,
    line: async (match) => {
      for (;;) {
        const found = entries.find(match);
        if (found !== undefined) return found;
        await new Promise<void>((wake) => waiters.push(wake));
      }
    },
  };
}

async function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGKILL");
  await exited;
}

async function mode(): Promise<{ capture_mode: string; pair_id: string | null }> {
  const rows = await f.api.superuser.query<{ capture_mode: string; pair_id: string | null }>(
    "SELECT capture_mode, pair_id FROM app.service_control",
  );
  return rows.rows[0]!;
}

async function recover(): Promise<{ code: number; out: string }> {
  const stdout = new PassThrough();
  let out = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  const code = await runOps(["capture", "--step", "abort", "--owner", OWNER], {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    env: { database: f.api.database.targets.maintenance, pairScratch: scratchRoot },
  });
  return { code, out };
}

/** The product writes again within the deadline after the release. */
async function writesAgain(): Promise<void> {
  const deadline = Date.now() + WRITE_DEADLINE_MS;
  for (;;) {
    const created = await f.create(
      "env1a",
      `CRASH_${randomUUID().slice(0, 8).toUpperCase()}`,
      "synthetic",
    );
    if (created.status === 201) return;
    if (Date.now() > deadline) throw new Error(`no write after the release: ${created.code ?? ""}`);
    await new Promise((wait) => setTimeout(wait, 250));
  }
}

async function expectIneligible(pairId: string): Promise<void> {
  const rows = await f.api.superuser.query<{ validation_status: string; invalid_reason: string }>(
    "SELECT validation_status, invalid_reason FROM app.backup_pair WHERE id = $1",
    [pairId],
  );
  expect(rows.rows).toEqual([{ validation_status: "ineligible", invalid_reason: "aborted" }]);
}

describe("the coordinator killed", () => {
  it("in draining: the recover command releases, the product writes again, the pair is ineligible", async () => {
    // An operation that stays executing keeps the coordinator draining.
    const blocker = randomUUID();
    await f.api.superuser.query(
      `INSERT INTO app.operation (id, principal_kind, principal_id, action, target, idempotency_key, state)
       VALUES ($1::uuid, 'operator', 'crash', 'crash.test', $1::text, $1::text, 'executing')`,
      [blocker],
    );
    try {
      const { child } = start("draining");
      const deadline = Date.now() + 30_000;
      while ((await mode()).capture_mode !== "draining") {
        if (Date.now() > deadline) throw new Error("never draining");
        await new Promise((wait) => setTimeout(wait, 100));
      }
      const pairId = (await mode()).pair_id!;
      await kill(child);
      expect((await mode()).capture_mode).toBe("draining");
      const recovered = await recover();
      expect(recovered).toEqual({ code: 0, out: `released ${pairId}\n` });
      expect((await mode()).capture_mode).toBe("idle");
      await writesAgain();
      await expectIneligible(pairId);
    } finally {
      await f.api.superuser.query("DELETE FROM app.operation WHERE id = $1", [blocker]);
    }
  }, 120_000);

  for (const stopAt of ["capturing", "artifacts"] as const) {
    it(`${stopAt === "capturing" ? "in capturing" : "after the artifacts"}: the recover command releases, the product writes again, the pair is ineligible, the scratch directory is empty`, async () => {
      const { child, line } = start(stopAt);
      const reached = await line((entry) => entry.at === stopAt);
      const pairId = reached.pairId as string;
      if (stopAt === "artifacts") expect(readdirSync(join(scratchRoot, pairId))).toHaveLength(3);
      await kill(child);
      expect(await mode()).toEqual({ capture_mode: "capturing", pair_id: pairId });
      const refused = await f.create("env1a", "CRASH_REFUSED", "synthetic");
      expect([refused.status, refused.code]).toEqual([503, "busy"]);
      const recovered = await recover();
      expect(recovered).toEqual({ code: 0, out: `released ${pairId}\n` });
      await writesAgain();
      await expectIneligible(pairId);
      expect(existsSync(join(scratchRoot, pairId))).toBe(false);
      expect(readdirSync(scratchRoot)).toEqual([]);
    }, 120_000);
  }

  it("the recover command when nothing is frozen says so and changes nothing", async () => {
    expect(await recover()).toEqual({ code: 0, out: "nothing to release: idle\n" });
    expect((await mode()).capture_mode).toBe("idle");
  });
});
