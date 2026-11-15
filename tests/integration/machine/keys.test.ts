// Run 5.4 Task B (P-94, FR-1.44, D-42): machine.keys answers the live names
// of one generation in bytewise order and nothing else; and both machine
// routes read OpenBao with the presented token, never with the runtime
// identity (Review focus 2). Tokens are locals; values are compared by digest.
import { randomBytes } from "node:crypto";
import { machineName } from "@mykey/openbao";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { machineCall } from "../../harness/machine.ts";
import { readAuditLog } from "../../harness/stack.ts";

const bytewise = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const unique = (prefix: string): string =>
  `${prefix}_${randomBytes(4).toString("hex").toUpperCase()}`;

describe("machine.keys", () => {
  let f: CredentialsFixture;

  beforeAll(async () => {
    f = await createCredentialsFixture();
  }, 600_000);

  afterAll(async () => {
    await f.close();
  });

  it("keys returns the live names in bytewise order and nothing else; one machine.keys audit row with counts only", async () => {
    const names = [unique("K_B"), unique("K_A"), unique("K_C"), unique("K_A1")];
    const versions = new Map<string, { version: number; stateTag: string }>();
    for (const name of names) {
      const made = await f.create("env1a", name, `synthetic-${name.toLowerCase()}`);
      expect(made.status).toBe(201);
      versions.set(name, made.body.result as { version: number; stateTag: string });
    }
    const gone = names[2]!;
    const deleted = await f.act("env1a", gone, "delete", versions.get(gone)!);
    expect(deleted.status).toBe(200);
    const { token, credentialId } = await issueFor(f, "env1a");

    const answer = await machineCall(f, "keys", { token });
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual(
      ["apiMajor", "complete", "count", "environmentId", "generation", "names"].sort(),
    );
    const live = names.filter((name) => name !== gone).sort(bytewise);
    expect(answer.body.names).toEqual(live);
    expect(answer.body.count).toBe(live.length);
    expect(answer.body.complete).toBe(true);
    expect(answer.body.environmentId).toBe(f.env("env1a").environmentId);
    const generation = await f.api.superuser.query<{ generation: string }>(
      "SELECT metadata_generation::text AS generation FROM app.environment WHERE id = $1",
      [f.env("env1a").environmentId],
    );
    expect(answer.body.generation).toBe(generation.rows[0]?.generation);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(Number(answer.headers.get("content-length"))).toBe(answer.bytes.length);

    const audit = await f.api.superuser.query<{
      actor_kind: string;
      actor_id: string;
      details: Record<string, unknown>;
    }>(
      "SELECT actor_kind, actor_id, details FROM audit.event WHERE action = 'machine.keys' AND request_id = $1",
      [answer.headers.get("x-request-id")],
    );
    expect(audit.rows).toEqual([
      {
        actor_kind: "machine",
        actor_id: credentialId,
        details: { names: live.length, generation: generation.rows[0]?.generation },
      },
    ]);
    const detailsText = JSON.stringify(audit.rows[0]?.details);
    expect(names.some((name) => detailsText.includes(name))).toBe(false);
  });
});

describe("the reads are made with the presented token (Review focus 2)", () => {
  let f: CredentialsFixture;

  beforeAll(async () => {
    // The API's runtime secret id is one OpenBao refuses.
    f = await createCredentialsFixture({ runtime: "broken" });
    await f.seedEnvironment("env1a", 3, 32);
  }, 600_000);

  afterAll(async () => {
    await f.close();
  });

  it("machine keys and resolve answer 200 while the owner's reveal answers its backend refusal; every KV request of the two carries the machine policy", async () => {
    const { token } = await issueFor(f, "env1a");
    const start = (await readAuditLog(f.stack)).length;
    const keys = await machineCall(f, "keys", { token });
    expect(keys.status, keys.code ?? "").toBe(200);
    expect(keys.body.count).toBe(3);
    const resolve = await machineCall(f, "resolve", { token });
    expect(resolve.status, resolve.code ?? "").toBe(200);
    expect(resolve.body.count).toBe(3);

    const policy = machineName(f.env("env1a").environmentId);
    const kv = (await readAuditLog(f.stack))
      .slice(start)
      .filter(
        (entry) =>
          entry.type === "request" &&
          entry.namespacePath.startsWith(f.fx.namespace) &&
          entry.path.startsWith("kv/"),
      );
    // One list per call and three reads for resolve.
    expect(kv.length).toBe(5);
    const policies = kv.map(
      (entry) => (JSON.parse(entry.raw) as { auth?: { policies?: string[] } }).auth?.policies ?? [],
    );
    expect(policies.every((list) => list.includes(policy))).toBe(true);

    // Control: the runtime identity is refused, so a human reveal cannot read.
    const reveal = await f.send("POST", `${f.env("env1a").path}/secrets/SEED_0000/reveal`, {
      body: {},
      key: null,
    });
    expect(reveal.status).toBe(503);
  });
});
