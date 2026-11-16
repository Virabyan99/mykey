// Run 6.1 (P-105, FR-1.56): the writers of the audit trail, against the real
// stores. Task A: the four writers added in this run, each in the
// transaction of the change it records.
import { randomBytes, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runOps, type OpsEnv } from "@mykey/ops";
import { signInComplete } from "../../harness/api.ts";
import { createSecretsFixture, type SecretsFixture } from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;
const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
let sources = 0;
const source = (): string => {
  sources += 1;
  return `198.51.100.${String(10 + (sources % 200))}`;
};

beforeAll(async () => {
  f = await createSecretsFixture();
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
