// Run 11.5 Task A (Session 11, P-185, P-191 to P-193, D-82; spec §6 items 1
// and 9): the owner issues, lists and revokes automation credentials, against
// real PostgreSQL and OpenBao. Like a runtime credential it is nothing in
// OpenBao: a row with a verifier, issued and revoked in one transaction each.
// The secret is shown once, in the 201; it is compared here by shape, lengths
// and booleans only (Doc 10 §4.1 rule 2).
import { randomUUID } from "node:crypto";
import { LIMITS, parsePresentedSecret } from "@mykey/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LOOPBACK,
  automationPath,
  clearAutomation,
  issueAutomation,
  issueAutomationFor,
  listAutomation,
  revokeAutomation,
} from "../../harness/automation.ts";
import {
  clearCredentials,
  createCredentialsFixture,
  issueRuntimeFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { exchangeCall } from "../../harness/machine.ts";

let f: CredentialsFixture;

beforeAll(async () => {
  f = await createCredentialsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  await clearCredentials(f, f.env("env1a").environmentId);
  await clearAutomation(f);
});

interface Stored {
  id: string;
  owner_id: string;
  state: string;
  rights: string[];
  bound_cidrs: string[];
  verifier: Buffer;
  revoked_at: Date | null;
}

async function stored(): Promise<Stored[]> {
  const result = await f.api.superuser.query<Stored>(
    `SELECT id, owner_id, state, rights, bound_cidrs, verifier, revoked_at
       FROM app.automation_credential ORDER BY created_at, id`,
  );
  return result.rows;
}

type View = Record<string, unknown>;
const viewsOf = (body: Record<string, unknown>): View[] => body.credentials as View[];
const secretPart = (secret: string): string => parsePresentedSecret(secret)?.secret ?? "";

describe("automation_credentials.issue", () => {
  it("issue with a fresh TOTP answers 201 with a secret of the mkac shape, once; the list shows the credential with its rights, addresses, expiry and no secret; a second read of the operation shows ids only", async () => {
    const before = Date.now();
    const answer = await issueAutomation(f, {
      rights: ["runtime_credentials.manage", "projects.create"],
      cidrs: ["127.0.0.0/8", "2001:db8::/32"],
    });
    expect(answer.status, answer.code).toBe(201);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const secret = answer.body.secret as string;
    const parsed = parsePresentedSecret(secret);
    const credential = answer.body.credential as View;
    expect(parsed?.prefix).toBe("mkac");
    expect(parsed?.id).toBe(credential.credentialId);
    expect(Object.keys(answer.body).sort()).toEqual(["credential", "operationId", "secret"]);
    expect(answer.body.operationId).toBe(answer.operationId);
    expect(credential).toMatchObject({
      // Without `replaces` it starts a chain of its own (P-193).
      ownerId: credential.credentialId,
      name: "provisioner",
      // In the contract's order, whatever order was asked for.
      rights: ["projects.create", "runtime_credentials.manage"],
      boundCidrs: ["127.0.0.0/8", "2001:db8::/32"],
      state: "active",
      expiringSoon: false,
      lastUsedAt: null,
      managedProjects: 0,
    });
    const week = LIMITS.automationCredential.defaultTtlSeconds * 1000;
    const expiresAt = Date.parse(credential.expiresAt as string);
    expect(expiresAt).toBeGreaterThan(before + week - 60_000);
    expect(expiresAt).toBeLessThan(Date.now() + week + 60_000);
    expect(Date.parse(credential.issuedAt as string)).toBeGreaterThan(before - 60_000);

    const list = await listAutomation(f);
    expect(list.status, list.code).toBe(200);
    expect(viewsOf(list.body)).toEqual([credential]);
    expect(list.body.nextCursor).toBeNull();
    for (const hidden of [secretPart(secret), "mkac."]) {
      expect(list.text.includes(hidden)).toBe(false);
    }

    const operation = await f.send("GET", `/v1/operations/${answer.operationId ?? ""}`, {
      key: null,
    });
    expect(operation.status, operation.code).toBe(200);
    expect(operation.body.state).toBe("succeeded");
    expect(operation.body.result).toEqual({ credentialId: credential.credentialId });
    expect(operation.text.includes(secretPart(secret))).toBe(false);

    // The row holds a verifier of 32 bytes that is no encoding of the secret.
    const [row] = await stored();
    const raw = Buffer.from(secretPart(secret), "base64url");
    expect(row?.verifier.length).toBe(32);
    expect(row?.verifier.equals(raw)).toBe(false);
  });

  it("issue without a fresh TOTP is 403 and no row exists; an admin may issue, a member may not", async () => {
    await f.api.superuser.query(
      "UPDATE auth.session SET totp_verified_at = now() - interval '601 seconds'",
    );
    const stale = await issueAutomation(f, {}, { fresh: false });
    expect([stale.status, stale.code]).toEqual([403, "fresh_verification_required"]);
    expect(await stored()).toEqual([]);

    const member = await issueAutomation(f, {}, { user: "editorA" });
    expect([member.status, member.code]).toEqual([403, "action_denied"]);
    const memberList = await listAutomation(f, { user: "editorA" });
    expect([memberList.status, memberList.code]).toEqual([403, "action_denied"]);
    expect(await stored()).toEqual([]);

    const admin = await issueAutomation(f, {}, { user: "adminA" });
    expect(admin.status, admin.code).toBe(201);
    expect(await stored()).toHaveLength(1);
    // Another organization's owner sees none of it.
    const other = await f.send("GET", automationPath(f), { key: null, user: "ownerB" });
    expect(other.status).toBe(404);
  });

  it("no right, an unknown right, a right twice, no CIDR, a /0, an address with host bits, a lifetime of 3,599 s and one of a year and a second are each 422", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["no right", { rights: [] }],
      ["an unknown right", { rights: ["secrets.update"] }],
      ["a right twice", { rights: ["projects.create", "projects.create"] }],
      ["no CIDR", { cidrs: [] }],
      ["a /0", { cidrs: ["0.0.0.0/0"] }],
      ["an IPv6 /0", { cidrs: ["::/0"] }],
      ["host bits", { cidrs: ["192.0.2.7/24"] }],
      ["nine networks", { cidrs: Array.from({ length: 9 }, (_, i) => `10.${String(i)}.0.0/16`) }],
      ["3,599 seconds", { ttlSeconds: LIMITS.automationCredential.minTtlSeconds - 1 }],
      ["a year and a second", { ttlSeconds: LIMITS.automationCredential.maxTtlSeconds + 1 }],
    ];
    for (const [label, body] of cases) {
      const answer = await issueAutomation(f, body);
      expect([answer.status, answer.code], label).toEqual([422, "validation_failed"]);
    }
    // A key the contract does not have is refused by the body's shape: nobody chooses the secret.
    const chosen = await issueAutomation(f, { secret: "chosen-by-the-caller" });
    expect([chosen.status, chosen.code]).toEqual([400, "malformed_request"]);
    expect(await stored()).toEqual([]);
    // The bounds themselves are accepted.
    for (const ttlSeconds of [
      LIMITS.automationCredential.minTtlSeconds,
      LIMITS.automationCredential.maxTtlSeconds,
    ]) {
      const answer = await issueAutomation(f, { ttlSeconds });
      expect(answer.status, String(ttlSeconds)).toBe(201);
    }
  });

  it("a replayed key answers credential_not_replayable with the credential's id, never the secret; the same key with another body is a conflict", async () => {
    const key = randomUUID();
    const first = await issueAutomation(f, {}, { key });
    expect(first.status, first.code).toBe(201);
    const credentialId = (first.body.credential as { credentialId: string }).credentialId;
    const secret = secretPart(first.body.secret as string);
    expect(secret).toHaveLength(43);

    const again = await issueAutomation(f, {}, { key });
    expect([again.status, again.code]).toEqual([409, "credential_not_replayable"]);
    expect(again.details).toEqual({ credentialId, state: "active" });
    expect(again.operationId).toBe(first.operationId);
    expect(again.text.includes(secret)).toBe(false);
    expect(again.text.includes("mkac.")).toBe(false);

    const other = await issueAutomation(f, { name: "another" }, { key });
    expect([other.status, other.code]).toEqual([409, "idempotency_conflict"]);
    expect(await stored()).toHaveLength(1);
  });

  it("issued with replaces: the new credential's ownerId is the replaced one's, whatever its state (active, revoked, expired); replaces naming an id of nothing is 404, and nothing is issued", async () => {
    const first = await issueAutomationFor(f);
    expect(first.ownerId).toBe(first.credentialId);

    const second = await issueAutomationFor(f, { replaces: first.credentialId });
    expect(second.ownerId).toBe(first.credentialId);
    expect(second.credentialId).not.toBe(first.credentialId);

    // Revoked: the chain is still joined, and through a member of it that is not its first.
    expect((await revokeAutomation(f, second.credentialId)).status).toBe(200);
    const third = await issueAutomationFor(f, { replaces: second.credentialId });
    expect(third.ownerId).toBe(first.credentialId);

    // Expired.
    await f.api.superuser.query(
      "UPDATE app.automation_credential SET expires_at = now() - interval '1 second' WHERE id = $1",
      [first.credentialId],
    );
    const fourth = await issueAutomationFor(f, { replaces: first.credentialId });
    expect(fourth.ownerId).toBe(first.credentialId);

    const before = (await stored()).length;
    const nothing = await issueAutomation(f, { replaces: randomUUID() });
    expect([nothing.status, nothing.code]).toEqual([404, "not_found"]);
    expect(nothing.body.secret).toBeUndefined();
    expect((await stored()).length).toBe(before);

    // The list reads the first as expired, the second as revoked, the others as active.
    const list = await listAutomation(f);
    const states = new Map(viewsOf(list.body).map((view) => [view.credentialId, view.state]));
    expect(states.get(first.credentialId)).toBe("expired");
    expect(states.get(second.credentialId)).toBe("revoked");
    expect(states.get(third.credentialId)).toBe("active");
    expect(states.get(fourth.credentialId)).toBe("active");
  });

  it("the audit row of an issuance holds ids, counts and the rights as booleans; nothing of the secret is in audit, operations or the API's log", async () => {
    const issued = await issueAutomationFor(f, {
      rights: ["projects.create", "secrets.create"],
      ttlSeconds: 7200,
    });
    const secret = secretPart(issued.secret);
    const raw = Buffer.from(secret, "base64url");
    const audit = await f.api.superuser.query<{
      actor_kind: string;
      target_id: string;
      details: Record<string, unknown>;
    }>(
      `SELECT actor_kind, target_id, details FROM audit.event
        WHERE action = 'automation_credential.issue' AND operation_id = $1`,
      [issued.operationId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_kind).toBe("user");
    expect(audit.rows[0]?.target_id).toBe(f.tenants.a.organizationId);
    expect(audit.rows[0]?.details).toEqual({
      credentialId: issued.credentialId,
      ownerId: issued.credentialId,
      nameLength: "provisioner".length,
      ttlSeconds: 7200,
      cidrCount: LOOPBACK.length,
      projectsCreate: true,
      keysCreate: true,
      runtimeCredentialsManage: false,
    });
    for (const [label, sql] of [
      [
        "audit.event",
        "SELECT count(*)::int AS n FROM audit.event WHERE position($1 in details::text) > 0",
      ],
      [
        "app.operation",
        `SELECT count(*)::int AS n FROM app.operation
          WHERE position($1 in coalesce(result::text, '') || coalesce(expected::text, '')) > 0`,
      ],
    ] as const) {
      const found = await f.api.superuser.query<{ n: number }>(sql, [secret]);
      expect(found.rows[0]?.n, label).toBe(0);
    }
    const log = JSON.stringify(f.api.logs);
    expect(log.includes(secret)).toBe(false);
    expect(log.includes(raw.toString("hex"))).toBe(false);
    // Control: the log is the one that saw the request.
    expect(issued.requestId.length).toBeGreaterThan(0);
    expect(log.includes(issued.requestId)).toBe(true);
    expect(log.includes("mkac.")).toBe(false);
  });
});

describe("automation_credentials.list", () => {
  it("lists the newest first, a page at a time under a signed cursor, and counts the projects each chain manages", async () => {
    const first = await issueAutomationFor(f, { name: "first" });
    const second = await issueAutomationFor(f, { name: "second", replaces: first.credentialId });
    const third = await issueAutomationFor(f, { name: "third" });
    // A project of the first chain (made by the test: the automation routes come in Task C).
    await f.api.superuser.query("UPDATE app.project SET managed_by = $1 WHERE id = $2", [
      first.credentialId,
      f.env("env1a").projectId,
    ]);

    const whole = await listAutomation(f);
    expect(viewsOf(whole.body).map((view) => [view.name, view.managedProjects])).toEqual([
      ["third", 0],
      ["second", 1],
      ["first", 1],
    ]);

    const pageOne = await listAutomation(f, { query: "?limit=2" });
    expect(viewsOf(pageOne.body).map((view) => view.credentialId)).toEqual([
      third.credentialId,
      second.credentialId,
    ]);
    const cursor = pageOne.body.nextCursor as string;
    expect(typeof cursor).toBe("string");
    const pageTwo = await listAutomation(f, { query: `?limit=2&cursor=${cursor}` });
    expect(viewsOf(pageTwo.body).map((view) => view.credentialId)).toEqual([first.credentialId]);
    expect(pageTwo.body.nextCursor).toBeNull();
    const forged = await listAutomation(f, { query: `?limit=2&cursor=${cursor.slice(0, -2)}xx` });
    expect([forged.status, forged.code]).toEqual([400, "malformed_request"]);
  });

  it("a credential in the last quarter of a short life reads expiringSoon; past its expiry it reads expired and no longer expiringSoon", async () => {
    const issued = await issueAutomationFor(f, { ttlSeconds: 3600 });
    const view = async (): Promise<View | undefined> =>
      viewsOf((await listAutomation(f)).body).find(
        (entry) => entry.credentialId === issued.credentialId,
      );
    expect(await view()).toMatchObject({ state: "active", expiringSoon: false });
    // Ten minutes left of an hour.
    await f.api.superuser.query(
      `UPDATE app.automation_credential
          SET created_at = now() - interval '50 minutes', expires_at = now() + interval '10 minutes'
        WHERE id = $1`,
      [issued.credentialId],
    );
    expect(await view()).toMatchObject({ state: "active", expiringSoon: true });
    await f.api.superuser.query(
      "UPDATE app.automation_credential SET expires_at = now() - interval '1 second' WHERE id = $1",
      [issued.credentialId],
    );
    expect(await view()).toMatchObject({ state: "expired", expiringSoon: false });
  });
});

describe("automation_credentials.revoke", () => {
  it("revoke answers 200 and the row is revoked; the projects its chain manages, their secrets and their runtime credentials are untouched, and an exchange for one of them still answers 200", async () => {
    const issued = await issueAutomationFor(f);
    const env = f.env("env1a");
    await f.api.superuser.query("UPDATE app.project SET managed_by = $1 WHERE id = $2", [
      issued.credentialId,
      env.projectId,
    ]);
    const name = `K_${randomUUID().slice(0, 8).toUpperCase()}`;
    expect((await f.create("env1a", name, `synthetic-${randomUUID()}`)).status).toBe(201);
    const runtime = await issueRuntimeFor(f, "env1a");
    const project = async () =>
      (
        await f.api.superuser.query<{ state: string; managed_by: string | null }>(
          "SELECT state, managed_by FROM app.project WHERE id = $1",
          [env.projectId],
        )
      ).rows[0];
    const index = async () =>
      (
        await f.api.superuser.query<{ name: string; state: string; current_version: number }>(
          `SELECT name, state, current_version FROM app.secret_index
            WHERE environment_id = $1 ORDER BY name`,
          [env.environmentId],
        )
      ).rows;
    const projectBefore = await project();
    const indexBefore = await index();

    const answer = await revokeAutomation(f, issued.credentialId);
    expect(answer.status, answer.code).toBe(200);
    expect(answer.body.state).toBe("succeeded");
    expect(answer.body.result).toEqual({ credentialId: issued.credentialId, state: "revoked" });
    const [row] = await stored();
    expect(row?.state).toBe("revoked");
    expect(row?.revoked_at).not.toBeNull();
    const views = viewsOf((await listAutomation(f)).body);
    expect(views[0]).toMatchObject({ state: "revoked", managedProjects: 1 });

    expect(await project()).toEqual(projectBefore);
    expect(await index()).toEqual(indexBefore);
    const runtimeRow = await f.api.superuser.query<{ state: string }>(
      "SELECT state FROM app.machine_credential WHERE id = $1",
      [runtime.credentialId],
    );
    expect(runtimeRow.rows[0]?.state).toBe("active");
    const exchange = await exchangeCall(f, { secret: runtime.clientSecret });
    expect(exchange.status, exchange.code).toBe(200);

    const audit = await f.api.superuser.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit.event
        WHERE action = 'automation_credential.revoke' AND operation_id = $1`,
      [answer.operationId],
    );
    expect(audit.rows.map((event) => event.details)).toEqual([
      { credentialId: issued.credentialId },
    ]);
  });

  it("the same key again replays the revocation; a second revocation is a state conflict; an id of nothing, an id that is no id and another organization's owner are 404; a member is refused; without confirmed it is 422", async () => {
    const issued = await issueAutomationFor(f);
    const unconfirmed = await revokeAutomation(f, issued.credentialId, { body: {} });
    expect([unconfirmed.status, unconfirmed.code]).toEqual([422, "validation_failed"]);
    const member = await revokeAutomation(f, issued.credentialId, { user: "editorA" });
    expect([member.status, member.code]).toEqual([403, "action_denied"]);
    const stranger = await revokeAutomation(f, issued.credentialId, { user: "ownerB" });
    expect(stranger.status).toBe(404);
    expect((await stored())[0]?.state).toBe("active");

    const key = randomUUID();
    const first = await revokeAutomation(f, issued.credentialId, { key });
    expect(first.status, first.code).toBe(200);
    const replay = await revokeAutomation(f, issued.credentialId, { key });
    expect(replay.status).toBe(200);
    expect(replay.operationId).toBe(first.operationId);
    const second = await revokeAutomation(f, issued.credentialId);
    expect([second.status, second.code]).toEqual([409, "state_conflict"]);

    for (const id of [randomUUID(), "not-an-id"]) {
      const answer = await revokeAutomation(f, id);
      expect([answer.status, answer.code], id).toEqual([404, "not_found"]);
    }
  });

  it("an expired credential can still be revoked", async () => {
    const issued = await issueAutomationFor(f);
    await f.api.superuser.query(
      "UPDATE app.automation_credential SET expires_at = now() - interval '1 second' WHERE id = $1",
      [issued.credentialId],
    );
    const answer = await revokeAutomation(f, issued.credentialId);
    expect(answer.status, answer.code).toBe(200);
    expect((await stored())[0]?.state).toBe("revoked");
  });
});
