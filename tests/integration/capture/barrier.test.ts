// Run 6.5 Task A (P-118, D-51, FR-1.66): writing is closed by a trigger while a
// pair is captured. Two closures: admission (every mutating route, every auth
// route that writes, the provisioner before a job, the API's sweeps) refuses
// while the mode is not idle, answering 503 busy; and a statement trigger on
// every table of app and auth but four raises MKC01 while the mode is
// `capturing`. Reads continue with their audit rows; the actions that reduce
// access continue and leave a backup_invalidation row behind.
import { randomUUID } from "node:crypto";
import { operationSweepPass } from "@mykey/api";
import { AUTOMATION_RIGHTS, EXPANDING_ROUTES, ROUTES, type RouteDef } from "@mykey/contracts";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { signInComplete } from "../../harness/api.ts";
import {
  AUTOMATION_ROUTES,
  automationCall,
  clearAutomation,
  issueAutomationFor,
} from "../../harness/automation.ts";
import {
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { accessorAnswer, archive, newProject } from "../../harness/lifecycle-fixture.ts";
import { machineCall } from "../../harness/machine.ts";
import { pathIn, requestOf, automationClass } from "../authz/requests.ts";

let f: CredentialsFixture;

/** The four tables the trigger leaves open. */
const OPEN_TABLES = [
  "app.rate_limit",
  "app.service_control",
  "app.backup_pair",
  "app.backup_invalidation",
];

beforeAll(async () => {
  f = await createCredentialsFixture();
  const made = await f.create("env1a", "BARRIER_SEED", "synthetic-seed");
  expect(made.status).toBe(201);
}, 600_000);

afterEach(async () => {
  await setMode("idle");
});

afterAll(async () => {
  await f.close();
});

type Mode = "idle" | "draining" | "capturing";

async function setMode(mode: Mode): Promise<void> {
  await f.api.database
    .pool("maintenance")
    .query(
      "UPDATE app.service_control SET capture_mode = $1, owner = $2, pair_id = NULL, updated_at = now()",
      [mode, mode === "idle" ? null : "barrier-test"],
    );
}

/** The SQLSTATE a statement fails with, or null. */
async function failure(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await pool.query(sql, params);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

/** Every table of app and auth, and those carrying the barrier trigger. */
async function tables(): Promise<{ all: string[]; barred: string[] }> {
  const all = await f.api.superuser.query<{ name: string }>(
    `SELECT schemaname || '.' || tablename AS name FROM pg_tables
      WHERE schemaname IN ('app', 'auth') ORDER BY 1`,
  );
  const barred = await f.api.superuser.query<{ name: string }>(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE t.tgname = 'capture_barrier' AND NOT t.tgisinternal ORDER BY 1`,
  );
  return { all: all.rows.map((r) => r.name), barred: barred.rows.map((r) => r.name) };
}

const route = (id: string): RouteDef => ROUTES.find((candidate) => candidate.id === id)!;
const ids = () => ({
  org: f.tenants.a.organizationId,
  project: f.tenants.a.project1,
  env: f.tenants.a.env1a,
});

async function footprint(): Promise<{ operations: number; audit: number; bao: number }> {
  const counts = await f.api.superuser.query<{ operations: number; audit: number }>(
    `SELECT (SELECT count(*)::int FROM app.operation) AS operations,
            (SELECT count(*)::int FROM audit.event WHERE outcome = 'success') AS audit`,
  );
  return { ...counts.rows[0]!, bao: f.relay.forwardedAt.length };
}

async function invalidations(): Promise<string[]> {
  const rows = await f.api.superuser.query<{ reason: string }>(
    "SELECT reason FROM app.backup_invalidation ORDER BY at",
  );
  return rows.rows.map((row) => row.reason);
}

describe("who may change the control row", () => {
  it("api_runtime, provisioner_runtime and backup_reader cannot change service_control", async () => {
    for (const role of ["api_runtime", "provisioner_runtime", "backup_reader"] as const) {
      const pool = f.api.database.pool(role);
      for (const sql of [
        "UPDATE app.service_control SET capture_mode = 'draining'",
        "UPDATE app.service_control SET updated_at = now()",
        "INSERT INTO app.service_control (id) VALUES (true)",
        "DELETE FROM app.service_control",
      ]) {
        const code = await failure(pool, sql);
        expect(["42501", "MKC02"], `${role}: ${sql}`).toContain(code);
      }
    }
    const row = await f.api.superuser.query<{ capture_mode: string }>(
      "SELECT capture_mode FROM app.service_control",
    );
    expect(row.rows[0]?.capture_mode).toBe("idle");
  });

  it("maintenance can", async () => {
    await setMode("draining");
    await setMode("idle");
  });

  it("api_runtime can still lock the row FOR SHARE", async () => {
    const client = await f.api.database.pool("api_runtime").connect();
    try {
      await client.query("BEGIN");
      const row = await client.query<{ capture_mode: string }>(
        "SELECT capture_mode FROM app.service_control FOR SHARE",
      );
      expect(row.rows[0]?.capture_mode).toBe("idle");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("api_runtime can neither write backup_pair nor backup_invalidation directly", async () => {
    const pool = f.api.database.pool("api_runtime");
    expect(
      await failure(pool, `INSERT INTO app.backup_invalidation (reason) VALUES ('sign_out')`),
    ).toBe("42501");
    expect(await failure(pool, "UPDATE app.backup_pair SET validation_status = 'eligible'")).toBe(
      "42501",
    );
  });
});

describe("the trigger", () => {
  it("every table of app and auth except the four has the barrier trigger", async () => {
    const { all, barred } = await tables();
    expect(all.length).toBeGreaterThan(20);
    expect(barred).toEqual(all.filter((name) => !OPEN_TABLES.includes(name)));
  });

  it("in capturing, a write to each barred table raises MKC01; in draining and idle it does not", async () => {
    const { barred } = await tables();
    for (const mode of ["idle", "draining", "capturing"] as const) {
      await setMode(mode);
      for (const name of barred) {
        // A statement that changes nothing still fires a statement trigger.
        const code = await failure(f.api.superuser, `DELETE FROM ${name} WHERE false`);
        expect(code, `${mode}: ${name}`).toBe(mode === "capturing" ? "MKC01" : null);
      }
    }
  });

  it("as api_runtime, an insert into app.operation raises MKC01 in capturing", async () => {
    await setMode("capturing");
    const code = await failure(
      f.api.database.pool("api_runtime"),
      `INSERT INTO app.operation (id, principal_kind, principal_id, action, target, idempotency_key, state)
       VALUES ($1::uuid, 'operator', 'barrier', 'barrier.test', $1::text, $1::text, 'accepted')`,
      [randomUUID()],
    );
    expect(code).toBe("MKC01");
  });

  it("audit.event and rate_limit accept writes in every mode", async () => {
    for (const mode of ["idle", "draining", "capturing"] as const) {
      await setMode(mode);
      const pool = f.api.database.pool("api_runtime");
      expect(
        await failure(
          pool,
          `INSERT INTO audit.event (id, actor_kind, action, outcome) VALUES (gen_random_uuid(), 'system', 'system.health_probe', 'success')`,
        ),
        mode,
      ).toBeNull();
      expect(
        await failure(
          pool,
          `INSERT INTO app.rate_limit (scope, key_digest, window_start, count) VALUES ('rl:source', $1, now(), 1)`,
          [randomUUID()],
        ),
        mode,
      ).toBeNull();
    }
    await f.api.superuser
      .query(
        "DELETE FROM audit.event WHERE action = 'system.health_probe' AND actor_kind = 'system'",
      )
      .catch(() => undefined);
  });
});

/** One request of every closed route as ownerA, fresh; the answers by id. */
async function everyClosedRoute(): Promise<Map<string, { status: number; body: string }>> {
  const cookie = await f.tenants.cookie("ownerA");
  const answers = new Map<string, { status: number; body: string }>();
  for (const def of ROUTES.filter(
    (candidate) => EXPANDING_ROUTES.has(candidate.id) || candidate.id === "session.activity",
  )) {
    if (def.auth === "reset_flow") continue;
    // Session 11: sent with their own bearer (their own test below).
    if (automationClass(def)) continue;
    const request = requestOf(def);
    const response = await f.api.request(def.method, pathIn(def, ids()), { ...request, cookie });
    answers.set(def.id, { status: response.status, body: await response.text() });
  }
  const reset = route("auth.reset.complete");
  const response = await f.api.request(reset.method, pathIn(reset, ids()), requestOf(reset));
  answers.set(reset.id, { status: response.status, body: await response.text() });
  for (const path of [
    "/v1/auth/change-password",
    "/v1/auth/totp/enroll",
    "/v1/auth/totp/activate",
    "/v1/auth/recovery/regenerate",
  ]) {
    const answer = await f.api.request("POST", path, { body: {}, cookie });
    answers.set(`POST ${path}`, { status: answer.status, body: await answer.text() });
  }
  const { email, password } = f.tenants.credentials("readerA");
  const signIn = await f.api.request("POST", "/v1/auth/sign-in/email", {
    body: { email, password },
  });
  answers.set("POST /v1/auth/sign-in/email", { status: signIn.status, body: await signIn.text() });
  return answers;
}

describe("the API while a pair is captured", () => {
  for (const mode of ["draining", "capturing"] as const) {
    it(`${mode}: every closed route answers 503 busy and wrote nothing; no OpenBao request`, async () => {
      await f.freshen();
      await f.tenants.cookie("ownerA");
      await setMode(mode);
      const before = await footprint();
      const answers = await everyClosedRoute();
      // Session 11: the expanding automation routes are not in this walk (the next test).
      const unauthenticated = ROUTES.filter(
        (candidate) => EXPANDING_ROUTES.has(candidate.id) && automationClass(candidate),
      );
      expect(unauthenticated.map((candidate) => candidate.id)).toEqual([
        "automation.projects.create",
        "automation.environments.create",
        "automation.secrets.create",
        "automation.runtime_credentials.issue",
      ]);
      expect(answers.size).toBe(EXPANDING_ROUTES.size + 2 - unauthenticated.length);
      for (const [id, answer] of answers) {
        expect(answer.status, `${id}: ${answer.body}`).toBe(503);
        expect((JSON.parse(answer.body) as { error: { code: string } }).error.code, id).toBe(
          "busy",
        );
      }
      expect(await footprint()).toEqual(before);
    }, 300_000);

    // Session 11 (Run 11.5): an automation request meets the barrier as a person's does.
    it(`${mode}: every automation mutation but the revocation answers 503 busy and wrote nothing; a session is 401`, async () => {
      const automation = await issueAutomationFor(f, { rights: [...AUTOMATION_RIGHTS] });
      await f.api.superuser.query("UPDATE app.project SET managed_by = $2 WHERE id = $1", [
        ids().project,
        automation.ownerId,
      ]);
      try {
        await setMode(mode);
        const before = await footprint();
        const own = { project: ids().project, env: ids().env };
        const mutations = AUTOMATION_ROUTES.filter((def) => def.method !== "GET");
        expect(mutations).toHaveLength(5);
        for (const def of mutations) {
          const answer = await automationCall(f, def.id, { secret: automation.secret, ids: own });
          if (def.id === "automation.runtime_credentials.revoke") {
            // A revocation reduces access: the barrier lets it through, and the
            // credential it names (a random id) is nobody's.
            expect([answer.status, answer.code], def.id).toEqual([404, "not_found"]);
          } else {
            expect([answer.status, answer.code], def.id).toEqual([503, "busy"]);
          }
        }
        expect(await footprint()).toEqual(before);
        for (const def of ROUTES.filter(automationClass)) {
          const response = await f.api.request(def.method, pathIn(def, ids()), {
            ...requestOf(def),
            cookie: await f.tenants.cookie("ownerA"),
          });
          expect(response.status, def.id).toBe(401);
        }
        expect(await footprint()).toEqual(before);
      } finally {
        await setMode("idle");
        await clearAutomation(f);
      }
    }, 300_000);

    it(`${mode}: lists, history, reveal, export and machine resolve are served with their audit rows`, async () => {
      const credential = await issueFor(f, "env1a");
      await f.freshen();
      await f.tenants.cookie("ownerA");
      await setMode(mode);
      const path = f.env("env1a").path;
      expect((await f.send("GET", `${path}/secrets`)).status).toBe(200);
      expect((await f.send("GET", `${path}/secrets/BARRIER_SEED/history`)).status).toBe(200);
      expect((await f.send("GET", `${path}/credentials`)).status).toBe(200);
      const since = new Date();
      const reveal = await f.send("POST", `${path}/secrets/BARRIER_SEED/reveal`, { body: {} });
      expect(reveal.status, reveal.code ?? "").toBe(200);
      const exported = await f.api.request("POST", `${path}/export`, {
        cookie: await f.tenants.cookie("ownerA"),
        body: { confirmed: true },
      });
      expect(exported.status, await exported.clone().text()).toBe(200);
      const resolved = await machineCall(f, "resolve", { token: credential.token });
      expect(resolved.status, resolved.code ?? "").toBe(200);
      const rows = await f.api.superuser.query<{ action: string }>(
        "SELECT action FROM audit.event WHERE occurred_at >= $1 AND outcome = 'success' ORDER BY occurred_at",
        [since],
      );
      const actions = rows.rows.map((row) => row.action);
      expect(actions).toContain("secret.reveal");
      expect(actions).toContain("secret.export");
      expect(actions).toContain("machine.resolve");
    }, 300_000);
  }

  it("sign-out, session revocation, credential revocation and archive succeed in capturing, each with a backup_invalidation row; the revoked token is gone from OpenBao", async () => {
    const credential = await issueFor(f, "env1a");
    const place = await newProject(f);
    const { email, password, seed } = f.tenants.credentials("readerA");
    const one = await signInComplete(f.api, { email, password, seed });
    await signInComplete(f.api, { email, password, seed });
    const three = await signInComplete(f.api, { email, password, seed });
    const listed = await f.api.request("GET", "/v1/auth/sessions", { cookie: one.cookie });
    const sessions = ((await listed.json()) as { sessions: { id: string; current: boolean }[] })
      .sessions;
    const other = sessions.find((session) => !session.current)!;
    await f.api.superuser.query("DELETE FROM app.backup_invalidation");
    await setMode("capturing");

    const signedOut = await f.api.request("POST", "/v1/auth/sign-out", {
      body: {},
      cookie: three.cookie,
    });
    expect(signedOut.status, await signedOut.clone().text()).toBe(200);
    expect(await invalidations()).toEqual(["sign_out"]);

    const revokedOne = await f.api.request("POST", "/v1/auth/sessions/revoke", {
      body: { sessionId: other.id },
      cookie: one.cookie,
    });
    expect(revokedOne.status, await revokedOne.clone().text()).toBe(200);
    const revokedAll = await f.api.request("POST", "/v1/auth/revoke-sessions", {
      body: {},
      cookie: one.cookie,
    });
    expect(revokedAll.status, await revokedAll.clone().text()).toBe(200);
    expect(new Set(await invalidations())).toEqual(new Set(["sign_out", "session_revoke"]));

    const accessor = (
      await f.api.superuser.query<{ accessor: string }>(
        "SELECT accessor FROM app.machine_credential WHERE id = $1",
        [credential.credentialId],
      )
    ).rows[0]!.accessor;
    const revoked = await f.revoke("env1a", credential.credentialId);
    expect(revoked.status, revoked.code ?? "").toBe(200);
    expect(await accessorAnswer(f, accessor)).toBe(400);
    expect(await invalidations()).toContain("credential_revoke");

    const archived = await archive(f, place.path);
    expect(archived.status, archived.code ?? "").toBe(200);
    expect(await invalidations()).toContain("archive");
  }, 600_000);

  it("a session past its lifetime is denied in capturing and its row is still there afterwards", async () => {
    const { email, password, seed } = f.tenants.credentials("readerA");
    const signedIn = await signInComplete(f.api, { email, password, seed });
    const session = await f.api.superuser.query<{ id: string }>(
      `UPDATE auth.session SET authenticated_at = now() - interval '30 days'
        WHERE id = (SELECT s.id FROM auth.session s JOIN auth."user" u ON u.id = s.user_id
                     WHERE u.email = $1 ORDER BY s.authenticated_at DESC LIMIT 1)
        RETURNING id`,
      [email],
    );
    const id = session.rows[0]!.id;
    await setMode("capturing");
    const answer = await f.api.request("GET", "/v1/organizations", { cookie: signedIn.cookie });
    expect(answer.status).toBe(401);
    const still = await f.api.superuser.query("SELECT 1 FROM auth.session WHERE id = $1", [id]);
    expect(still.rowCount).toBe(1);
    await setMode("idle");
    await f.api.superuser.query("DELETE FROM auth.session WHERE id = $1", [id]);
  });
});

describe("the provisioner and the sweeps", () => {
  it("the provisioner takes no job in draining and takes it after idle", async () => {
    await setMode("draining");
    const project = await newProjectRow();
    const { environmentId } = await f.fx.newEnvironment({ projectId: project });
    const provisioner = await f.fx.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      const state = await f.api.superuser.query<{ state: string }>(
        "SELECT state FROM app.environment WHERE id = $1",
        [environmentId],
      );
      expect(state.rows[0]?.state).toBe("pending");
      await setMode("idle");
      await f.fx.waitFor(environmentId, "active", 120_000);
    } finally {
      await provisioner.stop();
    }
  }, 300_000);

  it("the API's sweep tick does nothing while not idle", async () => {
    const operationId = randomUUID();
    await f.api.superuser.query(
      `INSERT INTO app.operation (id, organization_id, principal_kind, principal_id, action, target,
                                  idempotency_key, state, executor_boot_id, heartbeat_at, created_at)
       VALUES ($1::uuid, $2, 'user', 'barrier', 'secrets.create', $1::text, $1::text, 'executing',
               gen_random_uuid(), now() - interval '1 hour', now() - interval '1 hour')`,
      [operationId, f.tenants.a.organizationId],
    );
    try {
      for (const mode of ["draining", "capturing"] as const) {
        await setMode(mode);
        const result = await operationSweepPass(f.api.pool);
        expect(result, mode).toEqual({ skipped: "capture" });
      }
      const row = await f.api.superuser.query<{ state: string }>(
        "SELECT state FROM app.operation WHERE id = $1",
        [operationId],
      );
      expect(row.rows[0]?.state).toBe("executing");
    } finally {
      await setMode("idle");
      await f.api.superuser.query("DELETE FROM app.operation WHERE id = $1", [operationId]);
    }
  });
});

/** A project row of A, written by the superuser (the API is closed in draining). */
async function newProjectRow(): Promise<string> {
  const id = randomUUID();
  await f.api.superuser.query(
    "INSERT INTO app.project (id, organization_id, name, state) VALUES ($1, $2, $3, 'active')",
    [id, f.tenants.a.organizationId, `bar-${id.slice(0, 8)}`],
  );
  return id;
}
