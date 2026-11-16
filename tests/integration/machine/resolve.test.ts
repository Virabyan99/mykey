// Run 5.4 Task B (P-94, FR-1.44, FR-1.47, D-42): machine.resolve is the
// complete read of Run 4.8 with the presented token: every live value of one
// generation or nothing, the audit row committed before the body leaves, one
// buffered body. A dead token is 401 and closes nothing (Review focus 3); a
// live token whose policy cannot read is drift. Values are synthetic and
// compared by digest; tokens are locals.
import { randomBytes, randomUUID } from "node:crypto";
import type { OperationId } from "@mykey/contracts";
import { machineName, renderMachinePolicy } from "@mykey/openbao";
import { reconcileOperation } from "@mykey/operations/operator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  issueFor,
  rootRevoke,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import {
  digestOf,
  exportDigests,
  machineCall,
  resolveDigests,
  type MachineAnswer,
} from "../../harness/machine.ts";
import { baoAnswer } from "../../harness/bao-raw.ts";
import { idleAdvisoryLocks, type EnvName } from "../../harness/secrets-fixture.ts";

let f: CredentialsFixture;

beforeAll(async () => {
  f = await createCredentialsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  f.setFaults(null);
  f.setBeforeHandler(null);
  f.relay.clear();
  expect(await idleAdvisoryLocks(f)).toBe(0);
});

const q = () => f.api.superuser;
const unique = (prefix = "R"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const synthetic = (label: string): string => `synthetic-${label}-${randomUUID()}`;

async function created(env: EnvName, name: string, value: string) {
  const answer = await f.create(env, name, value);
  expect(answer.status).toBe(201);
  return answer.body.result as { version: number; stateTag: string };
}

async function generationOf(env: EnvName): Promise<string> {
  const rows = await q().query<{ generation: string }>(
    "SELECT metadata_generation::text AS generation FROM app.environment WHERE id = $1",
    [f.env(env).environmentId],
  );
  return rows.rows[0]?.generation ?? "";
}

async function auditRows(action: string, answer: MachineAnswer) {
  const rows = await q().query<{
    actor_kind: string;
    actor_id: string;
    details: Record<string, unknown>;
  }>(
    "SELECT actor_kind, actor_id, details FROM audit.event WHERE action = $1 AND request_id = $2",
    [action, answer.headers.get("x-request-id")],
  );
  return rows.rows;
}

async function accessorOf(credentialId: string): Promise<string> {
  const rows = await q().query<{ accessor: string }>(
    "SELECT accessor FROM app.machine_credential WHERE id = $1",
    [credentialId],
  );
  return rows.rows[0]!.accessor;
}

async function driftEventsSince(since: Date): Promise<number> {
  const rows = await q().query<{ count: number }>(
    "SELECT count(*)::int AS count FROM audit.event WHERE action = 'system.drift_detected' AND occurred_at >= $1",
    [since],
  );
  return rows.rows[0]?.count ?? 0;
}

const clock = async (): Promise<Date> =>
  (await q().query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;

async function environmentState(env: EnvName): Promise<string> {
  const rows = await q().query<{ state: string }>(
    "SELECT state FROM app.environment WHERE id = $1",
    [f.env(env).environmentId],
  );
  return rows.rows[0]?.state ?? "";
}

describe("machine.resolve", () => {
  it("resolve returns exactly the live set: the owner's export digests, the generation, one buffered body, no-store, no compression", async () => {
    const names = [unique("L"), unique("L"), unique("L")];
    const results = [];
    for (const name of names) results.push(await created("env1a", name, synthetic(name)));
    const deleted = await f.act("env1a", names[1]!, "delete", results[1]!);
    expect(deleted.status).toBe(200);
    const { token } = await issueFor(f, "env1a");

    const answer = await machineCall(f, "resolve", {
      token,
      headers: { "accept-encoding": "gzip, deflate, br" },
    });
    expect(answer.status, answer.code ?? "").toBe(200);
    const exported = await exportDigests(f, "env1a");
    const resolved = resolveDigests(answer);
    expect(new Map(resolved)).toEqual(exported);
    expect(resolved.map(([name]) => name)).not.toContain(names[1]);
    expect(answer.body.count).toBe(resolved.length);
    expect(answer.body.complete).toBe(true);
    expect(answer.body.generation).toBe(await generationOf("env1a"));
    expect(Number(answer.headers.get("content-length"))).toBe(answer.bytes.length);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("content-encoding")).toBeNull();
  });

  it("current values only: after an update resolve returns the new digest", async () => {
    const name = unique("U");
    const first = await created("env1a", name, synthetic("v1"));
    const second = synthetic("v2");
    const updated = await f.update("env1a", name, second, first);
    expect(updated.status).toBe(200);
    const { token } = await issueFor(f, "env1a");
    const answer = await machineCall(f, "resolve", { token });
    expect(answer.status).toBe(200);
    expect(new Map(resolveDigests(answer)).get(name)).toBe(digestOf(second));
  });

  it("the audit row is committed before the body leaves: one machine.resolve row with a machine actor, names and generation, no name of a secret", async () => {
    const name = unique("A");
    await created("env1b", name, synthetic("audited"));
    const { token, credentialId } = await issueFor(f, "env1b");
    const answer = await machineCall(f, "resolve", { token, env: "env1b" });
    expect(answer.status).toBe(200);
    const rows = await auditRows("machine.resolve", answer);
    expect(rows).toEqual([
      {
        actor_kind: "machine",
        actor_id: credentialId,
        details: { names: answer.body.count, generation: answer.body.generation },
      },
    ]);
    expect(JSON.stringify(rows[0]?.details).includes(name)).toBe(false);
  });

  it("a throw at before_audit_commit → 503 audit_unavailable, no entry; the lock's session terminated there → 503 dependency_unavailable", async () => {
    await created("env1b", unique("F"), synthetic("fault"));
    const { token } = await issueFor(f, "env1b");
    f.setFaults((point) => {
      if (point === "before_audit_commit") throw new Error("fault: audit");
    });
    const audit = await machineCall(f, "resolve", { token, env: "env1b" });
    expect([audit.status, audit.code]).toEqual([503, "audit_unavailable"]);
    expect(audit.body.entries).toBeUndefined();
    expect(await auditRows("machine.resolve", audit)).toEqual([]);
    f.setFaults(async (point) => {
      if (point !== "before_audit_commit") return;
      await q().query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
          WHERE locktype = 'advisory' AND granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
    });
    const lost = await machineCall(f, "resolve", { token, env: "env1b" });
    expect([lost.status, lost.code]).toEqual([503, "dependency_unavailable"]);
    expect(lost.body.entries).toBeUndefined();
    f.setFaults(null);
    expect((await machineCall(f, "resolve", { token, env: "env1b" })).status).toBe(200);
  });

  it("an unresolved write holds the slot → 409 key_under_review with the holder's operation id; a key in review → 409 key_under_review", async () => {
    const { token } = await issueFor(f, "env1b");
    const name = unique("S");
    f.setFaults((point) => {
      if (point === "after_send") throw new Error("fault: the answer is lost");
    });
    const write = await f.create("env1b", name, synthetic("slot"));
    f.setFaults(null);
    expect(write.code).toBe("outcome_unknown");
    const holder = write.operationId as OperationId;
    for (const route of ["keys", "resolve"] as const) {
      const answer = await machineCall(f, route, { token, env: "env1b" });
      expect([answer.status, answer.code], route).toEqual([409, "key_under_review"]);
      expect((answer.body.error as { operationId?: string }).operationId).toBe(holder);
    }
    const verdict = await reconcileOperation(
      {
        database: f.api.database.pool("maintenance"),
        bao: f.operatorBao(),
        operatorId: null,
        requestId: randomUUID(),
      },
      holder,
      { executorsExcluded: false },
    );
    expect(verdict.kind).toBe("succeeded");
    const review = unique("V");
    await f.seedIndex("env1b", [review], "needs_review");
    try {
      const answer = await machineCall(f, "resolve", { token, env: "env1b" });
      expect([answer.status, answer.code]).toEqual([409, "key_under_review"]);
    } finally {
      await f.unseedIndex("env1b", [review]);
    }
    expect((await machineCall(f, "resolve", { token, env: "env1b" })).status).toBe(200);
  });
});

describe("dead tokens and broken policies (Review focus 3)", () => {
  it("a token that dies mid-request is 401 and closes nothing: no entry, the environment active, no drift event, the owner's export right after answers 200", async () => {
    await created("env1a", unique("D"), synthetic("dies"));
    const { token, credentialId } = await issueFor(f, "env1a");
    const accessor = await accessorOf(credentialId);
    const since = await clock();
    f.setBeforeHandler(async (routeId) => {
      if (routeId === "machine.resolve") await rootRevoke(f, accessor);
    });
    const answer = await machineCall(f, "resolve", { token });
    f.setBeforeHandler(null);
    expect([answer.status, answer.code]).toEqual([401, "unauthenticated"]);
    expect(answer.body.entries).toBeUndefined();
    expect(await environmentState("env1a")).toBe("active");
    expect(await driftEventsSince(since)).toBe(0);
    expect((await exportDigests(f, "env1a")).size).toBeGreaterThan(0);
  });

  it("the credential is revoked through the product between authentication and the recheck: 401, no entry", async () => {
    await created("env1a", unique("P"), synthetic("revoked"));
    const own = await issueFor(f, "env1a");
    f.setBeforeHandler(async (routeId) => {
      if (routeId !== "machine.resolve") return;
      await f.freshen();
      const revoked = await f.revoke("env1a", own.credentialId);
      expect(revoked.status).toBe(200);
    });
    const answer = await machineCall(f, "resolve", { token: own.token });
    f.setBeforeHandler(null);
    expect([answer.status, answer.code]).toEqual([401, "unauthenticated"]);
    expect(answer.body.entries).toBeUndefined();
  });

  it("a live token whose policy cannot read is drift: 503 backend_inconsistent, the environment needs_review", async () => {
    await created("env1b", unique("Y"), synthetic("policy"));
    const { token } = await issueFor(f, "env1b");
    const { projectId, environmentId } = f.env("env1b");
    const name = machineName(environmentId);
    const put = (policy: string) =>
      baoAnswer(f.stack, f.stack.bao.rootToken, "PUT", `sys/policies/acl/${name}`, {
        namespace: f.fx.namespace,
        body: { policy },
      });
    expect((await put('path "auth/token/lookup-self" { capabilities = ["read"] }')).status).toBe(
      204,
    );
    try {
      const answer = await machineCall(f, "resolve", { token, env: "env1b" });
      expect([answer.status, answer.code]).toEqual([503, "backend_inconsistent"]);
      expect(await environmentState("env1b")).toBe("needs_review");
    } finally {
      expect((await put(renderMachinePolicy(projectId, environmentId))).status).toBe(204);
      await q().query(
        "UPDATE app.environment SET state = 'active', review_reason = NULL WHERE id = $1",
        [environmentId],
      );
    }
  });
});

describe("races and limits", () => {
  it("a writer races the read — 50 rounds: every 200 body is the complete set of one generation", async () => {
    const name = unique("W");
    let expected = await created("env2a", name, synthetic("w0"));
    let current = digestOf(
      (
        await f.send("POST", `${f.env("env2a").path}/secrets/${name}/reveal`, {
          body: {},
          key: null,
        })
      ).body.value as string,
    );
    const { token } = await issueFor(f, "env2a");
    const others = new Map((await exportDigests(f, "env2a")).entries());
    others.delete(name);
    let served = 0;
    for (let round = 0; round < 50; round += 1) {
      const next = synthetic(`w${String(round + 1)}`);
      const [update, answer] = await Promise.all([
        f.update("env2a", name, next, expected),
        machineCall(f, "resolve", { token, env: "env2a" }),
      ]);
      if (answer.status === 200) {
        served += 1;
        const seen = new Map(resolveDigests(answer));
        const value = seen.get(name);
        seen.delete(name);
        expect(seen).toEqual(others);
        expect([current, digestOf(next)]).toContain(value);
      } else {
        expect(["busy", "environment_changed"], `resolve: ${answer.code ?? ""}`).toContain(
          answer.code,
        );
      }
      if (update.status === 200) {
        expected = update.body.result as { version: number; stateTag: string };
        current = digestOf(next);
      } else {
        expect(update.code, "update").toBe("busy");
      }
    }
    expect(served).toBeGreaterThan(0);
  }, 300_000);

  it("1,000 names of 8 KiB resolve inside the deadline; three resolves at once: the third answers 503 busy", async () => {
    // env2a holds the writer race's key besides the seeded ones.
    await f.seedEnvironment("env2a", 1000, 8192);
    const { token } = await issueFor(f, "env2a");
    const started = performance.now();
    const answer = await machineCall(f, "resolve", { token, env: "env2a" });
    const seconds = (performance.now() - started) / 1000;
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(answer.body.count).toBeGreaterThanOrEqual(1000);
    expect(seconds).toBeLessThan(60);
    console.log(`machine resolve of 1,000 names of 8 KiB: ${seconds.toFixed(2)} s`);

    const releases: (() => void)[] = [];
    let arrived = 0;
    let held: () => void = () => undefined;
    const bothHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    f.setFaults(async (point) => {
      if (point !== "after_backend_read" || arrived >= 2) return;
      arrived += 1;
      if (arrived === 2) held();
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    });
    const one = await issueFor(f, "env1a");
    const two = await issueFor(f, "env1b");
    const first = machineCall(f, "resolve", { token: one.token, env: "env1a" });
    const second = machineCall(f, "resolve", { token: two.token, env: "env1b" });
    await bothHeld;
    const third = await machineCall(f, "resolve", { token, env: "env2a" });
    expect([third.status, third.code]).toEqual([503, "busy"]);
    for (const release of releases) release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  }, 300_000);
});
