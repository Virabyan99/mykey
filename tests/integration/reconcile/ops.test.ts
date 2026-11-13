// The operator's reconciliation commands (Run 4.5): `ops operations`,
// `ops reconcile-operation`, `ops reconcile-environment`. Exit 0 for a verdict
// that settles, 3 (review) for one that does not, 2 for an unknown id, 64 for
// usage. None prints a value.
import { randomBytes, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { runOps } from "@mykey/ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

// A canary assembled at run time (never a literal in the repository).
const canary = (): string =>
  ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
const unique = (): string => `OP_${randomBytes(5).toString("hex").toUpperCase()}`;

async function ops(argv: string[]): Promise<{ code: number; out: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  stdout.on("data", (chunk: Buffer) => (out += String(chunk)));
  stderr.on("data", (chunk: Buffer) => (out += String(chunk)));
  const stdin = new PassThrough();
  stdin.end();
  const code = await runOps(argv, {
    stdin,
    stdout,
    stderr,
    env: {
      database: f.api.database.targets.maintenance,
      openBao: { target: f.stack.bao, rootToken: f.stack.bao.rootToken },
    },
  });
  return { code, out };
}

/** An update whose value is `value` and whose outcome is unknown; answers its operation id. */
async function uncertainUpdate(
  env: EnvName,
  value: string,
  how: "landed" | "notLanded",
): Promise<string> {
  const name = unique();
  const created = await f.create(env, name, randomBytes(8).toString("hex"));
  expect(created.status).toBe(201);
  f.setFaults((at) => {
    if (at !== "after_dispatch_marker") return;
    if (how === "landed") f.relay.delayResponses(8_000);
    else f.relay.swallowRequests(true);
  });
  let answer: Answer;
  try {
    answer = await f.update(env, name, value, created.body.result as never);
  } finally {
    f.setFaults(null);
    f.relay.clear();
  }
  expect(answer.code).toBe("outcome_unknown");
  return answer.operationId ?? "";
}

describe("ops reconciliation commands", () => {
  it("operations lists the unresolved; reconcile-operation exits 3 without exclusion and 0 with it; nothing prints the value", async () => {
    const value = canary();
    const id = await uncertainUpdate("env1a", value, "notLanded");
    const listed = await ops(["operations", "--organization", f.tenants.a.organizationId]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(id);
    expect(listed.out).toContain("secrets.update");
    const review = await ops(["reconcile-operation", "--operation", id]);
    expect(review.code).toBe(3);
    expect(review.out).toContain("executors_not_excluded");
    const settled = await ops([
      "reconcile-operation",
      "--operation",
      id,
      "--executors-excluded",
      "yes",
    ]);
    expect(settled).toEqual({ code: 0, out: `rejected ${id}\n` });
    const again = await ops(["reconcile-operation", "--operation", id]);
    expect(again.code).toBe(3);
    expect(again.out).toContain("not_unresolved");
    expect(await ops(["operations", "--organization", f.tenants.a.organizationId])).toEqual({
      code: 0,
      out: "none\n",
    });
    for (const out of [listed.out, review.out, settled.out, again.out]) {
      expect(out.includes(value)).toBe(false);
    }
  }, 60_000);

  it("a landed write reads its value for its length only: exit 0, succeeded, no value printed", async () => {
    const value = canary();
    const id = await uncertainUpdate("env1b", value, "landed");
    const settled = await ops(["reconcile-operation", "--operation", id]);
    expect(settled).toEqual({ code: 0, out: `succeeded ${id} version 2\n` });
    const environment = await ops([
      "reconcile-environment",
      "--environment",
      f.env("env1b").environmentId,
    ]);
    expect(environment.code).toBe(0);
    expect(environment.out).toMatch(/^rebuilt names \d+ changed 0\n$/);
    expect((settled.out + environment.out).includes(value)).toBe(false);
  }, 60_000);

  it("reconcile-environment exits 3 while an operation is unresolved", async () => {
    const id = await uncertainUpdate("env2a", randomBytes(8).toString("hex"), "notLanded");
    const refused = await ops([
      "reconcile-environment",
      "--environment",
      f.env("env2a").environmentId,
    ]);
    expect(refused.code).toBe(3);
    expect(refused.out).toContain("unresolved_operations");
    expect(
      (await ops(["reconcile-operation", "--operation", id, "--executors-excluded", "yes"])).code,
    ).toBe(0);
  }, 60_000);

  it("an unknown id exits 2; a malformed one or a flag value other than yes exits 64", async () => {
    expect((await ops(["reconcile-operation", "--operation", randomUUID()])).code).toBe(2);
    expect((await ops(["reconcile-environment", "--environment", randomUUID()])).code).toBe(2);
    expect((await ops(["reconcile-operation", "--operation", "x"])).code).toBe(64);
    expect(
      (
        await ops([
          "reconcile-operation",
          "--operation",
          randomUUID(),
          "--executors-excluded",
          "maybe",
        ])
      ).code,
    ).toBe(64);
    expect((await ops(["operations"])).code).toBe(64);
  });
});
