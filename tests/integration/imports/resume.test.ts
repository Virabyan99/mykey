// import.resume (Run 4.7 Task C, P-77, FR-1.36): an import waiting for its
// owner (awaiting_input) continues with the same file; each entry's child
// keeps its key, so no entry is written twice. Values are synthetic with a
// run-time canary; assertions compare digests, counts and booleans.
import { randomBytes, randomUUID } from "node:crypto";
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
  for (const env of ["env1a", "env1b"] as const) await expectIndexMatchesBackend(f, env);
});

const unique = (prefix = "M"): string =>
  `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
const valueOf = (label: string): string => `${mark}-${label}-${randomUUID()}`;
const fileOf = (...entries: [string, string][]): string =>
  entries.map(([name, value]) => `${name}=${value}\n`).join("");

function resume(
  env: EnvName,
  operationId: string,
  text: string,
  user: FixtureUser = "ownerA",
): Promise<Answer> {
  return f.send("POST", `${f.env(env).path}/import-operations/${operationId}/resume`, {
    text,
    user,
    key: null,
  });
}

/** An import of `text` left waiting after its first entry (budget 0). */
async function waiting(env: EnvName, text: string, user: FixtureUser = "ownerA"): Promise<string> {
  const previewed = await f.send("POST", `${f.env(env).path}/import/preview`, {
    text,
    user,
    key: null,
  });
  expect(previewed.status).toBe(200);
  f.setImportBudget(0);
  const answer = await f.send(
    "POST",
    `${f.env(env).path}/import/${previewed.body.previewId as string}/apply`,
    { text, user },
  );
  f.setImportBudget(null);
  expect(answer.status).toBe(202);
  expect(answer.body.state).toBe("awaiting_input");
  return answer.body.operationId as string;
}

async function childrenOf(parentId: string) {
  const result = await f.api.superuser.query<{ id: string; secret_name: string }>(
    "SELECT id, secret_name FROM app.operation WHERE parent_operation_id = $1 ORDER BY created_at",
    [parentId],
  );
  return result.rows;
}

const outcomes = (answer: Answer) =>
  (answer.body.result as { entries: { outcome: string }[] }).entries.map((entry) => entry.outcome);

describe("import.resume", () => {
  it("awaiting_input → resume with the same bytes → 200; no entry is written twice", async () => {
    const entries: [string, string][] = [
      [unique(), valueOf("1")],
      [unique(), valueOf("2")],
      [unique(), valueOf("3")],
    ];
    const text = fileOf(...entries);
    const parentId = await waiting("env1a", text);
    const answer = await resume("env1a", parentId, text);
    expect(answer.status).toBe(200);
    expect(answer.body.state).toBe("succeeded");
    expect(outcomes(answer)).toEqual(["created", "created", "created"]);
    const children = await childrenOf(parentId);
    expect(children.map((child) => child.secret_name)).toEqual(entries.map(([name]) => name));
    for (const child of children) expect(await f.auditedChanges(child.id)).toBe(1);
    for (const [name, value] of entries) {
      const shown = await f.send("POST", `${f.env("env1a").path}/secrets/${name}/reveal`, {
        body: {},
        key: null,
      });
      expect(sha256(shown.body.value as string)).toBe(sha256(value));
    }
    const audit = await f.api.superuser.query<{ outcome: string }>(
      "SELECT outcome FROM audit.event WHERE action = 'import.apply' AND operation_id = $1 ORDER BY occurred_at",
      [parentId],
    );
    expect(audit.rows.map((row) => row.outcome)).toEqual(["intent", "success"]);
  });

  it("other bytes → 422", async () => {
    const text = fileOf([unique(), valueOf("1")], [unique(), valueOf("2")]);
    const parentId = await waiting("env1a", text);
    const answer = await resume("env1a", parentId, `${text}${unique()}=x\n`);
    expect(answer.status).toBe(422);
    expect(answer.code).toBe("validation_failed");
    expect((await resume("env1a", parentId, text)).status).toBe(200);
  });

  it("another member, the owner included → 404; another environment → 404", async () => {
    const text = fileOf([unique(), valueOf("1")], [unique(), valueOf("2")]);
    const parentId = await waiting("env1a", text, "editorA");
    for (const user of ["ownerA", "adminA", "envEditorA"] as const) {
      const answer = await resume("env1a", parentId, text, user);
      expect(answer.status, user).toBe(404);
    }
    expect((await resume("env1b", parentId, text, "editorA")).status).toBe(404);
    expect((await resume("env1a", parentId, text, "editorA")).status).toBe(200);
  });

  it("a partial parent → 409 state_conflict", async () => {
    const taken = unique();
    const text = fileOf([unique(), valueOf("1")], [taken, valueOf("2")]);
    const parentId = await waiting("env1a", text);
    expect((await f.create("env1a", taken, valueOf("first"))).status).toBe(201);
    const finished = await resume("env1a", parentId, text);
    expect(finished.status).toBe(200);
    expect(finished.body.state).toBe("partial");
    const again = await resume("env1a", parentId, text);
    expect(again.status).toBe(409);
    expect(again.code).toBe("state_conflict");
  });

  it("two resumes at once: one works, the other gets 202", async () => {
    const text = fileOf(
      [unique(), valueOf("1")],
      [unique(), valueOf("2")],
      [unique(), valueOf("3")],
    );
    const parentId = await waiting("env1b", text);
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let held = false;
    f.setFaults(async (point) => {
      if (point !== "between_entries" || held) return;
      held = true;
      reached();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const first = resume("env1b", parentId, text);
    await inside;
    const second = await resume("env1b", parentId, text);
    expect(second.status).toBe(202);
    expect(second.body.operationId).toBe(parentId);
    expect(second.body.state).toBe("executing");
    release();
    const done = await first;
    expect(done.status).toBe(200);
    expect(done.body.state).toBe("succeeded");
    for (const child of await childrenOf(parentId))
      expect(await f.auditedChanges(child.id)).toBe(1);
  });

  it("a key changed while the import waited → conflict", async () => {
    const moved = unique();
    const start = await f.create("env1b", moved, valueOf("start"));
    expect(start.status).toBe(201);
    const text = fileOf([unique(), valueOf("1")], [moved, valueOf("import")]);
    const parentId = await waiting("env1b", text);
    const otherValue = valueOf("other");
    const current = start.body.result as { version: number; stateTag: string };
    expect((await f.update("env1b", moved, otherValue, current)).status).toBe(200);
    const answer = await resume("env1b", parentId, text);
    expect(answer.status).toBe(200);
    expect(answer.body.state).toBe("partial");
    expect(outcomes(answer)).toEqual(["created", "conflict"]);
    const shown = await f.send("POST", `${f.env("env1b").path}/secrets/${moved}/reveal`, {
      body: {},
      key: null,
    });
    expect(sha256(shown.body.value as string)).toBe(sha256(otherValue));
  });
});
