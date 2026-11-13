// Run 3.2 Task B: the owner bootstrap (FR-1.01, AC-1.01, PO-5), against a real
// database, connected as `maintenance` — the operator identity (P-45).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth, ephemeralKeys, type Auth } from "@mykey/auth";
import { BOOTSTRAP_POINTS, bootstrapOwner, checkPassword } from "@mykey/auth/operator";
import { drizzle } from "drizzle-orm/node-postgres";
import { prepareDatabase, run, type TestDatabase } from "../database/setup.ts";

const WORKER = resolve(import.meta.dirname, "bootstrap-worker.ts");

let db: TestDatabase;
let auth: Auth;

beforeAll(async () => {
  db = await prepareDatabase();
  auth = createAuth({
    db: drizzle(db.pool("maintenance")),
    keys: ephemeralKeys(),
    baseURL: "https://mykey.test",
  });
});

afterAll(async () => {
  await db.drop();
});

/** Removes every account, organization and audit row: each case starts with no owner. */
async function empty(): Promise<void> {
  const superuser = db.pool("superuser");
  await run(superuser, "DELETE FROM app.membership");
  await run(superuser, "DELETE FROM app.organization");
  await run(superuser, 'DELETE FROM auth."user"');
  await run(superuser, "DELETE FROM audit.event");
}

beforeEach(empty);

const password = (): string => randomBytes(18).toString("base64url");
const email = (): string => `owner-${randomBytes(4).toString("hex")}@mykey.invalid`;

interface Counts {
  users: number;
  accounts: number;
  states: number;
  organizations: number;
  memberships: number;
  audit: number;
}

async function counts(): Promise<Counts> {
  const [row] = await run<Counts>(
    db.pool("superuser"),
    `SELECT (SELECT count(*)::int FROM auth."user") AS users,
            (SELECT count(*)::int FROM auth.account) AS accounts,
            (SELECT count(*)::int FROM auth.account_state) AS states,
            (SELECT count(*)::int FROM app.organization) AS organizations,
            (SELECT count(*)::int FROM app.membership) AS memberships,
            (SELECT count(*)::int FROM audit.event) AS audit`,
  );
  return row!;
}

const NONE: Counts = {
  users: 0,
  accounts: 0,
  states: 0,
  organizations: 0,
  memberships: 0,
  audit: 0,
};
const ONE: Counts = {
  users: 1,
  accounts: 1,
  states: 1,
  organizations: 1,
  memberships: 1,
  audit: 1,
};

function runWorker(
  settings: { email: string; password: string; crashAt: number | null },
  release?: Promise<void>,
): Promise<{ code: number | null; result: unknown }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const text = Buffer.concat(out).toString("utf8").trim();
      resolveRun({ code, result: text === "" ? null : (JSON.parse(text) as unknown) });
    });
    child.stdin.write(`${JSON.stringify({ target: db.targets.maintenance, ...settings })}\n`);
    void (release ?? Promise.resolve()).then(() => child.stdin.end("go\n"));
  });
}

describe("bootstrapOwner", () => {
  it("creates one owner, one organization in provisioning, one audit row", async () => {
    const address = email();
    const result = await bootstrapOwner(
      { auth, pool: db.pool("maintenance") },
      { email: address, password: password() },
    );
    expect(result).toMatchObject({ outcome: "created" });
    if (result.outcome !== "created") throw new Error("not created");
    expect(await counts()).toEqual(ONE);
    const [row] = await run<Record<string, unknown>>(
      db.pool("superuser"),
      `SELECT u.email, s.state, s.auth_epoch::int AS auth_epoch, s.credential_epoch::int AS credential_epoch,
              o.state AS organization_state, o.namespace, m.role, m.state AS membership_state,
              a.provider_id, a.password IS NOT NULL AS has_hash
         FROM auth."user" u
         JOIN auth.account_state s ON s.user_id = u.id
         JOIN auth.account a ON a.user_id = u.id
         JOIN app.membership m ON m.user_id = u.id
         JOIN app.organization o ON o.id = m.organization_id
        WHERE u.id = $1`,
      [result.userId],
    );
    expect(row).toEqual({
      email: address,
      state: "enrollment_pending",
      auth_epoch: 0,
      credential_epoch: 0,
      organization_state: "provisioning",
      namespace: `org-${result.organizationId}`,
      role: "owner",
      membership_state: "active",
      provider_id: "credential",
      has_hash: true,
    });
    const [audit] = await run<Record<string, unknown>>(
      db.pool("superuser"),
      "SELECT action, actor_kind, organization_id, target_kind, target_id, outcome, details FROM audit.event",
    );
    expect(audit).toEqual({
      action: "operator.bootstrap",
      actor_kind: "operator",
      organization_id: result.organizationId,
      target_kind: "user",
      target_id: result.userId,
      outcome: "success",
      details: {},
    });
  });

  it("stores the e-mail address as Better Auth looks it up (lower case)", async () => {
    const result = await bootstrapOwner(
      { auth, pool: db.pool("maintenance") },
      { email: "Owner.Mixed@MyKey.Invalid", password: password() },
    );
    expect(result.outcome).toBe("created");
    const rows = await run<{ email: string }>(
      db.pool("superuser"),
      'SELECT email FROM auth."user"',
    );
    expect(rows).toEqual([{ email: "owner.mixed@mykey.invalid" }]);
  });

  it("repeated with the same email changes nothing, even with another password", async () => {
    const address = email();
    const first = await bootstrapOwner(
      { auth, pool: db.pool("maintenance") },
      { email: address, password: password() },
    );
    const hashBefore = await run(db.pool("superuser"), "SELECT password FROM auth.account");
    const before = await counts();
    const second = await bootstrapOwner(
      { auth, pool: db.pool("maintenance") },
      { email: address.toUpperCase(), password: password() },
    );
    expect(second).toEqual({ ...first, outcome: "already_present" });
    expect(await counts()).toEqual(before);
    expect(await run(db.pool("superuser"), "SELECT password FROM auth.account")).toEqual(
      hashBefore,
    );
  });

  it("a different email is refused when an owner exists", async () => {
    await bootstrapOwner(
      { auth, pool: db.pool("maintenance") },
      { email: email(), password: password() },
    );
    const before = await counts();
    const other = await bootstrapOwner(
      { auth, pool: db.pool("maintenance") },
      { email: email(), password: password() },
    );
    expect(other).toEqual({ outcome: "refused", reason: "another_owner_exists" });
    expect(await counts()).toEqual(before);
  });

  it("killed after each statement, then repeated: exactly one owner", async () => {
    expect(BOOTSTRAP_POINTS.length).toBeGreaterThanOrEqual(6);
    for (let point = 1; point <= BOOTSTRAP_POINTS.length; point += 1) {
      await empty();
      const settings = { email: email(), password: password() };
      const killed = await runWorker({ ...settings, crashAt: point });
      expect(killed.code, `point ${String(point)}`).toBe(137);
      expect(await counts(), `point ${String(point)}`).toEqual(NONE);
      const clean = await runWorker({ ...settings, crashAt: null });
      expect(clean.result, `point ${String(point)}`).toMatchObject({ outcome: "created" });
      expect(await counts(), `point ${String(point)}`).toEqual(ONE);
    }
  });

  it("two bootstraps at once with one email: one created, one already_present", async () => {
    const settings = { email: email(), password: password(), crashAt: null };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const both = Promise.all([runWorker(settings, gate), runWorker(settings, gate)]);
    setTimeout(release, 1_500);
    const outcomes = (await both).map((run) => (run.result as { outcome: string }).outcome);
    expect(outcomes.sort()).toEqual(["already_present", "created"]);
    expect(await counts()).toEqual(ONE);
  });

  it("two bootstraps at once with different emails: one created, one refused", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const both = Promise.all([
      runWorker({ email: email(), password: password(), crashAt: null }, gate),
      runWorker({ email: email(), password: password(), crashAt: null }, gate),
    ]);
    setTimeout(release, 1_500);
    const outcomes = (await both).map((run) => (run.result as { outcome: string }).outcome);
    expect(outcomes.sort()).toEqual(["created", "refused"]);
    expect(await counts()).toEqual(ONE);
  });

  it.each([
    ["11 characters", () => "a".repeat(11), false],
    ["12 characters", () => "a".repeat(12), true],
    ["1,024 bytes", () => "a".repeat(1024), true],
    ["1,025 bytes", () => "a".repeat(1025), false],
    ["342 three-byte characters (1,026 bytes)", () => "€".repeat(342), false],
    ["341 three-byte characters (1,023 bytes)", () => "€".repeat(341), true],
  ] as const)("a password of %s: accepted %s", async (_name, make, accepted) => {
    const value = make();
    expect(checkPassword(value).ok).toBe(accepted);
    const result = await bootstrapOwner(
      { auth, pool: db.pool("maintenance") },
      { email: email(), password: value },
    );
    if (accepted) expect(result.outcome).toBe("created");
    else {
      expect(result).toEqual({ outcome: "refused", reason: "password_rejected" });
      expect(await counts()).toEqual(NONE);
    }
  });

  it("api_runtime cannot run it: refused on the first insert, nothing left", async () => {
    const error = await bootstrapOwner(
      { auth, pool: db.pool("api_runtime") },
      { email: email(), password: password() },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "42501" });
    expect((error as Error).message).toMatch(/permission denied for table user/);
    expect(await counts()).toEqual(NONE);
  });
});
