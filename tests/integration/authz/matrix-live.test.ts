// The authorization matrix on the real handlers (Run 4.9 Task C, P-80): the
// fifteen routes of Session 4 and the seven members, in environment 1a (and
// 1b for envEditorA). The expectation comes from `decide` (operations.get:
// the operation scope's rule — a manager, or the author). Allowed → a valid
// request answers 2xx. Denied → 403 action_denied. Hidden → the same 404 as a
// random id. Every cell that is not allowed changes nothing: no operation row
// of that user, no KV change in A's namespace while the request runs.
import { randomBytes, randomUUID } from "node:crypto";
import { decide, type Action, type Decision, type UserId } from "@mykey/contracts";
import { resolveAccess } from "@mykey/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";
import { readAuditLog } from "../../harness/stack.ts";
import { FIXTURE_USERS, type FixtureUser } from "../../harness/tenants.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

const unique = (): string => `ML_${randomBytes(5).toString("hex").toUpperCase()}`;
const synthetic = (): string => `matrix-${randomBytes(8).toString("hex")}`;

interface Current {
  version: number;
  stateTag: string;
}
const currentOf = (answer: Answer): Current => {
  expect(answer.status, `setup ${String(answer.status)} ${answer.code ?? ""}`).toBeLessThan(300);
  return answer.body.result as Current;
};

/** A key prepared by the owner in `env`. */
async function key(env: EnvName, steps: "live" | "updated" | "deleted" = "live") {
  const name = unique();
  const first = await f.create(env, name, synthetic());
  let current = currentOf(first);
  if (steps === "updated") current = currentOf(await f.update(env, name, synthetic(), current));
  if (steps === "deleted") current = currentOf(await f.act(env, name, "delete", current));
  return { name, current, operationId: first.operationId };
}

/** Setup by `setupUser` (the caller when allowed, the owner otherwise); answers the request. */
type Request = (path: string | null) => Promise<Answer>;
type Prepare = (
  user: FixtureUser,
  env: EnvName,
  setupUser: FixtureUser,
) => Request | Promise<Request>;

interface RouteCase {
  action: Action | null;
  scope: "environment" | "project" | "operation";
  prepare: Prepare;
}

const envPath = (env: EnvName, path: string | null): string => path ?? f.env(env).path;

const ROUTES: Record<string, RouteCase> = {
  "environments.list": {
    action: null,
    scope: "project",
    prepare: (user, env) => (path) => {
      const base = envPath(env, path);
      return f.send("GET", base.slice(0, base.lastIndexOf("/")), { user, key: null });
    },
  },
  "operations.list": {
    action: null,
    scope: "environment",
    prepare: (user, env) => (path) =>
      f.send("GET", `${envPath(env, path)}/operations`, { user, key: null }),
  },
  "operations.get": {
    action: null,
    scope: "operation",
    prepare: async (user, env) => {
      const { operationId } = await key(env);
      return (path) =>
        f.send("GET", `/v1/operations/${path === null ? operationId! : randomUUID()}`, {
          user,
          key: null,
        });
    },
  },
  "secrets.list": {
    action: "secrets.read",
    scope: "environment",
    prepare: (user, env) => (path) =>
      f.send("GET", `${envPath(env, path)}/secrets`, { user, key: null }),
  },
  "secrets.history": {
    action: "secrets.history",
    scope: "environment",
    prepare: async (user, env) => {
      const { name } = await key(env);
      return (path) =>
        f.send("GET", `${envPath(env, path)}/secrets/${name}/history`, { user, key: null });
    },
  },
  "secrets.reveal": {
    action: "secrets.read",
    scope: "environment",
    prepare: async (user, env) => {
      const { name } = await key(env);
      return (path) =>
        f.send("POST", `${envPath(env, path)}/secrets/${name}/reveal`, {
          user,
          body: {},
          key: null,
        });
    },
  },
  "secrets.create": {
    action: "secrets.write",
    scope: "environment",
    prepare: (user, env) => (path) =>
      f.send("POST", `${envPath(env, path)}/secrets`, {
        user,
        body: { name: unique(), value: synthetic() },
      }),
  },
  "secrets.update": {
    action: "secrets.write",
    scope: "environment",
    prepare: async (user, env) => {
      const { name, current } = await key(env);
      return (path) =>
        f.send("PATCH", `${envPath(env, path)}/secrets/${name}`, {
          user,
          body: {
            value: synthetic(),
            expectedVersion: current.version,
            expectedStateTag: current.stateTag,
          },
        });
    },
  },
  "secrets.delete": {
    action: "secrets.write",
    scope: "environment",
    prepare: async (user, env) => {
      const { name, current } = await key(env);
      return (path) =>
        f.send("POST", `${envPath(env, path)}/secrets/${name}/delete`, {
          user,
          body: {
            expectedVersion: current.version,
            expectedStateTag: current.stateTag,
            confirmed: true,
          },
        });
    },
  },
  "secrets.undelete": {
    action: "secrets.write",
    scope: "environment",
    prepare: async (user, env) => {
      const { name, current } = await key(env, "deleted");
      return (path) =>
        f.send("POST", `${envPath(env, path)}/secrets/${name}/undelete`, {
          user,
          body: {
            expectedVersion: current.version,
            expectedStateTag: current.stateTag,
            confirmed: true,
          },
        });
    },
  },
  "secrets.restore": {
    action: "secrets.write",
    scope: "environment",
    prepare: async (user, env) => {
      const { name, current } = await key(env, "updated");
      return (path) =>
        f.send("POST", `${envPath(env, path)}/secrets/${name}/restore`, {
          user,
          body: {
            sourceVersion: 1,
            expectedVersion: current.version,
            expectedStateTag: current.stateTag,
            confirmed: true,
          },
        });
    },
  },
  "import.preview": {
    action: "secrets.write",
    scope: "environment",
    prepare: (user, env) => (path) =>
      f.send("POST", `${envPath(env, path)}/import/preview`, {
        user,
        text: `${unique()}=${synthetic()}\n`,
        key: null,
      }),
  },
  "import.apply": {
    action: "secrets.write",
    scope: "environment",
    prepare: async (user, env, setupUser) => {
      const text = `${unique()}=${synthetic()}\n`;
      const preview = await f.send("POST", `${f.env(env).path}/import/preview`, {
        user: setupUser,
        text,
        key: null,
      });
      expect(preview.status, `preview ${preview.code ?? ""}`).toBe(200);
      const previewId = preview.body.previewId as string;
      return (path) =>
        f.send("POST", `${envPath(env, path)}/import/${previewId}/apply`, { user, text });
    },
  },
  "import.resume": {
    action: "secrets.write",
    scope: "environment",
    prepare: async (user, env, setupUser) => {
      const text = `${unique()}=${synthetic()}\n${unique()}=${synthetic()}\n`;
      const preview = await f.send("POST", `${f.env(env).path}/import/preview`, {
        user: setupUser,
        text,
        key: null,
      });
      expect(preview.status, `preview ${preview.code ?? ""}`).toBe(200);
      f.setImportBudget(0);
      let waiting: Answer;
      try {
        waiting = await f.send(
          "POST",
          `${f.env(env).path}/import/${preview.body.previewId as string}/apply`,
          { user: setupUser, text },
        );
      } finally {
        f.setImportBudget(null);
      }
      expect(waiting.status, `apply ${waiting.code ?? ""}`).toBe(202);
      const operationId = waiting.body.operationId as string;
      return (path) =>
        f.send("POST", `${envPath(env, path)}/import-operations/${operationId}/resume`, {
          user,
          text,
          key: null,
        });
    },
  },
  "export.create": {
    action: "secrets.read",
    scope: "environment",
    prepare: async (user, env) => {
      await f.api.superuser.query("UPDATE auth.session SET totp_verified_at = now()");
      return (path) =>
        f.send("POST", `${envPath(env, path)}/export`, {
          user,
          body: { confirmed: true },
          key: null,
        });
    },
  },
};

const CELLS: [FixtureUser, EnvName][] = [
  ...FIXTURE_USERS.map((user): [FixtureUser, EnvName] => [user, "env1a"]),
  ["envEditorA", "env1b"],
];

/** decide on current rows; operations.get: the operation scope's rule for the owner's operation. */
async function decisionOf(route: RouteCase, user: FixtureUser, env: EnvName): Promise<Decision> {
  const { projectId, environmentId } = f.env(env);
  const resolved = await resolveAccess(f.api.pool, f.tenants.userId(user) as UserId, {
    organizationId: f.tenants.a.organizationId,
    projectId,
    environmentId,
  });
  if (route.scope === "project") return decide(resolved.authority, { projectId }, route.action);
  const decision = decide(resolved.authority, { projectId, environmentId }, route.action);
  if (route.scope !== "operation" || decision !== "allow") return decision;
  const role = resolved.authority?.role;
  return role === "owner" || role === "admin" || user === "ownerA" ? "allow" : "hidden";
}

/** The environment's path with a random environment id: the 404 of an absent target. */
const randomPath = (env: EnvName): string => {
  const { path, environmentId } = f.env(env);
  return path.replace(environmentId, randomUUID());
};

async function operationsOf(user: FixtureUser): Promise<number> {
  const result = await f.api.superuser.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM app.operation WHERE principal_id = $1",
    [f.tenants.userId(user)],
  );
  return result.rows[0]?.count ?? 0;
}

/** KV changes in A's namespace recorded by OpenBao's audit device. */
async function kvChanges(): Promise<number> {
  return (await readAuditLog(f.stack)).filter(
    (entry) =>
      entry.type === "request" &&
      entry.namespacePath.startsWith(f.fx.namespace) &&
      /^kv\/(data|delete|undelete)\//.test(entry.path) &&
      (entry.operation === "create" || entry.operation === "update"),
  ).length;
}

const envelope = (answer: Answer): string => {
  const error = answer.body.error as { code?: string; message?: string } | undefined;
  return JSON.stringify({ status: answer.status, code: error?.code, message: error?.message });
};

describe("the matrix on real handlers", () => {
  it("every cell of the fifteen routes answers as decide says; a cell that is not allowed changes nothing", async () => {
    expect(Object.keys(ROUTES)).toHaveLength(15);
    const plan: { routeId: string; user: FixtureUser; env: EnvName; decision: Decision }[] = [];
    for (const [routeId, route] of Object.entries(ROUTES)) {
      for (const [user, env] of CELLS) {
        plan.push({ routeId, user, env, decision: await decisionOf(route, user, env) });
      }
    }
    // Controls: every kind of decision occurs, and the owner is allowed everywhere.
    expect(new Set(plan.map((cell) => cell.decision))).toEqual(
      new Set(["allow", "denied", "hidden"]),
    );
    expect(
      plan.filter((cell) => cell.user === "ownerA").every((cell) => cell.decision === "allow"),
    ).toBe(true);

    const wrong: string[] = [];
    let changedByAllowed = 0;
    for (const cell of plan) {
      const route = ROUTES[cell.routeId]!;
      const label = `${cell.routeId} ${cell.user} ${cell.env} (${cell.decision})`;
      const allowed = cell.decision === "allow";
      const request = await route.prepare(cell.user, cell.env, allowed ? cell.user : "ownerA");
      const operationsBefore = await operationsOf(cell.user);
      const changesBefore = await kvChanges();
      const answer = await request(null);
      const changes = (await kvChanges()) - changesBefore;
      if (allowed) {
        changedByAllowed += changes;
        if (answer.status < 200 || answer.status >= 300) {
          wrong.push(`${label}: ${String(answer.status)} ${answer.code ?? ""}`);
        }
        continue;
      }
      if (cell.decision === "denied") {
        if (answer.status !== 403 || answer.code !== "action_denied") {
          wrong.push(`${label}: ${String(answer.status)} ${answer.code ?? ""}`);
        }
      } else {
        const absent = await request(randomPath(cell.env));
        if (answer.status !== 404 || envelope(answer) !== envelope(absent)) {
          wrong.push(`${label}: ${envelope(answer)} vs absent ${envelope(absent)}`);
        }
      }
      if ((await operationsOf(cell.user)) !== operationsBefore) {
        wrong.push(`${label}: an operation row was written`);
      }
      if (changes !== 0) wrong.push(`${label}: ${String(changes)} KV changes`);
    }
    // Positive control: the KV count sees the changes an allowed write makes.
    expect(changedByAllowed).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
    await expectIndexMatchesBackend(f, "env1a");
    await expectIndexMatchesBackend(f, "env1b");
  }, 1_200_000);
});

// AC-1.08 "grants combine correctly", on the real handlers: a reader of the
// project who is also editor of one environment writes there and only reads
// elsewhere; when the second grant is removed, the next request is denied.
describe("two grants of one member", () => {
  it("a project reader with an editor grant on env1b writes in env1b, only reads in env1a, and loses the write when the grant goes", async () => {
    const db = f.api.superuser;
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO app.access_grant (id, organization_id, user_id, project_id, environment_id, role)
       VALUES (gen_random_uuid(), $1, $2, NULL, $3, 'editor') RETURNING id`,
      [f.tenants.a.organizationId, f.tenants.userId("readerA"), f.env("env1b").environmentId],
    );
    const grantId = inserted.rows[0]?.id;
    try {
      const written = await f.create("env1b", unique(), synthetic(), { user: "readerA" });
      expect(written.status).toBe(201);
      const refused = await f.create("env1a", unique(), synthetic(), { user: "readerA" });
      expect(refused.status).toBe(403);
      expect(refused.code).toBe("action_denied");
      const listed = await f.send("GET", `${f.env("env1a").path}/secrets`, { user: "readerA" });
      expect(listed.status).toBe(200);
    } finally {
      await db.query("DELETE FROM app.access_grant WHERE id = $1", [grantId]);
    }
    const after = await f.create("env1b", unique(), synthetic(), { user: "readerA" });
    expect(after.status).toBe(403);
    expect(after.code).toBe("action_denied");
    await expectIndexMatchesBackend(f, "env1b");
  });
});
