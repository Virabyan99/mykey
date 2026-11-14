// import.apply (Run 4.7 Task B, P-77, FR-1.36, AC-1.39): the previewed file is
// applied entry by entry, each written entry one child operation of the
// mutation protocol under the environment's lock, the lock free between
// entries. Every entry ends with one of seven outcomes; an unknown outcome
// stops the import and is settled through its child. Values are synthetic
// with a run-time canary; assertions compare digests, counts and booleans.
import { randomBytes, randomUUID } from "node:crypto";
import { LIMITS, type OperationId } from "@mykey/contracts";
import { reconcileOperation } from "@mykey/operations/operator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  idleAdvisoryLocks,
  sha256,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";
import type { FixtureUser } from "../../harness/tenants.ts";

let f: SecretsFixture;
const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  f.setFaults(null);
  f.setImportBudget(null);
  expect(await idleAdvisoryLocks(f)).toBe(0);
  for (const env of ["env1a", "env1b", "env2a"] as const) await expectIndexMatchesBackend(f, env);
});

const unique = (prefix = "A"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const valueOf = (label: string): string => `${mark}-${label}-${randomUUID()}`;
const fileOf = (...entries: [string, string][]): string =>
  entries.map(([name, value]) => `${name}=${value}\n`).join("");

function preview(env: EnvName, text: string, user: FixtureUser = "ownerA") {
  return f.send("POST", `${f.env(env).path}/import/preview`, { text, user, key: null });
}

function apply(
  env: EnvName,
  previewId: string,
  text: string,
  opts: { user?: FixtureUser; key?: string } = {},
): Promise<Answer> {
  return f.send("POST", `${f.env(env).path}/import/${previewId}/apply`, { text, ...opts });
}

async function previewed(env: EnvName, text: string): Promise<string> {
  const answer = await preview(env, text);
  expect(answer.status).toBe(200);
  expect(answer.body.applicable).toBe(true);
  return answer.body.previewId as string;
}

async function created(env: EnvName, name: string, value: string) {
  const answer = await f.create(env, name, value);
  expect(answer.status).toBe(201);
  return answer.body.result as { version: number; stateTag: string };
}

async function revealDigest(env: EnvName, name: string): Promise<string> {
  const answer = await f.send("POST", `${f.env(env).path}/secrets/${name}/reveal`, {
    body: {},
    key: null,
  });
  expect(answer.status).toBe(200);
  return sha256(answer.body.value as string);
}

async function entriesOf(parentId: string) {
  const result = await f.api.superuser.query<{
    ordinal: number;
    name: string;
    outcome: string | null;
    child_operation_id: string | null;
  }>(
    `SELECT ordinal, name, outcome, child_operation_id FROM app.import_entry
      WHERE parent_operation_id = $1 ORDER BY ordinal`,
    [parentId],
  );
  return result.rows;
}

async function childrenOf(parentId: string) {
  const result = await f.api.superuser.query<{ id: string; action: string; state: string }>(
    "SELECT id, action, state FROM app.operation WHERE parent_operation_id = $1 ORDER BY created_at",
    [parentId],
  );
  return result.rows;
}

const resultOf = (answer: Answer) =>
  answer.body.result as {
    counts: Record<string, number>;
    entries: { ordinal: number; name: string; outcome: string }[];
  };

describe("import.apply", () => {
  it("the previewed file applies: 200 succeeded; counts; every value's digest through reveal; one child per written entry; history names the caller; audited changes equal the written entries; an unchanged key keeps its version", async () => {
    const [fresh, changed, same] = [unique(), unique(), unique()];
    const values = { fresh: valueOf("new"), changed: valueOf("changed"), same: valueOf("same") };
    await created("env1a", changed, valueOf("old"));
    const kept = await created("env1a", same, values.same);
    const text = fileOf([fresh, values.fresh], [changed, values.changed], [same, values.same]);
    const previewId = await previewed("env1a", text);
    const answer = await apply("env1a", previewId, text);
    expect(answer.status).toBe(200);
    expect(answer.body.state).toBe("succeeded");
    const parentId = answer.body.operationId as string;
    expect(resultOf(answer).counts).toEqual({
      created: 1,
      updated: 1,
      unchanged: 1,
      conflict: 0,
      rejected: 0,
      uncertain: 0,
      not_attempted: 0,
    });
    expect(resultOf(answer).entries).toEqual([
      { ordinal: 1, name: fresh, outcome: "created" },
      { ordinal: 2, name: changed, outcome: "updated" },
      { ordinal: 3, name: same, outcome: "unchanged" },
    ]);
    expect(await revealDigest("env1a", fresh)).toBe(sha256(values.fresh));
    expect(await revealDigest("env1a", changed)).toBe(sha256(values.changed));
    expect(await revealDigest("env1a", same)).toBe(sha256(values.same));
    const children = await childrenOf(parentId);
    expect(children.map((child) => [child.action, child.state])).toEqual([
      ["secrets.create", "succeeded"],
      ["secrets.update", "succeeded"],
    ]);
    const history = await f.send("GET", `${f.env("env1a").path}/secrets/${changed}/history`, {
      key: null,
    });
    const versions = history.body.versions as { written: { actor: { id: string | null } } }[];
    expect(versions[0]?.written.actor.id).toBe(f.tenants.userId("ownerA"));
    let changes = 0;
    for (const child of children) changes += await f.auditedChanges(child.id);
    expect(changes).toBe(2);
    expect(await f.auditedChanges(parentId)).toBe(0);
    expect((await f.indexRow("env1a", same))?.current_version).toBe(kept.version);
    const audit = await f.api.superuser.query<{ outcome: string; details: unknown }>(
      "SELECT outcome, details FROM audit.event WHERE action = 'import.apply' AND operation_id = $1 ORDER BY occurred_at",
      [parentId],
    );
    expect(audit.rows.map((row) => row.outcome)).toEqual(["intent", "success"]);
  });

  it("the same key again replays the 200; no further change", async () => {
    const text = fileOf([unique(), valueOf("once")]);
    const previewId = await previewed("env1a", text);
    const key = randomUUID();
    const first = await apply("env1a", previewId, text, { key });
    expect(first.status).toBe(200);
    const parentId = first.body.operationId as string;
    const again = await apply("env1a", previewId, text, { key });
    expect(again.status).toBe(200);
    expect(again.body.operationId).toBe(parentId);
    expect((await childrenOf(parentId)).length).toBe(1);
  });

  it("other bytes → 422 and the preview is still unclaimed; another member's preview, or another environment's → 404; expired or applied already → 409 state_conflict", async () => {
    const name = unique();
    const text = fileOf([name, valueOf("bound")]);
    const previewId = await previewed("env1a", text);
    const claimed = async () =>
      (
        await f.api.superuser.query<{ claimed: string | null }>(
          "SELECT claimed_by_operation_id AS claimed FROM app.import_preview WHERE id = $1",
          [previewId],
        )
      ).rows[0]?.claimed ?? null;

    const other = await apply("env1a", previewId, fileOf([name, valueOf("other")]));
    expect(other.status).toBe(422);
    expect(other.code).toBe("validation_failed");
    expect(await claimed()).toBeNull();
    expect(await f.backend("env1a", name)).toBeNull();

    const member = await apply("env1a", previewId, text, { user: "adminA" });
    expect(member.status).toBe(404);
    const elsewhere = await apply("env1b", previewId, text);
    expect(elsewhere.status).toBe(404);
    expect(await claimed()).toBeNull();

    const first = await apply("env1a", previewId, text);
    expect(first.status).toBe(200);
    const second = await apply("env1a", previewId, text);
    expect(second.status).toBe(409);
    expect(second.code).toBe("state_conflict");

    const late = fileOf([unique(), valueOf("late")]);
    const expiring = await previewed("env1a", late);
    await f.api.superuser.query(
      "UPDATE app.import_preview SET expires_at = now() - interval '1 second' WHERE id = $1",
      [expiring],
    );
    const expired = await apply("env1a", expiring, late);
    expect(expired.status).toBe(409);
    expect(expired.code).toBe("state_conflict");
  });

  it("a key updated between preview and apply → that entry conflict, the rest applied, 200 partial, and the key holds the other writer's value", async () => {
    const [moved, fresh] = [unique(), unique()];
    const current = await created("env1b", moved, valueOf("start"));
    const text = fileOf([moved, valueOf("import")], [fresh, valueOf("fresh")]);
    const previewId = await previewed("env1b", text);
    const otherValue = valueOf("other-writer");
    expect((await f.update("env1b", moved, otherValue, current)).status).toBe(200);
    const answer = await apply("env1b", previewId, text);
    expect(answer.status).toBe(200);
    expect(answer.body.state).toBe("partial");
    expect(resultOf(answer).entries.map((entry) => entry.outcome)).toEqual(["conflict", "created"]);
    expect(await revealDigest("env1b", moved)).toBe(sha256(otherValue));
  });

  it("a name created between preview and apply → conflict", async () => {
    const name = unique();
    const text = fileOf([name, valueOf("import")]);
    const previewId = await previewed("env1b", text);
    const otherValue = valueOf("first");
    await created("env1b", name, otherValue);
    const answer = await apply("env1b", previewId, text);
    expect(answer.status).toBe(200);
    expect(answer.body.state).toBe("partial");
    expect(resultOf(answer).counts.conflict).toBe(1);
    expect(await revealDigest("env1b", name)).toBe(sha256(otherValue));
  });

  it("an unknown outcome at entry 3 of 5 → 503 outcome_unknown with the parent's id; settled through the child, the parent is partial and the status route shows the result", async () => {
    const names = [unique(), unique(), unique(), unique(), unique()];
    const text = fileOf(...names.map((name): [string, string] => [name, valueOf(name)]));
    const previewId = await previewed("env1a", text);
    let sends = 0;
    f.setFaults((point) => {
      if (point !== "after_send") return;
      sends += 1;
      if (sends === 3) throw new Error("fault: the answer to the third write is lost");
    });
    const answer = await apply("env1a", previewId, text);
    f.setFaults(null);
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("outcome_unknown");
    const parentId = answer.operationId!;
    const parent = await f.api.superuser.query<{ action: string; state: string }>(
      "SELECT action, state FROM app.operation WHERE id = $1",
      [parentId],
    );
    expect(parent.rows[0]).toEqual({ action: "import.apply", state: "uncertain" });
    const entries = await entriesOf(parentId);
    expect(entries.map((entry) => entry.outcome)).toEqual([
      "created",
      "created",
      "uncertain",
      null,
      null,
    ]);
    const blocked = await f.create("env1a", unique(), valueOf("blocked"));
    expect(blocked.status).toBe(409);
    expect(blocked.code).toBe("key_under_review");

    const child = entries[2]?.child_operation_id as OperationId;
    const verdict = await reconcileOperation(
      {
        database: f.api.database.pool("maintenance"),
        bao: f.operatorBao(),
        operatorId: null,
        requestId: randomUUID(),
      },
      child,
      { executorsExcluded: false },
    );
    expect(verdict.kind).toBe("succeeded");
    expect((await entriesOf(parentId)).map((entry) => entry.outcome)).toEqual([
      "created",
      "created",
      "created",
      "not_attempted",
      "not_attempted",
    ]);
    const status = await f.send("GET", `/v1/operations/${parentId}`, { key: null });
    expect(status.status).toBe(200);
    expect(status.body.state).toBe("partial");
    expect(resultOf(status).counts).toMatchObject({ created: 3, not_attempted: 2 });
    expect(await f.backend("env1a", names[3] ?? "")).toBeNull();
  });

  it("the budget: with budgetMs 0 the answer after the first entry is 202 awaiting_input", async () => {
    const text = fileOf(
      [unique(), valueOf("1")],
      [unique(), valueOf("2")],
      [unique(), valueOf("3")],
    );
    const previewId = await previewed("env1b", text);
    f.setImportBudget(0);
    const answer = await apply("env1b", previewId, text);
    expect(answer.status).toBe(202);
    expect(answer.body.state).toBe("awaiting_input");
    const parentId = answer.body.operationId as string;
    expect((await entriesOf(parentId)).map((entry) => entry.outcome)).toEqual([
      "created",
      null,
      null,
    ]);
  });

  it("the lock is free between entries: a reveal of another key answers 200 while the import waits in a hook", async () => {
    const other = unique();
    await created("env1a", other, valueOf("other"));
    const text = fileOf([unique(), valueOf("1")], [unique(), valueOf("2")]);
    const previewId = await previewed("env1a", text);
    let release: () => void = () => undefined;
    let waiting: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    let held = false;
    f.setFaults(async (point) => {
      if (point !== "between_entries" || held) return;
      held = true;
      waiting();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const pending = apply("env1a", previewId, text);
    await reached;
    const reveal = await f.send("POST", `${f.env("env1a").path}/secrets/${other}/reveal`, {
      body: {},
      key: null,
    });
    expect(reveal.status).toBe(200);
    release();
    expect((await pending).status).toBe(200);
  });

  it("children are not in operations.list; the parent is", async () => {
    const text = fileOf([unique(), valueOf("listed")]);
    const previewId = await previewed("env1b", text);
    const answer = await apply("env1b", previewId, text);
    expect(answer.status).toBe(200);
    const parentId = answer.body.operationId as string;
    const children = (await childrenOf(parentId)).map((child) => child.id);
    expect(children.length).toBe(1);
    const listed = await f.send("GET", `${f.env("env1b").path}/operations?limit=100`, {
      key: null,
    });
    expect(listed.status).toBe(200);
    const ids = (listed.body.operations as { operationId: string }[]).map((op) => op.operationId);
    expect(ids).toContain(parentId);
    expect(ids.some((id) => children.includes(id))).toBe(false);
  });

  it("1,000 entries of 100 bytes finish", async () => {
    const count = LIMITS.environment.maxNames;
    const entries = Array.from({ length: count }, (_, index): [string, string] => [
      `BULK_${String(index).padStart(4, "0")}`,
      randomBytes(50).toString("hex"),
    ]);
    const text = fileOf(...entries);
    const previewId = await previewed("env2a", text);
    const started = performance.now();
    let answer = await apply("env2a", previewId, text);
    const parentId = answer.body.operationId as string;
    const requests: string[] = [];
    // A request that spends its budget answers 202; the owner resumes with the same file.
    for (let round = 0; answer.status === 202 && round < 5; round += 1) {
      requests.push(`${String(answer.status)} ${answer.body.state as string}`);
      expect(answer.body.state).toBe("awaiting_input");
      answer = await f.send("POST", `${f.env("env2a").path}/import-operations/${parentId}/resume`, {
        text,
        key: null,
      });
    }
    requests.push(`${String(answer.status)} ${answer.body.state as string}`);
    const seconds = (performance.now() - started) / 1000;
    expect(answer.status).toBe(200);
    expect(answer.body.state).toBe("succeeded");
    const done = (await entriesOf(parentId)).filter((entry) => entry.outcome === "created").length;
    expect(done).toBe(count);
    expect((await childrenOf(parentId)).length).toBe(count);
    console.log(
      `import of ${String(count)} entries: ${requests.join(" → ")} in ${seconds.toFixed(1)} s (${((seconds / done) * 100).toFixed(2)} s per hundred)`,
    );
  }, 900_000);

  it("no table of app, audit or jobs contains the canary after an import", async () => {
    const text = fileOf([unique(), valueOf("search")], [unique(), valueOf("search2")]);
    const previewId = await previewed("env1b", text);
    expect((await apply("env1b", previewId, text)).status).toBe(200);
    const tables = await f.api.superuser.query<{ schema: string; name: string }>(
      `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
        WHERE table_type = 'BASE TABLE' AND table_schema IN ('app', 'audit', 'jobs')`,
    );
    const searched: string[] = [];
    for (const table of tables.rows) {
      const result = await f.api.superuser.query<{ text: string }>(
        `SELECT coalesce(string_agg(row_to_json(t)::text, ''), '') AS text FROM "${table.schema}"."${table.name}" t`,
      );
      expect(result.rows[0]?.text.includes(mark), `${table.schema}.${table.name}`).toBe(false);
      searched.push(`${table.schema}.${table.name}`);
    }
    for (const required of [
      "app.import_preview",
      "app.import_entry",
      "app.operation",
      "app.operation_step",
      "app.outbox",
      "audit.event",
    ]) {
      expect(searched).toContain(required);
    }
  });
});
