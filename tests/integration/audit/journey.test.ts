// Run 6.1 (P-105, FR-1.56): the writers of the audit trail, against the real
// stores. Task A: the four writers added in this run, each in the
// transaction of the change it records. Task C: one journey through every
// route and command that writes, after which every action of the closed list
// has a row — but those another test file asserts (WRITTEN_ELSEWHERE; PENDING_WRITERS,
// which Run 6.9 must leave empty).
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, type AuditAction } from "@mykey/audit";
import { codeAt, createThrottle, generateKeyFiles, stepAt } from "@mykey/auth";
import { initiateReset } from "@mykey/auth/operator";
import type { OperationId, OrganizationId } from "@mykey/contracts";
import type { EnvironmentScope } from "@mykey/db";
import { secretPath } from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { sweepStaleOperations } from "@mykey/operations";
import {
  reconcileCredentials,
  reconcileEnvironment,
  reconcileOperation,
  type ReconcileDeps,
} from "@mykey/operations/operator";
import { directoryStore } from "@mykey/backup";
import { auditArchive, runOps, type OpsEnv } from "@mykey/ops";
import { signInComplete } from "../../harness/api.ts";
import {
  createCredentialsFixture,
  issueFor,
  issueRuntimeFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { archive, archiveDriver, newProject, reactivate } from "../../harness/lifecycle-fixture.ts";
import { exchangeCall, machineCall } from "../../harness/machine.ts";
import { provisionTestOrganization } from "../../harness/org-fixture.ts";
import { prepareDatabase } from "../database/setup.ts";

let f: CredentialsFixture;
const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
let sources = 0;
const source = (): string => {
  sources += 1;
  return `198.51.100.${String(10 + (sources % 200))}`;
};

beforeAll(async () => {
  f = await createCredentialsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

interface Row {
  action: string;
  outcome: string;
  actor_kind: string;
  actor_id: string | null;
  organization_id: string | null;
  request_id: string | null;
  operation_id: string | null;
  details: Record<string, unknown>;
}

async function rows(where: string, params: unknown[]): Promise<Row[]> {
  const result = await f.api.superuser.query<Row>(
    `SELECT action, outcome, actor_kind, actor_id, organization_id, request_id, operation_id, details
       FROM audit.event WHERE ${where} ORDER BY occurred_at, id`,
    params,
  );
  return result.rows;
}

const signIn = (user: "readerA" | "ungrantedA") =>
  signInComplete(f.api, f.tenants.credentials(user), { source: source() });

const post = (path: string, cookie: string, body: unknown = {}) =>
  f.api.request("POST", path, { body, cookie, headers: { "x-forwarded-for": source() } });

describe("the missing writers (Task A)", () => {
  it("sign-out writes auth.sign_out; revoking another session writes auth.session_revoke with revokedSessions 1", async () => {
    const userId = f.tenants.userId("readerA");
    const leaving = await signIn("readerA");
    const out = await post("/v1/auth/sign-out", leaving.cookie);
    expect(out.status).toBe(200);
    const signedOut = await rows("action = 'auth.sign_out' AND actor_id = $1", [userId]);
    expect(signedOut).toHaveLength(1);
    expect(signedOut[0]).toMatchObject({
      outcome: "success",
      actor_kind: "user",
      organization_id: null,
      request_id: out.headers.get("x-request-id"),
      details: {},
    });

    const mine = await signIn("readerA");
    const other = await signIn("readerA");
    const revoked = await post("/v1/auth/sessions/revoke", mine.cookie, {
      sessionId: other.sessionId,
    });
    expect(revoked.status).toBe(200);
    const single = await rows("action = 'auth.session_revoke' AND actor_id = $1", [userId]);
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ outcome: "success", details: { revokedSessions: 1 } });
  });

  it("a sign-out whose audit row cannot be written keeps the session and does not answer success", async () => {
    const userId = f.tenants.userId("ungrantedA");
    const live = await signIn("ungrantedA");
    // This test database only: the runtime loses INSERT on the audit table for one request.
    await f.api.superuser.query("REVOKE INSERT ON audit.event FROM api_runtime");
    try {
      const answer = await post("/v1/auth/sign-out", live.cookie);
      expect(answer.status).toBe(503);
      expect(((await answer.json()) as { error: { code: string } }).error.code).toBe(
        "audit_unavailable",
      );
    } finally {
      await f.api.superuser.query("GRANT INSERT ON audit.event TO api_runtime");
    }
    expect(await rows("action = 'auth.sign_out' AND actor_id = $1", [userId])).toHaveLength(0);
    const still = await f.api.superuser.query("SELECT 1 FROM auth.session WHERE id = $1", [
      live.sessionId,
    ]);
    expect(still.rowCount).toBe(1);
    // Control: with the right back, the same session signs out and is recorded.
    expect((await post("/v1/auth/sign-out", live.cookie)).status).toBe(200);
    expect(await rows("action = 'auth.sign_out' AND actor_id = $1", [userId])).toHaveLength(1);
  });

  it("a resumed import writes import.resume and no second import.apply intent", async () => {
    const path = f.env("env1a").path;
    const name = (i: number) => `J_${randomBytes(4).toString("hex").toUpperCase()}_${String(i)}`;
    const text = [1, 2, 3].map((i) => `${name(i)}=${mark}-${randomUUID()}\n`).join("");
    const previewed = await f.send("POST", `${path}/import/preview`, { text, key: null });
    expect(previewed.status).toBe(200);
    f.setImportBudget(0);
    const parked = await f.send(
      "POST",
      `${path}/import/${previewed.body.previewId as string}/apply`,
      { text },
    );
    f.setImportBudget(null);
    expect(parked.status).toBe(202);
    const parentId = parked.body.operationId as string;
    const resumed = await f.send("POST", `${path}/import-operations/${parentId}/resume`, {
      text,
      key: null,
    });
    expect(resumed.status).toBe(200);
    const audit = await rows("operation_id = $1 AND action LIKE 'import.%'", [parentId]);
    expect(audit.map((row) => `${row.action} ${row.outcome}`)).toEqual([
      "import.apply intent",
      "import.resume intent",
      "import.resume success",
    ]);
    expect(audit[1]?.request_id).toBe(resumed.headers.get("x-request-id"));
  });

  it("revoke-all writes auth.session_revoke with the number of sessions it ended", async () => {
    const otherUser = f.tenants.userId("ungrantedA");
    const third = await signIn("ungrantedA");
    const live = await f.api.superuser.query("SELECT 1 FROM auth.session WHERE user_id = $1", [
      otherUser,
    ]);
    // third and the fixture's own session of this user (which ends here: ungrantedA is not used after).
    expect(live.rowCount).toBeGreaterThanOrEqual(2);
    const all = await post("/v1/auth/revoke-sessions", third.cookie);
    expect(all.status).toBe(200);
    const both = await rows("action = 'auth.session_revoke' AND actor_id = $1", [otherUser]);
    expect(both).toHaveLength(1);
    expect(both[0]?.details).toEqual({ revokedSessions: live.rowCount });
    const left = await f.api.superuser.query("SELECT 1 FROM auth.session WHERE user_id = $1", [
      otherUser,
    ]);
    expect(left.rowCount).toBe(0);
  });

  it("ops auth-cleanup writes operator.auth_cleanup", async () => {
    const before = await rows("action = 'operator.auth_cleanup'", []);
    const out = new PassThrough();
    const err = new PassThrough();
    const env: OpsEnv = {
      database: f.api.database.targets.maintenance,
      keysDirectory: "",
      baseUrl: "https://mykey.test",
      home: "",
    };
    const code = await runOps(["auth-cleanup"], {
      stdin: new PassThrough(),
      stdout: out,
      stderr: err,
      env,
    });
    expect(code).toBe(0);
    const after = await rows("action = 'operator.auth_cleanup'", []);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      outcome: "success",
      actor_kind: "operator",
      organization_id: null,
    });
    expect(Object.keys(after.at(-1)?.details ?? {}).sort()).toEqual(["recoveryRows", "steps"]);
  });
});

/**
 * Actions whose writer arrives in a later run. Run 6.9 left this list empty.
 * Session 11 (Run 11.2) named three in the contract commit: Run 11.3 wrote
 * the first (machine.exchange, in the journey below), Run 11.5 writes the
 * other two, and the list is empty again after it.
 */
const PENDING_WRITERS: readonly AuditAction[] = [
  "automation_credential.issue",
  "automation_credential.revoke",
];

/**
 * Writers this journey does not run (a capture, a restore, a deploy need a
 * stack of their own): the test file that asserts each one's row.
 */
const WRITTEN_ELSEWHERE: Partial<Record<AuditAction, string>> = {
  "system.backup_capture": "tests/integration/capture/coordinator.test.ts",
  "system.backup_eligible": "tests/integration/capture/pair.test.ts",
  "system.backup_invalidated": "tests/integration/capture/coordinator.test.ts",
  "system.backup_cleanup": "tests/integration/capture/retention.test.ts",
  "operator.gate_open": "tests/integration/restore/gate.test.ts",
  "operator.gate_close": "tests/integration/deploy/failed-migration.test.ts",
  "operator.restore_begin": "tests/integration/restore/invalidate.test.ts",
  "operator.restore_invalidate": "tests/integration/restore/invalidate.test.ts",
  "operator.restore_verify": "tests/integration/restore/verify.test.ts",
  "operator.deploy": "tests/integration/deploy/failed-migration.test.ts",
};

describe("writers of Session 6 (Run 6.9)", () => {
  it("only Session 11's two automation actions are pending a writer, and each written elsewhere is asserted by the file that names it", () => {
    // Run 11.5 must make this `[]` again.
    expect(PENDING_WRITERS).toEqual([
      "automation_credential.issue",
      "automation_credential.revoke",
    ]);
    const root = join(import.meta.dirname, "..", "..", "..");
    for (const [action, file] of Object.entries(WRITTEN_ELSEWHERE)) {
      // Named in quotes: a string in the code or a literal in its SQL.
      const quoted = ["'", '"', "`"].map((q) => `${q}${action}${q}`);
      const text = readFileSync(join(root, file), "utf8");
      expect(
        quoted.some((q) => text.includes(q)),
        `${action} in ${file}`,
      ).toBe(true);
    }
  });
});

describe("one journey through every writer (Task C)", () => {
  it("every action of AUDIT_ACTIONS outside PENDING_WRITERS has at least one row; a request's row carries the request id its response carried", async () => {
    const started = (await f.api.superuser.query<{ now: Date }>("SELECT now()")).rows[0]?.now;
    // Every response of the journey: its x-request-id.
    const answered = new Set<string>();
    const request = f.api.request.bind(f.api);
    f.api.request = async (...args: Parameters<typeof request>) => {
      const response = await request(...args);
      const id = response.headers.get("x-request-id");
      if (id !== null) answered.add(id);
      return response;
    };
    const ops = async (argv: string[], stdin = "", extra: Partial<OpsEnv> = {}) => {
      const input = new PassThrough();
      input.end(stdin);
      const code = await runOps(argv, {
        stdin: input,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        env: { database: f.api.database.targets.maintenance, ...extra },
      });
      return code;
    };
    const org = `/v1/organizations/${f.tenants.a.organizationId}`;
    const path1a = f.env("env1a").path;
    const unique = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex").toUpperCase()}`;
    const value = () => `${mark}-${randomUUID()}`;
    interface Current {
      version: number;
      stateTag: string;
    }
    // The owner bootstrap runs once per database (it refuses where accounts exist): on a fresh one.
    const empty = await prepareDatabase();
    const bootstrapped = new Set<string>();
    try {
      const keys = mkdtempSync(join(tmpdir(), "mykey-journey-keys-"));
      generateKeyFiles(keys);
      expect(
        await ops(
          ["bootstrap-owner", "--email", `journey-${randomBytes(4).toString("hex")}@mykey.invalid`],
          `journey-${randomBytes(12).toString("base64url")}\n`,
          {
            database: empty.targets.maintenance,
            keysDirectory: keys,
            baseUrl: "https://mykey.test",
            home: keys,
          },
        ),
      ).toBe(0);
      // The bootstrapped organization is provisioned through the product's operator path.
      const created = await empty
        .pool("superuser")
        .query<{ id: string }>("SELECT id FROM app.organization WHERE state = 'provisioning'");
      expect(created.rows).toHaveLength(1);
      await provisionTestOrganization({ database: empty }, f.stack, created.rows[0]?.id ?? "");
      const there = await empty
        .pool("superuser")
        .query<{ action: string }>("SELECT DISTINCT action FROM audit.event");
      for (const row of there.rows) bootstrapped.add(row.action);
    } finally {
      await empty.drop();
    }
    try {
      // Operator: operation expiry; the audit archive (Run 6.2) over a local
      // store, with one row two days old so that a closed day exists.
      await f.api.superuser.query(
        `INSERT INTO audit.event (id, occurred_at, actor_kind, source_category, action, outcome, details)
         VALUES (gen_random_uuid(), now() - interval '2 days', 'system', 'system',
                 'operator.operations_expire', 'success', '{"expired": 0}'::jsonb)`,
      );
      const archived = await auditArchive({
        pool: f.api.database.pool("maintenance"),
        store: directoryStore(mkdtempSync(join(tmpdir(), "mykey-journey-archive-"))),
        host: "test",
        rotatedDir: null,
      });
      expect(archived.segments).toBeGreaterThanOrEqual(1);
      expect(await ops(["operations-expire"])).toBe(0);

      // Resources.
      await f.freshen();
      const project = await f.send("POST", `${org}/projects`, { body: { name: "journey" } });
      expect(project.status, project.text).toBe(201);
      const { projectId } = project.body.result as { projectId: string };
      const renamed = await f.send("PATCH", `${org}/projects/${projectId}`, {
        body: { name: "journey-2" },
      });
      expect(renamed.status, renamed.text).toBe(200);
      const environment = await f.send("POST", `${org}/projects/${projectId}/environments`, {
        body: { name: "stage" },
      });
      expect(environment.status, environment.text).toBe(201);
      const { environmentId } = environment.body.result as { environmentId: string };
      const envRenamed = await f.send(
        "PATCH",
        `${org}/projects/${projectId}/environments/${environmentId}`,
        { body: { name: "stage-2" } },
      );
      expect(envRenamed.status, envRenamed.text).toBe(200);
      // Archive and reactivate: a project, and an environment of another project.
      const driver = archiveDriver(f);
      try {
        const archivedProject = await newProject(f);
        expect([200, 202]).toContain((await archive(f, archivedProject.projectPath)).status);
        await driver.run();
        expect((await reactivate(f, archivedProject.projectPath)).status).toBe(200);
        const other = await newProject(f);
        expect([200, 202]).toContain((await archive(f, other.path)).status);
        await driver.run();
        expect((await reactivate(f, other.path)).status).toBe(200);
      } finally {
        await driver.close();
      }

      // Secrets: every action, the complete read, an access denial.
      const name = unique("J");
      const created = await f.create("env1a", name, value());
      expect(created.status).toBe(201);
      const updated = await f.update("env1a", name, value(), created.body.result as Current);
      expect(updated.status).toBe(200);
      const deleted = await f.act("env1a", name, "delete", updated.body.result as Current);
      expect(deleted.status).toBe(200);
      const undeleted = await f.act("env1a", name, "undelete", deleted.body.result as Current);
      expect(undeleted.status).toBe(200);
      const restored = await f.act("env1a", name, "restore", undeleted.body.result as Current, {
        sourceVersion: 1,
      });
      expect(restored.status, restored.text).toBe(200);
      const shown = await f.send("POST", `${path1a}/secrets/${name}/reveal`, {
        body: {},
        key: null,
      });
      expect(shown.status).toBe(200);
      await f.freshen();
      const exported = await f.send("POST", `${path1a}/export`, {
        body: { confirmed: true },
        key: null,
      });
      expect(exported.status).toBe(200);
      expect((await f.send("GET", `${org}/audit`, { user: "editorA", key: null })).status).toBe(
        403,
      );

      // Machine access: issue, keys, resolve, revoke.
      const issued = await issueFor(f, "env1a");
      const keysAnswer = await machineCall(f, "keys", { token: issued.token });
      expect(keysAnswer.status).toBe(200);
      answered.add(keysAnswer.headers.get("x-request-id") ?? "");
      const resolved = await machineCall(f, "resolve", { token: issued.token });
      expect(resolved.status).toBe(200);
      answered.add(resolved.headers.get("x-request-id") ?? "");
      // Session 11: a runtime credential, exchanged, and the token's read.
      const runtime = await issueRuntimeFor(f, "env1a");
      const exchange = await exchangeCall(f, { secret: runtime.clientSecret });
      expect(exchange.status, exchange.code ?? "").toBe(200);
      answered.add(exchange.headers.get("x-request-id") ?? "");
      const byExchange = await machineCall(f, "keys", { token: exchange.body.token as string });
      expect(byExchange.status).toBe(200);
      answered.add(byExchange.headers.get("x-request-id") ?? "");
      await f.freshen();
      const revoked = await f.send("POST", `${path1a}/credentials/${issued.credentialId}/revoke`, {
        body: { confirmed: true },
      });
      expect(revoked.status, revoked.text).toBe(200);

      // An operation left executing: the sweep makes it uncertain; the operator settles it.
      const stuckName = unique("S");
      const stuck = await f.create("env1b", stuckName, value());
      // The update waits at its marker while its heartbeat is aged and the sweep passes.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: (operationId: string) => void;
      const arrived = new Promise<string>((resolve) => {
        reached = resolve;
      });
      f.setFaults(async (at, operationId) => {
        if (at !== "after_dispatch_marker") return;
        reached(operationId);
        await held;
      });
      const pending = f.update("env1b", stuckName, value(), stuck.body.result as Current);
      const lostId = (await arrived) as OperationId;
      f.setFaults(null);
      try {
        await f.api.superuser.query(
          "UPDATE app.operation SET heartbeat_at = now() - interval '1 hour' WHERE id = $1",
          [lostId],
        );
        const swept = await sweepStaleOperations(f.api.pool, { staleSeconds: 60 });
        expect(swept.uncertain).toContain(lostId);
      } finally {
        release();
      }
      await pending;
      const reconcileDeps = (): ReconcileDeps => ({
        database: f.api.database.pool("maintenance"),
        bao: f.operatorBao(),
        operatorId: null,
        requestId: randomUUID(),
      });
      const settled = await reconcileOperation(reconcileDeps(), lostId, {
        executorsExcluded: true,
      });
      expect(settled.kind).not.toBe("refused");

      // Drift: a name written behind the product; the complete read finds it; the operator rebuilds.
      const { projectId: p2, environmentId: e2 } = f.env("env2a");
      const outside = await f
        .operatorBao()
        .kvWrite(
          secretPath(p2, e2, unique("X")),
          { value: value(), operation_id: randomUUID(), format: 1 },
          0,
          { operationId: randomUUID(), dispatchId: randomUUID() },
        );
      expect(outside.ok).toBe(true);
      await f.freshen();
      const drifted = await f.send("POST", `${f.env("env2a").path}/export`, {
        body: { confirmed: true },
        key: null,
      });
      expect(drifted.code).toBe("backend_inconsistent");
      const scope2a: EnvironmentScope = {
        organizationId: f.tenants.a.organizationId as OrganizationId,
        projectId: p2,
        environmentId: e2,
      };
      expect((await reconcileEnvironment(reconcileDeps(), scope2a)).kind).toBe("rebuilt");
      const credentialResult = await reconcileCredentials(
        {
          pool: f.api.database.pool("maintenance"),
          admin: new OpenBaoAdmin(f.stack.bao, f.stack.bao.rootToken),
          bao: f.operatorBao(),
          requestId: randomUUID(),
        },
        { scope: scope2a, executorsExcluded: true },
      );
      expect(credentialResult.kind).not.toBe("busy");

      // Accounts: a password change, step-up, regeneration, throttling, a reset.
      // The suite signed these accounts in before: their counters start empty here.
      await f.api.superuser.query("DELETE FROM app.rate_limit");
      const reader = await signIn("readerA");
      const changed = await post("/v1/auth/change-password", reader.cookie, {
        currentPassword: f.tenants.credentials("readerA").password,
        newPassword: `journey-${randomBytes(12).toString("base64url")}`,
      });
      expect(changed.status, await changed.clone().text()).toBe(200);
      const owner = await f.tenants.cookie("ownerA");
      await post("/v1/auth/totp/step-up", owner, { code: "000000" });
      await post("/v1/auth/recovery/regenerate", owner, {});
      const nobody = `nobody-${randomBytes(4).toString("hex")}@mykey.invalid`;
      let throttled = false;
      for (let i = 0; i < 8 && !throttled; i += 1) {
        const attempt = await f.api.request("POST", "/v1/auth/sign-in/email", {
          body: { email: nobody, password: "wrong-password-journey" },
          headers: { "x-forwarded-for": source() },
        });
        throttled = attempt.status === 429;
      }
      expect(throttled).toBe(true);
      const maintenance = f.api.database.pool("maintenance");
      const issuedReset = await initiateReset(
        {
          pool: maintenance,
          keys: f.api.keys,
          throttle: createThrottle({ pool: maintenance, ring: f.api.keys.rateLimit }),
        },
        { email: f.tenants.credentials("envEditorA").email, kind: "password" },
      );
      expect(issuedReset.outcome).toBe("issued");
      const resetToken = issuedReset.outcome === "issued" ? issuedReset.token : "";
      // A step of its own, far from any the suite used (the harness's test clock).
      const at = new Date(Date.now() + 40 * 3_600_000);
      const completeReset = (body: Record<string, unknown>) =>
        f.api.request("POST", "/v1/auth/reset/complete", {
          body,
          headers: { "x-forwarded-for": source(), "x-test-now": at.toISOString() },
        });
      const code = codeAt(f.tenants.credentials("envEditorA").seed, stepAt(at));
      const fresh = `journey-${randomBytes(12).toString("base64url")}`;
      const wrong = await completeReset({ token: "A".repeat(43), newPassword: fresh, code });
      expect(wrong.status).toBe(401);
      const right = await completeReset({ token: resetToken, newPassword: fresh, code });
      expect(right.status, await right.clone().text()).toBe(200);
    } finally {
      f.api.request = request;
    }

    const present = await f.api.superuser.query<{ action: string }>(
      "SELECT DISTINCT action FROM audit.event",
    );
    const have = new Set([...present.rows.map((row) => row.action), ...bootstrapped]);
    const missing = AUDIT_ACTIONS.filter(
      (action) =>
        !have.has(action) && !PENDING_WRITERS.includes(action) && !(action in WRITTEN_ELSEWHERE),
    );
    expect(missing).toEqual([]);

    const during = await f.api.superuser.query<{
      action: string;
      actor_kind: string | null;
      outcome: string | null;
      request_id: string | null;
    }>(
      `SELECT action, actor_kind, outcome, request_id FROM audit.event
        WHERE occurred_at >= $1 AND source_category = 'api'`,
      [started],
    );
    expect(during.rows.length).toBeGreaterThan(20);
    for (const row of during.rows) {
      expect(row.actor_kind, row.action).toMatch(/^(user|machine|anonymous|system)$/);
      expect(row.outcome, row.action).not.toBeNull();
      if (row.request_id !== null) {
        expect(answered.has(row.request_id), `${row.action} ${row.request_id}`).toBe(true);
      }
    }
  }, 900_000);
});
