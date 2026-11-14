// Run 3.10 Step 5: Session 3 on the integrated product on staging, through the
// public name only (never a tunnel for a product request). The superuser
// tunnel is used for test set-up, ageing and clean-up only. Every secret the
// suite touches is collected in memory and searched for afterwards (the
// canary sweep); only counts are written down. Synthetic data only.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeAt, createAuth, ephemeralKeys, stepAt } from "@mykey/auth";
import { createPool } from "@mykey/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as OTPAuth from "otpauth";
import type pg from "pg";
import {
  connectStaging,
  countOnHost,
  hostStatus,
  loadHosts,
  registerSecret,
  sshExec,
  type StagingStack,
} from "../harness/staging.ts";
import {
  STAGING_ORIGIN,
  STAGING_OWNER_EMAIL,
  freshCode,
  publicRequest,
  readCustody,
  sessionPair,
  stagingOwnerSession,
  writeCustody,
  type PublicAnswer,
} from "../harness/staging-owner.ts";

const host = loadHosts().staging;
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const startedAt = new Date();

/** Every secret value the suite used, for the canary sweep. Never printed. */
const canaries = new Set<string>();
const canary = (value: string): string => {
  if (value.length >= 8) {
    canaries.add(value);
    registerSecret(value);
  }
  return value;
};

let staging: StagingStack;
let superuser: pg.Pool;

beforeAll(async () => {
  staging = await connectStaging();
  superuser = createPool(
    {
      host: staging.pg.host,
      port: staging.pg.port,
      database: "postgres",
      user: "postgres",
      password: staging.pg.superuser.password,
      caCertPath: staging.pg.caCertPath,
    },
    { max: 3 },
  );
  await removeLeftovers();
  // The time check before any TOTP step.
  const status = await hostStatus(host);
  expect(Math.abs(status.chronyOffsetMs ?? 99_999)).toBeLessThan(1000);
  expect(status.gate).toBe("open");
}, 120_000);

afterAll(async () => {
  await superuser.end();
  await staging.close();
});

/**
 * Removes this suite's rate-limit rows (staging is synthetic): the per-source
 * limit counts every sign-in, and the suite signs in many times. (Shifting the
 * rows back in time collides with rows shifted before: same key, same window.)
 */
async function ageThrottle(): Promise<void> {
  await superuser.query(
    "DELETE FROM app.rate_limit WHERE window_start >= $1::timestamptz - interval '1 minute'",
    [startedAt],
  );
}

/** Synthetic users and organizations an earlier, interrupted run of this suite left behind. */
async function removeLeftovers(): Promise<void> {
  const users = await superuser.query<{ id: string }>(
    `SELECT id FROM auth."user" WHERE email LIKE 'gate-%@mykey-staging.invalid'`,
  );
  const organizations = await superuser.query<{ id: string }>(
    "SELECT DISTINCT organization_id AS id FROM app.project WHERE name = 'B project'",
  );
  await removeUsers(users.rows.map((row) => row.id));
  for (const { id } of organizations.rows) {
    await superuser.query("DELETE FROM app.membership WHERE organization_id = $1", [id]);
    await superuser.query("DELETE FROM app.project WHERE organization_id = $1", [id]);
    await superuser.query("DELETE FROM app.organization WHERE id = $1", [id]);
  }
}

async function removeUsers(ids: string[]): Promise<void> {
  for (const statement of [
    "DELETE FROM app.access_grant WHERE user_id = ANY($1)",
    "DELETE FROM app.membership WHERE user_id = ANY($1)",
    "DELETE FROM auth.recovery_code WHERE enrollment_id IN (SELECT id FROM auth.totp_enrollment WHERE user_id = ANY($1))",
    "DELETE FROM auth.totp_step_used WHERE enrollment_id IN (SELECT id FROM auth.totp_enrollment WHERE user_id = ANY($1))",
    "DELETE FROM auth.totp_enrollment WHERE user_id = ANY($1)",
    "DELETE FROM auth.session WHERE user_id = ANY($1)",
    "DELETE FROM auth.reset_token WHERE user_id = ANY($1)",
    "DELETE FROM auth.account WHERE user_id = ANY($1)",
    "DELETE FROM auth.account_state WHERE user_id = ANY($1)",
    `DELETE FROM auth."user" WHERE id = ANY($1)`,
  ]) {
    await superuser.query(statement, [ids]);
  }
}

const codeOf = (answer: PublicAnswer): string | undefined => {
  try {
    return (JSON.parse(answer.body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
};

function ops(argv: string[]): { code: number | null; stdout: string } {
  const result = spawnSync(process.execPath, ["scripts/host.ts", "staging", "ops", ...argv], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  return { code: result.status, stdout: result.stdout };
}

/** Runs `ops reset-account` and answers the token of the link file (the file is shredded). */
function initiateReset(kind: "password" | "mfa"): string {
  const run = ops(["reset-account", "--email", STAGING_OWNER_EMAIL, "--kind", kind]);
  expect(run.code, run.stdout.slice(0, 200)).toBe(0);
  const path = /link in (\S+);/.exec(run.stdout)?.[1];
  if (path === undefined) throw new Error("reset-account printed no link file");
  const link = readFileSync(path, "utf8").trim();
  rmSync(path, { force: true });
  const token = /#t=([A-Za-z0-9_-]{43})&k=/.exec(link)?.[1];
  if (token === undefined) throw new Error("the link file holds no token");
  canary(link);
  return canary(token);
}

async function ownerState(): Promise<string> {
  const result = await superuser.query<{ state: string }>(
    `SELECT s.state FROM auth.account_state s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = $1`,
    [STAGING_OWNER_EMAIL],
  );
  return result.rows[0]!.state;
}

describe("1–2. known state and sign-in", () => {
  it("the owner signs in with password and TOTP; the organization is active", async () => {
    const { cookie } = await stagingOwnerSession();
    canary(cookie.slice(cookie.indexOf("=") + 1));
    const answer = await publicRequest("GET", "/v1/organizations", { cookie });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({
      organizations: [{ id: ORGANIZATION, role: "owner", state: "active" }],
    });
    canary(readCustody("owner-password") ?? "");
    canary(readCustody("owner-totp-seed") ?? "");
    await ageThrottle();
  });

  it("sign-up paths are 404; a password-only session gets 401 mfa_incomplete", async () => {
    for (const path of ["/v1/auth/sign-up/email", "/v1/auth/sign-up"]) {
      const answer = await publicRequest("POST", path, {
        body: { email: "x@mykey-staging.invalid", password: "a-long-password-1", name: "x" },
      });
      expect(answer.status, path).toBe(404);
    }
    const signedIn = await publicRequest("POST", "/v1/auth/sign-in/email", {
      body: { email: STAGING_OWNER_EMAIL, password: readCustody("owner-password") },
    });
    const cookie = sessionPair(signedIn);
    canary(cookie.slice(cookie.indexOf("=") + 1));
    const answer = await publicRequest("GET", "/v1/organizations", { cookie });
    expect(answer.status).toBe(401);
    expect(codeOf(answer)).toBe("mfa_incomplete");
    await ageThrottle();
  });
});

describe("3. operator reset, both kinds", () => {
  it("password: the old session and password die; the new password and the old authenticator sign in", async () => {
    const { cookie: before } = await stagingOwnerSession();
    const token = initiateReset("password");
    expect(await ownerState()).toBe("recovery_pending");
    expect((await publicRequest("GET", "/v1/organizations", { cookie: before })).status).toBe(401);
    const seed = OTPAuth.Secret.fromBase32(readCustody("owner-totp-seed")!).bytes;
    const oldPassword = readCustody("owner-password")!;
    const newPassword = canary(`staging-${randomBytes(18).toString("base64url")}`);
    const done = await publicRequest("POST", "/v1/auth/reset/complete", {
      body: { token, newPassword, code: canary(await freshCode(seed)) },
    });
    expect(done.status).toBe(200);
    expect(JSON.parse(done.body)).toEqual({ next: "sign_in" });
    writeCustody("owner-password", newPassword);
    expect(await ownerState()).toBe("active");
    const old = await publicRequest("POST", "/v1/auth/sign-in/email", {
      body: { email: STAGING_OWNER_EMAIL, password: oldPassword },
    });
    expect(old.status).toBe(401);
    await ageThrottle();
    const { cookie } = await stagingOwnerSession();
    expect((await publicRequest("GET", "/v1/organizations", { cookie })).status).toBe(200);
    await ageThrottle();
  });

  it("an aged link leaves the account recovery_pending; of two parallel completions one wins", async () => {
    const aged = initiateReset("password");
    await superuser.query(
      `UPDATE auth.reset_token SET expires_at = now() - interval '1 minute'
        WHERE consumed_at IS NULL AND superseded_at IS NULL
          AND user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
      [STAGING_OWNER_EMAIL],
    );
    const seed = OTPAuth.Secret.fromBase32(readCustody("owner-totp-seed")!).bytes;
    const late = await publicRequest("POST", "/v1/auth/reset/complete", {
      body: {
        token: aged,
        newPassword: `late-${randomBytes(12).toString("hex")}`,
        code: await freshCode(seed),
      },
    });
    expect(late.status).toBe(401);
    expect(await ownerState()).toBe("recovery_pending");

    const token = initiateReset("password");
    const newPassword = canary(`staging-${randomBytes(18).toString("base64url")}`);
    const code = canary(await freshCode(seed));
    const answers = await Promise.all([
      publicRequest("POST", "/v1/auth/reset/complete", { body: { token, newPassword, code } }),
      publicRequest("POST", "/v1/auth/reset/complete", { body: { token, newPassword, code } }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 401]);
    writeCustody("owner-password", newPassword);
    expect(await ownerState()).toBe("active");
    await ageThrottle();
  });

  it("mfa: a new password, a new authenticator at once; the old seed no longer works", async () => {
    const oldSeed = readCustody("owner-totp-seed")!;
    const token = initiateReset("mfa");
    const newPassword = canary(`staging-${randomBytes(18).toString("base64url")}`);
    const done = await publicRequest("POST", "/v1/auth/reset/complete", {
      body: { token, newPassword },
    });
    expect(done.status).toBe(200);
    expect(JSON.parse(done.body)).toEqual({ next: "enroll" });
    writeCustody("owner-password", newPassword);
    const challenge = sessionPair(done);
    canary(challenge.slice(challenge.indexOf("=") + 1));
    const enrolled = await publicRequest("POST", "/v1/auth/totp/enroll", {
      body: {},
      cookie: challenge,
    });
    expect(enrolled.status).toBe(200);
    const { secret } = JSON.parse(enrolled.body) as { secret: string };
    canary(secret);
    writeCustody("owner-totp-seed", secret);
    const activated = await publicRequest("POST", "/v1/auth/totp/activate", {
      body: { code: canary(await freshCode(OTPAuth.Secret.fromBase32(secret).bytes)) },
      cookie: challenge,
    });
    expect(activated.status).toBe(200);
    const { recoveryCodes } = JSON.parse(activated.body) as { recoveryCodes: string[] };
    for (const code of recoveryCodes) canary(code);
    writeCustody("owner-recovery-codes", recoveryCodes.join("\n"));
    expect(await ownerState()).toBe("active");
    await ageThrottle();
    // The old authenticator is gone: a code of the old seed does not complete a sign-in.
    const signedIn = await publicRequest("POST", "/v1/auth/sign-in/email", {
      body: { email: STAGING_OWNER_EMAIL, password: newPassword },
    });
    const stale = await publicRequest("POST", "/v1/auth/totp/verify", {
      body: { code: codeAt(OTPAuth.Secret.fromBase32(oldSeed).bytes, stepAt(new Date())) },
      cookie: sessionPair(signedIn),
    });
    expect(stale.status).toBe(401);
    await ageThrottle();
  }, 120_000);
});

let projectId = "";
let developmentId = "";
let secondId = "";

describe("4. resources", () => {
  it("the owner creates a project and a second environment; both become active through the provisioner", async () => {
    const { cookie } = await stagingOwnerSession();
    const key = randomUUID();
    const name = `Gate ${randomUUID().slice(0, 6)}`;
    const created = await publicRequest("POST", `/v1/organizations/${ORGANIZATION}/projects`, {
      body: { name },
      cookie,
      headers: { "idempotency-key": key },
    });
    expect(created.status).toBe(201);
    const result = (
      JSON.parse(created.body) as {
        result: { projectId: string; developmentEnvironmentId: string };
      }
    ).result;
    projectId = result.projectId;
    developmentId = result.developmentEnvironmentId;
    const replay = await publicRequest("POST", `/v1/organizations/${ORGANIZATION}/projects`, {
      body: { name },
      cookie,
      headers: { "idempotency-key": key },
    });
    expect(replay.status).toBe(201);
    expect(JSON.parse(replay.body)).toEqual(JSON.parse(created.body));
    const second = await publicRequest(
      "POST",
      `/v1/organizations/${ORGANIZATION}/projects/${projectId}/environments`,
      { body: { name: "staging" }, cookie, headers: { "idempotency-key": randomUUID() } },
    );
    expect(second.status).toBe(201);
    secondId = (JSON.parse(second.body) as { result: { environmentId: string } }).result
      .environmentId;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const states = await superuser.query<{ state: string }>(
        "SELECT state FROM app.environment WHERE id = ANY($1)",
        [[developmentId, secondId]],
      );
      if (states.rows.every((row) => row.state === "active") && states.rows.length === 2) break;
      if (Date.now() > deadline) throw new Error(`environments: ${JSON.stringify(states.rows)}`);
      await sleep(2000);
    }
    const renamed = await publicRequest(
      "PATCH",
      `/v1/organizations/${ORGANIZATION}/projects/${projectId}`,
      { body: { name: `${name} renamed` }, cookie, headers: { "idempotency-key": randomUUID() } },
    );
    expect(renamed.status).toBe(200);
    const page = await publicRequest(
      "GET",
      `/v1/organizations/${ORGANIZATION}/projects/${projectId}/environments?limit=1`,
      { cookie },
    );
    expect(page.status).toBe(200);
    const first = JSON.parse(page.body) as { environments: { id: string }[]; nextCursor: string };
    expect(first.environments).toHaveLength(1);
    const next = await publicRequest(
      "GET",
      `/v1/organizations/${ORGANIZATION}/projects/${projectId}/environments?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
      { cookie },
    );
    const rest = JSON.parse(next.body) as { environments: { id: string }[] };
    expect([...first.environments, ...rest.environments].map((e) => e.id).sort()).toEqual(
      [developmentId, secondId].sort(),
    );
    await ageThrottle();
  }, 180_000);
});

interface Synthetic {
  id: string;
  email: string;
  password: string;
  seed: Uint8Array;
  cookie: string;
}
const synthetic = new Map<string, Synthetic>();
const organizationB = randomUUID();
const projectB = randomUUID();

async function makeUser(
  name: string,
  membership: { organization: string; role: "owner" | "admin" | "member" },
): Promise<Synthetic> {
  const id = randomUUID();
  // Lower case: sign-in compares the normalized e-mail (the operator path stores it so too).
  const email = `gate-${name.toLowerCase()}-${id.slice(0, 6)}@mykey-staging.invalid`;
  const password = canary(randomBytes(18).toString("base64url"));
  const auth = createAuth({
    db: drizzle(superuser),
    keys: ephemeralKeys(),
    baseURL: STAGING_ORIGIN,
  });
  const hash = await (await auth.$context).password.hash(password);
  await superuser.query(
    `INSERT INTO auth."user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
    [id, `Gate ${name}`, email],
  );
  await superuser.query(
    `INSERT INTO auth.account (id, account_id, provider_id, user_id, password)
     VALUES (gen_random_uuid(), $1, 'credential', $2, $3)`,
    [id, id, hash],
  );
  await superuser.query(
    "INSERT INTO auth.account_state (user_id, state) VALUES ($1, 'enrollment_pending')",
    [id],
  );
  await superuser.query(
    `INSERT INTO app.membership (id, organization_id, user_id, role, state)
     VALUES (gen_random_uuid(), $1, $2, $3, 'active')`,
    [membership.organization, id, membership.role],
  );
  await ageThrottle();
  const signedIn = await publicRequest("POST", "/v1/auth/sign-in/email", {
    body: { email, password },
  });
  const passwordCookie = sessionPair(signedIn);
  const enrolled = await publicRequest("POST", "/v1/auth/totp/enroll", {
    body: {},
    cookie: passwordCookie,
  });
  const { secret } = JSON.parse(enrolled.body) as { secret: string };
  canary(secret);
  const seed = OTPAuth.Secret.fromBase32(secret).bytes;
  const activated = await publicRequest("POST", "/v1/auth/totp/activate", {
    body: { code: codeAt(seed, stepAt(new Date())) },
    cookie: passwordCookie,
  });
  expect(activated.status, name).toBe(200);
  for (const code of (JSON.parse(activated.body) as { recoveryCodes: string[] }).recoveryCodes) {
    canary(code);
  }
  const cookie = sessionPair(activated);
  canary(cookie.slice(cookie.indexOf("=") + 1));
  const user = { id, email, password, seed, cookie };
  synthetic.set(name, user);
  return user;
}

describe("5. shut out", () => {
  beforeAll(async () => {
    await superuser.query(
      "INSERT INTO app.organization (id, namespace, state) VALUES ($1, $2, 'active')",
      [organizationB, `org-${organizationB}`],
    );
    await superuser.query(
      "INSERT INTO app.project (id, organization_id, name, state) VALUES ($1, $2, 'B project', 'active')",
      [projectB, organizationB],
    );
    await makeUser("admin", { organization: ORGANIZATION, role: "admin" });
    const editor = await makeUser("editor", { organization: ORGANIZATION, role: "member" });
    const reader = await makeUser("reader", { organization: ORGANIZATION, role: "member" });
    await makeUser("ungranted", { organization: ORGANIZATION, role: "member" });
    await makeUser("ownerB", { organization: organizationB, role: "owner" });
    for (const [user, role] of [
      [editor, "editor"],
      [reader, "reader"],
    ] as const) {
      await superuser.query(
        `INSERT INTO app.access_grant (id, organization_id, user_id, project_id, role)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [ORGANIZATION, user.id, projectId, role],
      );
    }
  }, 300_000);

  const as = (name: string) => synthetic.get(name)!.cookie;
  const envPath = () =>
    `/v1/organizations/${ORGANIZATION}/projects/${projectId}/environments/${developmentId}`;

  it("hidden equals absent: ownerB on A's project and on a random id get the same answer", async () => {
    const shape = (answer: PublicAnswer) => ({
      status: answer.status,
      body: answer.body.replace(/"requestId":"[^"]+"/, ""),
    });
    const hidden = await publicRequest("GET", `/v1/organizations/${ORGANIZATION}/projects`, {
      cookie: as("ownerB"),
    });
    const absent = await publicRequest("GET", `/v1/organizations/${randomUUID()}/projects`, {
      cookie: as("ownerB"),
    });
    expect(hidden.status).toBe(404);
    expect(shape(hidden)).toEqual(shape(absent));
  });

  it("the reader reads and cannot write; the editor writes and cannot manage; the ungranted member sees no project", async () => {
    const key = { "idempotency-key": randomUUID() };
    // Session 4: secrets.list and secrets.create have handlers (Runs 4.2, 4.3).
    expect(
      (await publicRequest("GET", `${envPath()}/secrets`, { cookie: as("reader") })).status,
    ).toBe(200);
    const write = await publicRequest("POST", `${envPath()}/secrets`, {
      body: { name: "A", value: "" },
      cookie: as("reader"),
      headers: key,
    });
    expect(write.status).toBe(403);
    const editorWrite = await publicRequest("POST", `${envPath()}/secrets`, {
      body: { name: "A", value: "" },
      cookie: as("editor"),
      headers: { "idempotency-key": randomUUID() },
    });
    expect(editorWrite.status).toBe(201);
    const manage = await publicRequest("POST", `/v1/organizations/${ORGANIZATION}/projects`, {
      body: { name: "By editor" },
      cookie: as("editor"),
      headers: { "idempotency-key": randomUUID() },
    });
    expect(manage.status).toBe(403);
    const list = await publicRequest("GET", `/v1/organizations/${ORGANIZATION}/projects`, {
      cookie: as("ungranted"),
    });
    expect(JSON.parse(list.body)).toEqual({ projects: [], nextCursor: null });
    const admin = await publicRequest("GET", `/v1/organizations/${ORGANIZATION}/audit`, {
      cookie: as("admin"),
    });
    expect(admin.status).toBe(404); // allowed; no handler before Run 6.1
  });

  it("B sees nothing of A and A nothing of B", async () => {
    const { cookie } = await stagingOwnerSession();
    expect(
      (await publicRequest("GET", `/v1/organizations/${organizationB}/projects`, { cookie }))
        .status,
    ).toBe(404);
    expect(
      (await publicRequest("GET", `${envPath()}/secrets`, { cookie: as("ownerB") })).status,
    ).toBe(404);
    await ageThrottle();
  });

  it("a grant removed mid-session denies the next request", async () => {
    expect(
      (await publicRequest("GET", `${envPath()}/secrets`, { cookie: as("editor") })).status,
    ).toBe(200);
    const reader = synthetic.get("editor")!;
    await superuser.query("DELETE FROM app.access_grant WHERE user_id = $1", [reader.id]);
    const after = await publicRequest("GET", `${envPath()}/secrets`, { cookie: as("editor") });
    expect(after.status).toBe(404);
    expect(codeOf(after)).toBe("not_found");
    // Before removal the list answered 200; after, the 404 is a denial with its audit row.
    const denied = await superuser.query(
      "SELECT 1 FROM audit.event WHERE action = 'access.denied' AND request_id = $1",
      [after.headers.get("x-request-id")],
    );
    expect(denied.rowCount).toBe(1);
  });
});

describe("6–7. foreign origin and throttle", () => {
  it("a sign-in and a project create with Origin https://evil.example → 403 origin_rejected", async () => {
    const headers = { origin: "https://evil.example" };
    const signIn = await publicRequest("POST", "/v1/auth/sign-in/email", {
      body: { email: STAGING_OWNER_EMAIL, password: "x-wrong-password" },
      headers,
    });
    expect(signIn.status).toBe(403);
    expect(codeOf(signIn)).toBe("origin_rejected");
    const { cookie } = await stagingOwnerSession();
    const create = await publicRequest("POST", `/v1/organizations/${ORGANIZATION}/projects`, {
      body: { name: "Evil" },
      cookie,
      headers: { ...headers, "idempotency-key": randomUUID() },
    });
    expect(create.status).toBe(403);
    expect(codeOf(create)).toBe("origin_rejected");
    await ageThrottle();
  });

  it("six sign-in attempts for an unused synthetic e-mail: the sixth is 429", async () => {
    await ageThrottle();
    const email = `unused-${randomBytes(4).toString("hex")}@mykey-staging.invalid`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const answer = await publicRequest("POST", "/v1/auth/sign-in/email", {
        body: { email, password: `wrong-${randomBytes(6).toString("hex")}` },
      });
      statuses.push(answer.status);
    }
    expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
    await ageThrottle();
  });
});

describe("8–9. canary sweep and clean-up", () => {
  it("no secret of this suite is in a dump, a log, the audit rows, the job tables or OpenBao's audit file", async () => {
    // The AppRole secret ids delivered in Run 3.8.
    for (const file of [
      "api/runtime-secret-id",
      "api/issuer-secret-id",
      "provisioner/provisioner-secret-id",
    ]) {
      const read = await sshExec(host, `cat /etc/mykey/secrets/${file}`, {
        sudo: true,
        secretOutput: true,
      });
      canary(read.stdout.trim());
    }
    const values = [...canaries];
    const places: [string, string][] = [];
    const since = startedAt.toISOString();
    for (const container of ["api", "provisioner", "postgres", "edge", "openbao"]) {
      const logs = await sshExec(host, `docker logs --since ${since} mykey-${container}-1 2>&1`, {
        sudo: true,
        timeoutMs: 120_000,
      });
      places.push([`docker logs ${container}`, logs.stdout + logs.stderr]);
    }
    // The audit device is searched on the host: since Session 4 it is too large to download
    // in time. The values travel on stdin; only counts come back. The control is the KV path
    // of the editor's write above: a search that misses it read nothing (countOnHost throws).
    const audit = await countOnHost(
      host,
      "docker exec mykey-openbao-1 cat /openbao/audit/audit.log",
      values,
      [`kv/data/p/${projectId}/e/${developmentId}/A`],
    );
    const hostHits = audit.found > 0 ? ["openbao audit device"] : [];
    const auditRows = await superuser.query<{ row: string }>(
      "SELECT row_to_json(e)::text AS row FROM audit.event e",
    );
    places.push(["audit.event", auditRows.rows.map((r) => r.row).join("\n")]);
    const jobRows = await superuser.query<{ row: string }>(
      "SELECT row_to_json(j)::text AS row FROM jobs.job j",
    );
    places.push(["jobs.job", jobRows.rows.map((r) => r.row).join("\n")]);
    // A logical dump through the tunnel, in a directory outside OneDrive and the repository.
    const directory = mkdtempSync(join(tmpdir(), "mykey-canary-"));
    try {
      const dump = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "-e",
          "PGPASSWORD",
          "--add-host",
          "host.docker.internal:host-gateway",
          "postgres@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42",
          "pg_dump",
          "-h",
          "host.docker.internal",
          "-p",
          String(staging.pg.port),
          "-U",
          "postgres",
          "-d",
          "postgres",
          "--no-owner",
        ],
        {
          encoding: "utf8",
          maxBuffer: 512 * 1024 * 1024,
          env: { ...process.env, PGPASSWORD: staging.pg.superuser.password, PGSSLMODE: "require" },
          timeout: 300_000,
        },
      );
      expect(dump.status, dump.stderr.slice(-300)).toBe(0);
      writeFileSync(join(directory, "dump.sql"), dump.stdout);
      places.push(["pg_dump", dump.stdout]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    const hits: string[] = [...hostHits];
    for (const [place, text] of places) {
      for (const value of values) {
        if (text.includes(value)) hits.push(place);
      }
    }
    const lines = [
      `# Canary sweep (Run 3.10), ${new Date().toISOString()}`,
      `values: ${String(values.length)} (passwords, TOTP seeds and codes, recovery codes, reset tokens and links, session cookie values, AppRole secret ids)`,
      `places: ${String(places.length + 1)} (${[...places.map(([place]) => place), "openbao audit device (searched on the host)"].join(", ")})`,
      `hits: ${String(hits.length)}${hits.length === 0 ? "" : ` in ${[...new Set(hits)].join(", ")}`}`,
      "",
    ];
    writeFileSync(
      join(import.meta.dirname, "../../docs/evidence/session-3/canary-sweep.txt"),
      lines.join("\n"),
    );
    expect(values.length).toBeGreaterThan(20);
    expect(hits).toEqual([]);
  }, 600_000);

  it("clean-up: the synthetic users and organization B are gone; reviewOpen is 0", async () => {
    await removeUsers([...synthetic.values()].map((user) => user.id));
    await superuser.query("DELETE FROM app.project WHERE organization_id = $1", [organizationB]);
    await superuser.query("DELETE FROM app.organization WHERE id = $1", [organizationB]);
    expect((await hostStatus(host)).reviewOpen).toBe(0);
  });
});
