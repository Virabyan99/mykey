// Run 6.7 Task C (P-124, D-55): the whole restore, locally. A lost world is
// captured, changed afterwards (P-125: a password changed, an admin removed,
// a secret written), then restored by restoreToVerifying into a second
// cluster and a new OpenBao, started closed + verifying. Nine credentials of
// the old world are presented and each is refused; the members need the
// operator's confirmation; the owner's reset works through the listener; the
// report opens the gate, and the restored product works. Tokens and codes are
// compared by what the servers answer, never printed.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createThrottle, codeAt, loadAuthKeys, stepAt } from "@mykey/auth";
import { initiateReset } from "@mykey/auth/operator";
import { REQUIRED_CHECKS, type VerificationReport } from "@mykey/contracts";
import { beginCapture, openGate, recordCapture } from "@mykey/operations/operator";
import {
  recheckForOpen,
  restoreToVerifying,
  restoreVerify,
  verifyJourney,
  type Restored,
  type VerifyDeps,
} from "@mykey/ops";
import * as OTPAuth from "otpauth";
import pg from "pg";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieOf } from "../../harness/api.ts";
import { TEST_BUILD } from "../../harness/gate.ts";
import { createLostWorld, type LostWorld } from "../../harness/restore-fixture.ts";
import { localRestoreTarget, type LocalTarget } from "../../harness/restore-target.ts";
import { baoFetch } from "../../harness/stack.ts";

let world: LostWorld;
let target: LocalTarget;
let restored: Restored;
let verifyDeps: VerifyDeps;
let ownerFactor: { password: string; secret: string } = { password: "", secret: "" };
let restoreStartedAt: Date;

// The old world, kept before the changes after the capture.
let old: {
  password: string;
  seed: Uint8Array;
  recoveryCode: string;
  cookie: string;
  changedPassword: string;
  laterSecret: string;
};

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const codeOf = async (r: Response) => {
  try {
    return ((await r.json()) as { error?: { code?: string } }).error?.code ?? "";
  } catch {
    return "";
  }
};

beforeAll(async () => {
  world = await createLostWorld();
  const { f } = world;
  const owner = f.tenants.credentials("ownerA");
  const cookie = await f.tenants.cookie("ownerA");
  // P-125: the world changes after its capture.
  const changedPassword = `Changed-${randomBytes(12).toString("base64url")}`;
  const changed = await f.api.request("POST", "/v1/auth/change-password", {
    body: { currentPassword: owner.password, newPassword: changedPassword },
    cookie,
  });
  expect(changed.status).toBe(200);
  await f.api.superuser.query("DELETE FROM app.membership WHERE user_id = $1", [
    f.tenants.userId("adminA"),
  ]);
  const laterSecret = "WRITTEN_AFTER_CAPTURE";
  expect((await f.create("env1a", laterSecret, `later-${randomUUID()}`)).status).toBe(201);
  old = {
    password: owner.password,
    seed: owner.seed,
    recoveryCode: owner.recoveryCodes[0] ?? "",
    cookie,
    changedPassword,
    laterSecret,
  };

  target = await localRestoreTarget(world);
  restoreStartedAt = new Date();
  restored = await restoreToVerifying(target);
}, 1_200_000);

afterAll(async () => {
  await (restored as Restored | undefined)?.pool.end().catch(() => undefined);
  await (target as LocalTarget | undefined)?.stop();
  await (world as LostWorld | undefined)?.close();
}, 300_000);

describe("the whole restore, locally (P-124)", () => {
  it("the restored product starts closed + verifying: the public listener is quarantined, /health down", async () => {
    const pub = await target.request("public", "GET", "/v1/organizations");
    expect([pub.status, await codeOf(pub)]).toEqual([503, "quarantined"]);
    expect((await target.request("public", "GET", "/health")).status).toBe(503);
    expect((await target.request("verify", "GET", "/v1/version")).status).toBe(200);
  });

  it("the restore measured itself (FR-1.69): capture time, age at restore, elapsed time", () => {
    const m = restored.measurements;
    expect(m.captureStartedAt).toBe(world.pair.captureStartedAt.toISOString());
    expect(m.ageAtRestoreSeconds).toBeGreaterThan(0);
    expect(m.restoreSeconds).toBeGreaterThan(0);
    expect(m.restoreSeconds).toBeLessThan(1_800);
    expect(m.result).toBe("verifying");
  });

  it("the database-level access is the inventory's (step 4): no CREATE or TEMP for a runtime role", async () => {
    const rows = await restored.pool.query<{ role: string; create: boolean; temp: boolean }>(
      `SELECT r AS role,
              has_database_privilege(r, current_database(), 'CREATE') AS create,
              has_database_privilege(r, current_database(), 'TEMP') AS temp
         FROM unnest(ARRAY['api_runtime', 'provisioner_runtime', 'backup_reader', 'maintenance']) AS r`,
    );
    expect(rows.rows.filter((r) => r.create || r.temp).map((r) => r.role)).toEqual([]);
  });

  it("the role passwords of the restored cluster are new: the old api_runtime password is refused", async () => {
    const oldPassword = world.f.api.database.targets.api_runtime.password;
    const client = new pg.Client({
      ...target.connect("api_runtime", oldPassword),
      ssl: { ca: readFileSync(target.postgres.superuser.caCertPath, "utf8") },
    });
    await expect(client.connect()).rejects.toMatchObject({ code: "28P01" });
    await client.end().catch(() => undefined);
  });

  it("each of eleven old credentials is refused, by the product and by OpenBao", async () => {
    const { f } = world;
    const owner = f.tenants.credentials("ownerA");
    const refusedOnBoth = async (
      method: string,
      path: string,
      init: Parameters<LocalTarget["request"]>[3],
    ) => {
      for (const listener of ["public", "verify"] as const) {
        const answer = await target.request(listener, method, path, init);
        expect(answer.status, `${listener} ${path}`).toBeGreaterThanOrEqual(400);
      }
    };
    // (1) the old password and (2) the password changed after the capture.
    for (const password of [old.password, old.changedPassword]) {
      await refusedOnBoth("POST", "/v1/auth/sign-in/email", {
        body: { email: owner.email, password },
      });
    }
    // (3) a TOTP code of the old secret and (4) a recovery code unused at the capture.
    await refusedOnBoth("POST", "/v1/auth/totp/verify", {
      body: { code: codeAt(old.seed, stepAt(new Date())) },
      cookie: old.cookie,
    });
    await refusedOnBoth("POST", "/v1/auth/recovery/verify", {
      body: { code: old.recoveryCode },
      cookie: old.cookie,
    });
    // (5) the reset link unused at the capture.
    await refusedOnBoth("POST", "/v1/auth/reset/complete", {
      body: { token: world.old.resetTokens.unused, newPassword: `Fresh-${randomUUID()}` },
    });
    // (6) the session cookie live at the capture.
    await refusedOnBoth("GET", "/v1/organizations", { cookie: old.cookie });
    // (7) the machine token live at the capture: the API and OpenBao's lookup-self.
    const active = world.old.tokens.find((t) => t.state === "active");
    if (active === undefined) throw new Error("no active token in the lost world");
    await refusedOnBoth(
      "GET",
      `/v1/machine/projects/${f.tenants.a.project1}/environments/dev/keys`,
      {
        headers: { authorization: `Bearer ${active.token}` },
      },
    );
    const bao = { ...f.stack, bao: { ...f.stack.bao, ...target.openbao.target } };
    for (const t of world.old.tokens) {
      const answer = await baoFetch(bao, "/v1/auth/token/lookup-self", {
        token: t.token,
        namespace: f.fx.namespace,
      });
      expect(answer.status).toBe(403);
    }
    // (10) the runtime credential live at the capture: its client secret buys no token;
    // (11) the token it had exchanged: the API and OpenBao's lookup-self (Session 11).
    await refusedOnBoth("POST", "/v1/machine/exchange", {
      headers: { authorization: `Bearer ${world.old.runtime.clientSecret}` },
    });
    await refusedOnBoth(
      "GET",
      `/v1/machine/projects/${f.tenants.a.project2}/environments/dev/keys`,
      { headers: { authorization: `Bearer ${world.old.runtime.token}` } },
    );
    expect(
      (
        await baoFetch(bao, "/v1/auth/token/lookup-self", {
          token: world.old.runtime.token,
          namespace: f.fx.namespace,
        })
      ).status,
    ).toBe(403);
    // (8) the old runtime secret id: AppRole login refused.
    const login = await baoFetch(bao, "/v1/auth/approle/login", {
      method: "POST",
      token: "",
      namespace: f.fx.namespace,
      body: {
        role_id: world.old.approles.runtime.roleId,
        secret_id: world.old.approles.runtime.secretId,
      },
    });
    expect(login.status).toBe(400);
    // (9) the old root token.
    expect(
      (await baoFetch(bao, "/v1/auth/token/lookup-self", { token: world.old.rootToken })).status,
    ).toBe(403);
    // The refusals above spent four of this source's five password attempts a
    // minute (the throttle's fixed 60 s windows, P-48), and the journey after
    // them needs three more. Whether that passed depended on where the minute's
    // boundary fell (it failed on CI at the Session 6 gate). The owner's real
    // journey comes from another source; give this one its budget back.
    const admin = new pg.Client({
      ...target.postgres.superuser,
      ssl: { ca: readFileSync(target.postgres.superuser.caCertPath, "utf8") },
    });
    await admin.connect();
    try {
      await admin.query("DELETE FROM app.rate_limit WHERE scope LIKE 'src:%'");
    } finally {
      await admin.end();
    }
  });

  // R1-2 / R4-1 (Run 8.6, rule 9): a `password` reset accepts a code of the
  // active factor, which here is the pair's. It is refused; `mfa` (below) is not.
  it("a password reset, which would trust the restored authenticator and recovery codes, is refused", async () => {
    const { f } = world;
    const keys = loadAuthKeys(f.keysDirectory);
    for (const user of ["ownerA", "adminA"] as const) {
      const answer = await initiateReset(
        {
          pool: restored.pool,
          keys,
          throttle: createThrottle({ pool: restored.pool, ring: keys.rateLimit }),
        },
        { email: f.tenants.credentials(user).email, kind: "password" },
      );
      expect(answer, user).toEqual({ outcome: "refused", reason: "restored_factor" });
    }
  });

  it("the operator's reset link works, the owner enrols through the listener; the report needs the members confirmed", async () => {
    const { f } = world;
    const keys = loadAuthKeys(f.keysDirectory);
    const reset = await initiateReset(
      {
        pool: restored.pool,
        keys,
        throttle: createThrottle({ pool: restored.pool, ring: keys.rateLimit }),
      },
      { email: f.tenants.credentials("ownerA").email, kind: "mfa" },
    );
    if (reset.outcome !== "issued") throw new Error(`reset: ${reset.outcome}`);
    const { organizationId, project1, env1a } = f.tenants.a;
    const env = `/v1/organizations/${organizationId}/projects/${project1}/environments/${env1a}`;
    const newPassword = `Restored-${randomBytes(12).toString("base64url")}`;
    const journey = await verifyJourney({
      request: (method, path, init) => target.request("verify", method, path, init),
      cookieOf: (r) => {
        try {
          return sessionCookieOf(r);
        } catch {
          return null;
        }
      },
      owner: { email: f.tenants.credentials("ownerA").email, resetToken: reset.token, newPassword },
      totp: (secret, attempt) => {
        ownerFactor = { password: newPassword, secret };
        signIns += 1;
        const now = new Date(Date.now() + (attempt === 0 ? 0 : signIns * 90_000));
        return Promise.resolve({
          code: codeAt(OTPAuth.Secret.fromBase32(secret).bytes, stepAt(now)),
          headers: { "x-test-now": now.toISOString() },
        });
      },
      reveal: {
        path: `${env}/secrets/${world.old.secret.name}/reveal`,
        sha256: sha(world.old.secret.value),
      },
      mutation: {
        method: "POST",
        path: `/v1/organizations/${organizationId}/projects`,
        body: { name: "after-restore" },
      },
    });
    expect(
      Object.fromEntries(
        Object.entries(journey.checks).map(([id, c]) => [
          id,
          c.state === "ok" ? "ok" : `${c.state}: ${c.observed}`,
        ]),
      ),
    ).toEqual({
      journey_owner_enrolled: "ok",
      journey_reveal_digest: "ok",
      journey_mutation_refused: "ok",
    });
    // The secret written after the capture is absent (a session of the listener, then signed out).
    const session = await signIn("verify");
    const later = await target.request(
      "verify",
      "POST",
      `${env}/secrets/${old.laterSecret}/reveal`,
      {
        body: {},
        cookie: session,
      },
    );
    expect(later.status).toBe(404);
    await target.request("verify", "POST", "/v1/auth/sign-out", { body: {}, cookie: session });
    // The admin removed after the capture is back: the report counts the members.
    const members = Number(
      (await restored.pool.query<{ n: string }>("SELECT count(*) AS n FROM app.membership")).rows[0]
        ?.n,
    );
    const back = await restored.pool.query("SELECT 1 FROM app.membership WHERE user_id = $1", [
      f.tenants.userId("adminA"),
    ]);
    expect(back.rowCount).toBe(1);
    verifyDeps = {
      pool: restored.pool,
      admin: restored.admin,
      host: "local",
      expect: {
        hostInstanceId: restored.hostInstanceId,
        backendIncarnation: restored.backendIncarnation,
        releaseBuild: TEST_BUILD,
      },
      origin: { kind: "restore", pairId: world.pair.pairId },
      schemaRevision: "0019_automation_and_runtime",
      restoreStartedAt,
      given: {
        ...restored.given,
        old_credentials_refused: { state: "ok", observed: "nine refused" },
      },
      boundCidrs: { runtime: [], issuer: [], provisioner: [] },
    };
    const unconfirmed = await restoreVerify(verifyDeps, journey);
    expect(unconfirmed.members).toBe(members);
    expect(unconfirmed.checks.filter((c) => c.state !== "ok").map((c) => c.id)).toEqual([
      "members_confirmed",
    ]);
    const writer = fileWriter(target.gatePath);
    expect(
      await openGate({
        writer,
        pool: restored.pool,
        expect: verifyDeps.expect,
        report: unconfirmed,
        kind: "restore",
        now: () => new Date(),
      }),
    ).toEqual({ ok: false, cause: "check members_confirmed is failed" });

    verifyDeps = { ...verifyDeps, confirmMembers: members };
    report = await restoreVerify(verifyDeps, journey);
    expect(report.checks.map((c) => c.id)).toEqual([...REQUIRED_CHECKS.restore]);
    expect(report.checks.filter((c) => c.state !== "ok")).toEqual([]);
  });

  it("a report made, then one session inserted, then gate open → refused by its own re-check", async () => {
    const id = randomUUID();
    await restored.pool.query(
      `INSERT INTO auth.session (id, token, user_id, expires_at)
       SELECT $1, $2, user_id, now() + interval '1 hour' FROM auth.account_state LIMIT 1`,
      [id, `v1.test.${randomBytes(32).toString("base64url")}`],
    );
    try {
      expect(
        await openGate({
          writer: fileWriter(target.gatePath),
          pool: restored.pool,
          expect: verifyDeps.expect,
          report,
          kind: "restore",
          now: () => new Date(),
          recheck: () => recheckForOpen(verifyDeps),
        }),
      ).toEqual({ ok: false, cause: "check sessions_none is failed now" });
    } finally {
      await restored.pool.query("DELETE FROM auth.session WHERE id = $1", [id]);
    }
  });

  it("gate open with the fresh report opens; a write succeeds; the first issuance returns a token that resolves; the owner can do what an owner can, and no more", async () => {
    const opened = await openGate({
      writer: fileWriter(target.gatePath),
      pool: restored.pool,
      expect: verifyDeps.expect,
      report,
      kind: "restore",
      now: () => new Date(),
      recheck: () => recheckForOpen(verifyDeps),
    });
    expect(opened.ok).toBe(true);
    // P-124 step 9: the restore's own root token ends with the restore.
    await restored.admin.revokeSelf();

    const { f } = world;
    const { organizationId, project1, env1a } = f.tenants.a;
    const env = `/v1/organizations/${organizationId}/projects/${project1}/environments/${env1a}`;
    const cookie = await signIn("public");
    // Allowed: the list, a write, an issuance whose token resolves.
    expect((await target.request("public", "GET", "/v1/organizations", { cookie })).status).toBe(
      200,
    );
    const written = await target.request("public", "POST", `${env}/secrets`, {
      body: { name: "AFTER_RESTORE", value: `after-${randomUUID()}` },
      cookie,
      headers: { "idempotency-key": randomUUID() },
    });
    expect(written.status).toBe(201);
    const issued = await target.request("public", "POST", `${env}/credentials`, {
      body: { name: "after-restore", ttlSeconds: 600 },
      cookie,
      headers: { "idempotency-key": randomUUID() },
    });
    expect(issued.status).toBe(201);
    const token = ((await issued.json()) as { token: string }).token;
    const envName = (
      await restored.pool.query<{ name: string }>(
        "SELECT name FROM app.environment WHERE id = $1",
        [env1a],
      )
    ).rows[0]?.name;
    const keys = await target.request(
      "public",
      "GET",
      `/v1/machine/projects/${project1}/environments/${envName ?? ""}/keys`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(keys.status).toBe(200);
    // Session 11 (Run 11.3): with the gate open, the refusal of the old runtime
    // credential is its own: 401 for its client secret and for the token it had
    // exchanged, while a credential issued after the restore is exchanged and read.
    const oldExchange = await target.request("public", "POST", "/v1/machine/exchange", {
      headers: { authorization: `Bearer ${world.old.runtime.clientSecret}` },
    });
    expect([oldExchange.status, await codeOf(oldExchange)]).toEqual([401, "unauthenticated"]);
    const oldToken = await target.request(
      "public",
      "GET",
      `/v1/machine/projects/${f.tenants.a.project2}/environments/dev/keys`,
      { headers: { authorization: `Bearer ${world.old.runtime.token}` } },
    );
    expect([oldToken.status, await codeOf(oldToken)]).toEqual([401, "unauthenticated"]);
    const reissued = await target.request("public", "POST", `${env}/runtime-credentials`, {
      body: { name: "after-restore-runtime" },
      cookie,
      headers: { "idempotency-key": randomUUID() },
    });
    expect(reissued.status).toBe(201);
    const clientSecret = ((await reissued.json()) as { clientSecret: string }).clientSecret;
    const exchange = await target.request("public", "POST", "/v1/machine/exchange", {
      headers: { authorization: `Bearer ${clientSecret}` },
    });
    expect(exchange.status).toBe(200);
    const exchangedKeys = await target.request(
      "public",
      "GET",
      `/v1/machine/projects/${project1}/environments/${envName ?? ""}/keys`,
      {
        headers: {
          authorization: `Bearer ${((await exchange.json()) as { token: string }).token}`,
        },
      },
    );
    expect(exchangedKeys.status).toBe(200);
    // Denied: another organization's projects and secret, an unknown credential.
    const b = f.tenants.b;
    expect(
      (
        await target.request("public", "GET", `/v1/organizations/${b.organizationId}/projects`, {
          cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await target.request(
          "public",
          "POST",
          `/v1/organizations/${b.organizationId}/projects/${b.project1}/environments/${b.env1a}/secrets/ANY/reveal`,
          { body: {}, cookie },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await target.request("public", "POST", `${env}/credentials/${randomUUID()}/revoke`, {
          body: { confirmed: true },
          cookie,
          headers: { "idempotency-key": randomUUID() },
        })
      ).status,
    ).toBe(404);
  });

  it("a fresh capture on the restored database is taken (not busy) and recorded", async () => {
    const begun = await beginCapture(restored.pool, "full-test");
    expect(begun.kind).toBe("capturing");
    if (begun.kind !== "capturing") return;
    await recordCapture(restored.pool, begun.pairId, {
      host: "local",
      captureStartedAt: begun.captureStartedAt.toISOString(),
      boundary: begun.boundary,
      schemaRevision: "0019_automation_and_runtime",
      releaseBuild: "000000000000",
      keyRefs: { backupPassword: "local/1" },
      artifacts: [],
    });
    const mode = await restored.pool.query<{ mode: string }>(
      "SELECT capture_mode AS mode FROM app.service_control",
    );
    expect(mode.rows[0]?.mode).toBe("idle");
  });
});

/** Password and a TOTP code at a step of its own, on one listener; the mfa_complete cookie. */
let signIns = 0;
async function signIn(listener: "public" | "verify"): Promise<string> {
  const email = world.f.tenants.credentials("ownerA").email;
  const first = await target.request(listener, "POST", "/v1/auth/sign-in/email", {
    body: { email, password: ownerFactor.password },
  });
  expect(first.status).toBe(200);
  signIns += 1;
  const now = new Date(Date.now() + signIns * 90_000);
  const verified = await target.request(listener, "POST", "/v1/auth/totp/verify", {
    body: { code: codeAt(OTPAuth.Secret.fromBase32(ownerFactor.secret).bytes, stepAt(now)) },
    cookie: sessionCookieOf(first),
    headers: { "x-test-now": now.toISOString() },
  });
  expect(verified.status).toBe(200);
  return sessionCookieOf(verified);
}

let report: VerificationReport;

function fileWriter(path: string) {
  return {
    read: () => Promise.resolve(existsSync(path) ? readFileSync(path, "utf8") : null),
    write: (text: string) => {
      writeFileSync(`${path}.tmp`, text);
      renameSync(`${path}.tmp`, path);
      return Promise.resolve();
    },
  };
}
