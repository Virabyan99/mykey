// Run 6.7 Task B (P-124, D-55): restoreInvalidate on a restored lost world.
// Each test restores the pair afresh into scratch instances.
import { randomUUID } from "node:crypto";
import { readIncarnation } from "@mykey/db";
import type { AppRoleName } from "@mykey/openbao";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { restoreInvalidate, type InvalidateCounts, type RestoreDeps } from "@mykey/ops";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RestoredPair } from "../../harness/pair-fixture.ts";
import { createLostWorld, type LostWorld } from "../../harness/restore-fixture.ts";
import { baoFetch, type Stack } from "../../harness/stack.ts";

let world: LostWorld;

beforeAll(async () => {
  world = await createLostWorld();
}, 900_000);

afterAll(async () => {
  await (world as LostWorld | undefined)?.close();
}, 300_000);

interface Restored {
  restored: RestoredPair & { token: string };
  admin: OpenBaoAdmin;
  delivered: Map<string, { roleId: string; secretId: string }>;
  deps: RestoreDeps;
}

/** A fresh restore and the restore's own root token, minted by the lost host's. */
async function freshRestore(crashAt?: RestoreDeps["crashAt"]): Promise<Restored> {
  const restored = await world.restore();
  const admin = new OpenBaoAdmin(restored.bao.bao, restored.token);
  const delivered = new Map<string, { roleId: string; secretId: string }>();
  const deps: RestoreDeps = {
    pool: restored.db,
    admin,
    pairId: world.pair.pairId,
    deliver: (namespace, name, credential) => {
      delivered.set(`${namespace}/${name}`, credential);
      return Promise.resolve();
    },
    ...(crashAt === undefined ? {} : { crashAt }),
  };
  return { restored, admin, delivered, deps };
}

const count = async (db: pg.Pool, sql: string): Promise<number> =>
  Number((await db.query<{ n: string }>(sql)).rows[0]?.n ?? "0");

const status = async (bao: Stack, path: string, token: string, namespace = "", body?: unknown) =>
  (
    await baoFetch(bao, path, {
      method: body === undefined ? "GET" : "POST",
      token,
      namespace,
      ...(body === undefined ? {} : { body }),
    })
  ).status;

const login = (bao: Stack, namespace: string, c: { roleId: string; secretId: string }) =>
  status(bao, "/v1/auth/approle/login", "", namespace, {
    role_id: c.roleId,
    secret_id: c.secretId,
  });

describe("restoreInvalidate (P-124)", () => {
  it("after pg_restore the control row says capturing and a write is refused; after the reset step it is idle with a new incarnation", async () => {
    const r = await freshRestore();
    const before = await r.restored.db.query<{ mode: string; incarnation: string | null }>(
      "SELECT capture_mode AS mode, backend_incarnation AS incarnation FROM app.service_control",
    );
    expect(before.rows[0]?.mode).toBe("capturing");
    await expect(r.restored.db.query("DELETE FROM auth.session")).rejects.toMatchObject({
      code: "MKC01",
    });
    await restoreInvalidate(r.deps);
    const after = await r.restored.db.query<{ mode: string; pair: string | null }>(
      "SELECT capture_mode AS mode, restored_from_pair AS pair FROM app.service_control",
    );
    expect(after.rows[0]).toEqual({ mode: "idle", pair: world.pair.pairId });
    const incarnation = await readIncarnation(r.restored.db);
    expect(incarnation).toMatch(/^[0-9a-f-]{36}$/);
    expect(incarnation).not.toBe(before.rows[0]?.incarnation);
    expect(incarnation).not.toBe(world.f.api.gate.backendIncarnation);
  }, 300_000);

  it("invalidates every class, and its counts are the test's own", async () => {
    const r = await freshRestore();
    const db = r.restored.db;
    const bao = r.restored.bao;
    const namespace = world.f.fx.namespace;
    // What the restored world holds before, counted by the test.
    const expected = {
      sessions: await count(db, "SELECT count(*) AS n FROM auth.session"),
      resetTokens: await count(db, "SELECT count(*) AS n FROM auth.reset_token"),
      accounts: await count(
        db,
        "SELECT count(*) AS n FROM auth.account_state WHERE state <> 'disabled'",
      ),
      credentials: await count(
        db,
        "SELECT count(*) AS n FROM app.machine_credential WHERE state <> 'revoked'",
      ),
      operationsClosed: await count(
        db,
        "SELECT count(*) AS n FROM app.operation WHERE state IN ('accepted', 'executing', 'awaiting_input')",
      ),
    };
    expect(expected.sessions).toBeGreaterThanOrEqual(3);
    expect(expected.resetTokens).toBe(2);
    // Five of the six 30-day rows (one was revoked before the capture) and the runtime credential.
    expect(expected.credentials).toBe(6);
    expect(
      (
        await db.query<{ kind: string; state: string }>(
          "SELECT kind, state FROM app.machine_credential WHERE id = $1",
          [world.old.runtime.credentialId],
        )
      ).rows,
    ).toEqual([{ kind: "runtime", state: "active" }]);
    // The token it had exchanged came back with the snapshot, alive.
    expect(
      await status(bao, "/v1/auth/token/lookup-self", world.old.runtime.token, namespace),
    ).toBe(200);
    expect(expected.operationsClosed).toBeGreaterThanOrEqual(1);
    const epochs = await db.query<{ user_id: string; auth_epoch: string }>(
      "SELECT user_id, auth_epoch FROM auth.account_state WHERE state <> 'disabled'",
    );
    const self = await r.admin.lookupSelf();
    const rootBefore = (await r.admin.listAccessors("")).filter((a) => a !== self.accessor);
    const nsBefore = await r.admin.listAccessors(namespace);
    const orgs = await r.admin.listNamespaces();
    let orgAccessors = 0;
    for (const ns of orgs) orgAccessors += (await r.admin.listAccessors(ns)).length;
    expect(nsBefore.length).toBeGreaterThanOrEqual(5);

    const counts: InvalidateCounts = await restoreInvalidate(r.deps);

    expect(counts).toEqual({
      ...expected,
      accessorsRevoked: rootBefore.length + orgAccessors,
      namespaces: orgs.length,
      secretIdsRotated: 3 * orgs.length,
    });
    expect(await count(db, "SELECT count(*) AS n FROM auth.session")).toBe(0);
    expect(await count(db, "SELECT count(*) AS n FROM auth.reset_token")).toBe(0);
    expect(await count(db, "SELECT count(*) AS n FROM auth.verification")).toBe(0);
    expect(await count(db, "SELECT count(*) AS n FROM auth.totp_step_used")).toBeGreaterThanOrEqual(
      0,
    );
    for (const row of epochs.rows) {
      const now = await db.query<{ state: string; auth_epoch: string }>(
        "SELECT state, auth_epoch FROM auth.account_state WHERE user_id = $1",
        [row.user_id],
      );
      expect(now.rows[0]?.state).toBe("recovery_pending");
      expect(Number(now.rows[0]?.auth_epoch)).toBe(Number(row.auth_epoch) + 1);
    }
    expect(
      await count(db, "SELECT count(*) AS n FROM app.machine_credential WHERE state <> 'revoked'"),
    ).toBe(0);
    expect(
      await count(
        db,
        "SELECT count(*) AS n FROM app.operation WHERE state IN ('accepted', 'executing', 'awaiting_input')",
      ),
    ).toBe(0);

    // OpenBao: no accessor but the restore's own; every old token refused.
    expect(await r.admin.listAccessors(namespace)).toEqual([]);
    expect(await r.admin.listAccessors("")).toEqual([self.accessor]);
    for (const old of world.old.tokens) {
      expect(await status(bao, "/v1/auth/token/lookup-self", old.token, namespace)).toBe(403);
    }
    // Session 11 (Run 11.3): the runtime credential is revoked as every row is (by
    // class, not by kind), and the token it had exchanged is gone with every accessor.
    expect(
      (
        await db.query<{ kind: string; state: string }>(
          "SELECT kind, state FROM app.machine_credential WHERE id = $1",
          [world.old.runtime.credentialId],
        )
      ).rows,
    ).toEqual([{ kind: "runtime", state: "revoked" }]);
    expect(
      await status(bao, "/v1/auth/token/lookup-self", world.old.runtime.token, namespace),
    ).toBe(403);
    expect(await status(bao, "/v1/auth/token/lookup-self", world.old.rootToken)).toBe(403);
    // The AppRoles: new secret ids delivered; the lost host's no longer log in.
    for (const name of ["runtime", "issuer", "provisioner"] as AppRoleName[]) {
      const fresh = r.delivered.get(`${namespace}/${name}`);
      expect(fresh, name).toBeDefined();
      if (fresh !== undefined) expect(await login(bao, namespace, fresh)).toBe(200);
      expect(await login(bao, namespace, world.old.approles[name])).toBe(400);
    }
    // The incarnation in every namespace equals the database's.
    const incarnation = await readIncarnation(db);
    expect(await r.admin.readIncarnation("")).toBe(incarnation);
    expect(await r.admin.readIncarnation(namespace)).toBe(incarnation);
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit.event WHERE action LIKE 'operator.restore_%' ORDER BY occurred_at`,
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      "operator.restore_begin",
      "operator.restore_invalidate",
    ]);
  }, 300_000);

  it("is idempotent: a second call changes nothing and returns zeros", async () => {
    const r = await freshRestore();
    await restoreInvalidate(r.deps);
    const incarnation = await readIncarnation(r.restored.db);
    const rotated = new Map(r.delivered);
    r.delivered.clear();
    expect(await restoreInvalidate(r.deps)).toEqual({
      sessions: 0,
      accounts: 0,
      resetTokens: 0,
      credentials: 0,
      accessorsRevoked: 0,
      namespaces: 0,
      secretIdsRotated: 0,
      operationsClosed: 0,
    });
    expect(r.delivered.size).toBe(0);
    expect(await readIncarnation(r.restored.db)).toBe(incarnation);
    const fresh = rotated.get(`${world.f.fx.namespace}/runtime`);
    if (fresh === undefined) throw new Error("runtime was not rotated");
    expect(await login(r.restored.bao, world.f.fx.namespace, fresh)).toBe(200);
  }, 300_000);

  it("stopped after the database part, a second call completes the backend part", async () => {
    const r = await freshRestore((point) => {
      if (point === "database") throw new Error("stopped");
    });
    await expect(restoreInvalidate(r.deps)).rejects.toThrow("stopped");
    expect(await count(r.restored.db, "SELECT count(*) AS n FROM auth.session")).toBe(0);
    expect((await r.admin.listAccessors(world.f.fx.namespace)).length).toBeGreaterThan(0);
    const second = await restoreInvalidate({ ...r.deps, crashAt: () => undefined });
    expect(second.sessions).toBe(0);
    const orgs = (await r.admin.listNamespaces()).length;
    expect(second.namespaces).toBe(orgs);
    expect(second.secretIdsRotated).toBe(3 * orgs);
    expect(await r.admin.listAccessors(world.f.fx.namespace)).toEqual([]);
  }, 300_000);

  it("an accessor in a namespace the catalog does not know is revoked too (D-18)", async () => {
    const r = await freshRestore();
    const stray = `org-${randomUUID()}`;
    await r.admin.createNamespace(stray);
    const created = await baoFetch(r.restored.bao, "/v1/auth/token/create", {
      method: "POST",
      token: world.old.rootToken,
      namespace: stray,
      body: { policies: ["default"], ttl: "1h" },
    });
    expect(created.status).toBe(200);
    const token = ((await created.json()) as { auth: { client_token: string } }).auth.client_token;
    expect(await r.admin.listAccessors(stray)).toHaveLength(1);
    const counts = await restoreInvalidate(r.deps);
    expect(counts.namespaces).toBe((await r.admin.listNamespaces()).length);
    expect(counts.namespaces).toBeGreaterThanOrEqual(3);
    expect(await r.admin.listAccessors(stray)).toEqual([]);
    expect(await status(r.restored.bao, "/v1/auth/token/lookup-self", token, stray)).toBe(403);
  }, 300_000);
});
