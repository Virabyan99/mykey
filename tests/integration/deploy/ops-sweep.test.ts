// Run 6.9 Task C (P-129): `ops sweep` runs the PostgreSQL-only sweeps once,
// as maintenance, for the minutes the API is down (the 5-minute timer). While
// a pair is captured (the mode is not idle) it does nothing and still exits 0.
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { runOps, type OpsEnv } from "@mykey/ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  type Answer,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

async function ops(argv: string[]): Promise<{ code: number; stdout: string }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => out.push(chunk));
  stdin.end("");
  const env: OpsEnv = {
    database: f.api.database.targets.maintenance,
    keysDirectory: f.keysDirectory,
    baseUrl: "https://mykey.test",
    home: f.keysDirectory,
  };
  const code = await runOps(argv, { stdin, stdout, stderr, env });
  return { code, stdout: Buffer.concat(out).toString("utf8") };
}

/** An update held after admission (accepted), its heartbeat 121 s old. */
async function staleAccepted(): Promise<{ id: string; release(): void; answer: Promise<Answer> }> {
  const name = `SW_${randomBytes(5).toString("hex").toUpperCase()}`;
  const created = await f.create("env1b", name, randomBytes(20).toString("hex"));
  expect(created.status).toBe(201);
  const before = created.body.result as { version: number; stateTag: string };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: (id: string) => void;
  const arrived = new Promise<string>((resolve) => {
    reached = resolve;
  });
  f.setFaults(async (at, id) => {
    if (at !== "after_admission") return;
    reached(id);
    await held;
  });
  const answer = f.update("env1b", name, randomBytes(20).toString("hex"), before);
  const id = await arrived;
  f.setFaults(null);
  await f.api.superuser.query(
    "UPDATE app.operation SET heartbeat_at = now() - interval '121 seconds' WHERE id = $1",
    [id],
  );
  return { id, release, answer };
}

const stateOf = async (id: string) =>
  (
    await f.api.superuser.query<{ state: string }>(
      "SELECT state FROM app.operation WHERE id = $1",
      [id],
    )
  ).rows[0]?.state;

const setMode = (mode: "idle" | "draining") =>
  f.api.database
    .pool("maintenance")
    .query(
      "UPDATE app.service_control SET capture_mode = $1, owner = $2, pair_id = NULL, updated_at = now()",
      [mode, mode === "idle" ? null : "ops-sweep-test"],
    );

describe("ops sweep (P-129)", () => {
  it("while a pair is captured it does nothing and exits 0", async () => {
    const held = await staleAccepted();
    try {
      await setMode("draining");
      const run = await ops(["sweep"]);
      expect(run).toEqual({ code: 0, stdout: "skipped: capture\n" });
      expect(await stateOf(held.id)).toBe("accepted");
    } finally {
      await setMode("idle");
      held.release();
      await held.answer;
    }
  });

  it("runs the PostgreSQL sweeps once and exits 0: a stale accepted operation is rejected", async () => {
    const held = await staleAccepted();
    try {
      const run = await ops(["sweep"]);
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(/^swept: uncertain \d+, rejected [1-9]\d*\n$/);
      expect(await stateOf(held.id)).toBe("rejected");
    } finally {
      held.release();
      await held.answer;
    }
  });
});
