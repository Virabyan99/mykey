// Run 11.3 Task A (P-185, P-186, D-81): a runtime credential through the API,
// against real PostgreSQL and OpenBao. It is issued and revoked in one
// transaction each and never asks OpenBao for anything: its row holds a
// verifier, no accessor. The client secret is shown once, in the 201; it is
// compared here by shape, lengths and booleans only (Doc 10 §4.1 rule 2).
import { randomUUID } from "node:crypto";
import { LIMITS, parsePresentedSecret } from "@mykey/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearCredentials,
  createCredentialsFixture,
  issueFor,
  issueRuntimeFor,
  machineAccessors,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import type { EnvName } from "../../harness/secrets-fixture.ts";

let f: CredentialsFixture;

beforeAll(async () => {
  f = await createCredentialsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(async () => {
  f.setBao("relay");
  await f.setUpstreamClosed(false);
  for (const env of ["env1a", "env1b", "env2a"] as const) {
    await clearCredentials(f, f.env(env).environmentId);
  }
});

const envId = (env: EnvName) => f.env(env).environmentId;
const orgPath = () => `/v1/organizations/${f.tenants.a.organizationId}`;

async function rows(env: EnvName): Promise<number> {
  const result = await f.api.superuser.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM app.machine_credential WHERE environment_id = $1",
    [envId(env)],
  );
  return result.rows[0]?.count ?? 0;
}

const stateOf = async (credentialId: string): Promise<string | undefined> =>
  (
    await f.api.superuser.query<{ state: string }>(
      "SELECT state FROM app.machine_credential WHERE id = $1",
      [credentialId],
    )
  ).rows[0]?.state;

/** The 43 characters after the id: what must be nowhere but the 201. */
const secretPart = (clientSecret: string): string =>
  parsePresentedSecret(clientSecret)?.secret ?? "";

describe("runtime_credentials.issue", () => {
  it("issue with a fresh TOTP answers 201 with a clientSecret of the mkrc shape, cache-control no-store, and a credential of kind runtime, state active, expiring in 365 days", async () => {
    const before = Date.now();
    const answer = await f.issueRuntime("env1a");
    expect(answer.status, answer.code).toBe(201);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const credential = answer.body.credential as Record<string, unknown>;
    const parsed = parsePresentedSecret(answer.body.clientSecret as string);
    expect(parsed?.prefix).toBe("mkrc");
    expect(parsed?.id).toBe(credential.credentialId);
    expect(credential).toMatchObject({
      kind: "runtime",
      state: "active",
      environmentId: envId("env1a"),
      issuedByKind: "user",
      boundCidrs: [],
      name: "server",
      lastUsedAt: null,
      expiringSoon: false,
    });
    expect(typeof credential.issuedAt).toBe("string");
    const year = LIMITS.runtimeCredential.defaultTtlSeconds * 1000;
    const expiresAt = Date.parse(credential.expiresAt as string);
    expect(expiresAt).toBeGreaterThan(before + year - 60_000);
    expect(expiresAt).toBeLessThan(Date.now() + year + 60_000);
    expect(answer.body.operationId).toBe(answer.operationId);
  });

  it("a ttlSeconds and CIDRs of the caller's choice are kept; the lifetime is the one asked for", async () => {
    const before = Date.now();
    const answer = await f.issueRuntime("env1a", {
      ttlSeconds: 3600,
      cidrs: ["192.0.2.0/24", "2001:db8::/32"],
    });
    expect(answer.status, answer.code).toBe(201);
    const credential = answer.body.credential as Record<string, unknown>;
    expect(credential.boundCidrs).toEqual(["192.0.2.0/24", "2001:db8::/32"]);
    const expiresAt = Date.parse(credential.expiresAt as string);
    expect(expiresAt).toBeGreaterThan(before + 3_600_000 - 60_000);
    expect(expiresAt).toBeLessThan(Date.now() + 3_600_000 + 60_000);
  });

  it("issue without a fresh TOTP is 403 fresh_verification_required, and no row exists", async () => {
    const before = await rows("env1a");
    await f.api.superuser.query(
      "UPDATE auth.session SET totp_verified_at = now() - interval '601 seconds'",
    );
    const answer = await f.issueRuntime("env1a", {}, { fresh: false });
    expect(answer.status).toBe(403);
    expect(answer.code).toBe("fresh_verification_required");
    expect(await rows("env1a")).toBe(before);
  });

  it("a member who may not manage credentials is refused, and no row exists", async () => {
    const before = await rows("env1a");
    const answer = await f.issueRuntime("env1a", {}, { user: "editorA" });
    expect(answer.status).toBe(403);
    expect(answer.code).toBe("action_denied");
    expect(await rows("env1a")).toBe(before);
  });

  it("the same Idempotency-Key again answers credential_not_replayable with the credential's id, never the secret", async () => {
    const key = randomUUID();
    // Rows of earlier cases stay (revoked): this case counts what it adds.
    const before = await rows("env1a");
    const first = await f.issueRuntime("env1a", {}, { key });
    expect(first.status, first.code).toBe(201);
    const credentialId = (first.body.credential as { credentialId: string }).credentialId;
    const secret = secretPart(first.body.clientSecret as string);
    expect(secret).toHaveLength(43);

    const again = await f.issueRuntime("env1a", {}, { key });
    expect(again.status).toBe(409);
    expect(again.code).toBe("credential_not_replayable");
    expect(again.details).toEqual({ credentialId, state: "active" });
    expect(again.operationId).toBe(first.operationId);
    expect(again.text.includes(secret)).toBe(false);
    expect(again.text.includes("mkrc.")).toBe(false);
    expect(await rows("env1a")).toBe(before + 1);

    // The same key with another body is a conflict, not a second credential.
    const other = await f.issueRuntime("env1a", { name: "another" }, { key });
    expect(other.status).toBe(409);
    expect(other.code).toBe("idempotency_conflict");
    expect(await rows("env1a")).toBe(before + 1);
  });

  it("the operation's stored result, the audit row and the API's log of the request hold the credential's id and no part of the secret", async () => {
    const issued = await issueRuntimeFor(f, "env1a", { cidrs: ["192.0.2.0/24"] });
    const secret = secretPart(issued.clientSecret);
    const raw = Buffer.from(secret, "base64url");
    const forms = [secret, raw.toString("hex"), raw.toString("base64")];

    const operation = await f.api.superuser.query<{ text: string; state: string }>(
      "SELECT row_to_json(o)::text AS text, o.state FROM app.operation o WHERE o.id = $1",
      [issued.operationId],
    );
    const operationText = operation.rows[0]?.text ?? "";
    expect(operation.rows[0]?.state).toBe("succeeded");
    const audit = await f.api.superuser.query<{ text: string; details: Record<string, unknown> }>(
      `SELECT row_to_json(e)::text AS text, e.details FROM audit.event e
        WHERE e.operation_id = $1 AND e.action = 'credential.issue'`,
      [issued.operationId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.details).toEqual({
      credentialId: issued.credentialId,
      nameLength: 6,
      ttlSeconds: LIMITS.runtimeCredential.defaultTtlSeconds,
      kind: "runtime",
      cidrCount: 1,
    });
    const auditText = audit.rows[0]?.text ?? "";
    const logText = JSON.stringify(f.api.logs);

    // The controls: each surface is the right one and is not empty.
    expect(operationText.includes(issued.credentialId)).toBe(true);
    expect(auditText.includes(issued.credentialId)).toBe(true);
    expect(issued.requestId.length).toBeGreaterThan(0);
    expect(logText.includes(issued.requestId)).toBe(true);
    for (const form of forms) {
      expect(operationText.includes(form), "operation").toBe(false);
      expect(auditText.includes(form), "audit").toBe(false);
      expect(logText.includes(form), "log").toBe(false);
    }
    expect(logText.includes("mkrc.")).toBe(false);
  });

  it("the database holds a 32-byte verifier and its key id, and no column holds the secret", async () => {
    const issued = await issueRuntimeFor(f, "env1a");
    const secret = secretPart(issued.clientSecret);
    const raw = Buffer.from(secret, "base64url");
    const row = await f.api.superuser.query<{
      text: string;
      bytes: number;
      verifier_key_id: string | null;
      accessor: string | null;
      kind: string;
      state: string;
      issued_by_kind: string;
    }>(
      `SELECT row_to_json(c)::text AS text, octet_length(c.verifier) AS bytes, c.verifier_key_id,
              c.accessor, c.kind, c.state, c.issued_by_kind
         FROM app.machine_credential c WHERE c.id = $1`,
      [issued.credentialId],
    );
    const stored = row.rows[0];
    expect(stored).toMatchObject({
      bytes: 32,
      accessor: null,
      kind: "runtime",
      state: "active",
      issued_by_kind: "user",
    });
    expect(stored?.verifier_key_id).toMatch(/^k[1-9][0-9]*$/);
    // The control: the row's text is the row (it holds its own id).
    expect(stored?.text.includes(issued.credentialId)).toBe(true);
    for (const form of [secret, raw.toString("hex"), raw.toString("base64")]) {
      expect(stored?.text.includes(form)).toBe(false);
    }
  });

  it("a CIDR with host bits, a /0, a name and nine entries are each 422 validation_failed", async () => {
    const before = await rows("env1a");
    const nine = Array.from({ length: 9 }, (_unused, index) => `192.0.2.${String(index)}/32`);
    for (const cidrs of [["192.0.2.7/24"], ["0.0.0.0/0"], ["example.test/24"], nine]) {
      const answer = await f.issueRuntime("env1a", { cidrs });
      expect(answer.status, JSON.stringify(cidrs)).toBe(422);
      expect(answer.code).toBe("validation_failed");
    }
    expect(await rows("env1a")).toBe(before);
    // The control: eight strict networks are accepted.
    const eight = await f.issueRuntime("env1a", { cidrs: nine.slice(0, 8) });
    expect(eight.status, eight.code).toBe(201);
  });

  it("a ttlSeconds above 365 days is 422, and an unknown field is 400", async () => {
    const before = await rows("env1a");
    const tooLong = await f.issueRuntime("env1a", {
      ttlSeconds: LIMITS.runtimeCredential.maxTtlSeconds + 1,
    });
    expect(tooLong.status).toBe(422);
    // The wrong shape, as everywhere (validate.ts): nobody chooses a kind in this body.
    const unknown = await f.issueRuntime("env1a", { kind: "token" });
    expect(unknown.status).toBe(400);
    expect(await rows("env1a")).toBe(before);
  });
});

describe("the inventory and the summary", () => {
  it("credentials.list shows both kinds with their kind; credentials.summary counts the runtime row under active", async () => {
    const summaryOf = async (): Promise<Record<string, number>> => {
      const answer = await f.send("GET", `${orgPath()}/credentials/summary`, { key: null });
      expect(answer.status).toBe(200);
      return answer.body.byState as Record<string, number>;
    };
    const before = await summaryOf();
    const token = await issueFor(f, "env1a", { ttlSeconds: 600 });
    const runtime = await issueRuntimeFor(f, "env1a");
    const listed = await f.send("GET", `${f.env("env1a").path}/credentials`, { key: null });
    expect(listed.status).toBe(200);
    // Revoked runtime credentials of earlier cases are listed too: only these two are read.
    const kinds = Object.fromEntries(
      (listed.body.credentials as { credentialId: string; kind: string; state: string }[])
        .filter((row) => row.state === "active")
        .map((row) => [row.credentialId, row.kind]),
    );
    expect(kinds).toEqual({ [token.credentialId]: "token", [runtime.credentialId]: "runtime" });
    expect(listed.text.includes("mkrc.")).toBe(false);
    expect(listed.text.includes("verifier")).toBe(false);
    const after = await summaryOf();
    expect((after.active ?? 0) - (before.active ?? 0)).toBe(2);
  });

  it("a revoked runtime credential stays in the list and in the summary, as revoked", async () => {
    const summaryOf = async (): Promise<number> => {
      const answer = await f.send("GET", `${orgPath()}/credentials/summary`, { key: null });
      return (answer.body.byState as Record<string, number>).revoked ?? 0;
    };
    const runtime = await issueRuntimeFor(f, "env1a");
    const before = await summaryOf();
    expect((await f.revoke("env1a", runtime.credentialId)).status).toBe(200);
    const listed = await f.send("GET", `${f.env("env1a").path}/credentials`, { key: null });
    const row = (listed.body.credentials as { credentialId: string; state: string }[]).find(
      (candidate) => candidate.credentialId === runtime.credentialId,
    );
    expect(row?.state).toBe("revoked");
    expect((await summaryOf()) - before).toBe(1);
  });
});

describe("credentials.revoke of a runtime credential", () => {
  it("credentials.revoke of a runtime credential answers 200 revoked in one request, with OpenBao stopped", async () => {
    const token = await issueFor(f, "env1a", { ttlSeconds: 600 });
    const runtime = await issueRuntimeFor(f, "env1a");
    f.setBao("closed");
    await f.setUpstreamClosed(true);
    try {
      // The control: a 30-day token's revocation needs OpenBao and does not answer 200.
      const control = await f.revoke("env1a", token.credentialId);
      expect(control.status).not.toBe(200);

      const answer = await f.revoke("env1a", runtime.credentialId);
      expect(answer.status, answer.code).toBe(200);
      expect(answer.body).toMatchObject({
        state: "succeeded",
        result: { credentialId: runtime.credentialId, state: "revoked" },
      });
      expect(await stateOf(runtime.credentialId)).toBe("revoked");
      const audit = await f.api.superuser.query<{ outcome: string; details: unknown }>(
        `SELECT outcome, details FROM audit.event
          WHERE operation_id = $1 AND action = 'credential.revoke'`,
        [answer.operationId],
      );
      expect(audit.rows).toEqual([
        { outcome: "success", details: { credentialId: runtime.credentialId } },
      ]);
    } finally {
      f.setBao("relay");
      await f.setUpstreamClosed(false);
    }
  });

  it("the same key again answers the same operation; a new request for a revoked credential is 409 state_conflict", async () => {
    const runtime = await issueRuntimeFor(f, "env1a");
    const key = randomUUID();
    const first = await f.revoke("env1a", runtime.credentialId, { key });
    expect(first.status, first.code).toBe(200);
    const again = await f.revoke("env1a", runtime.credentialId, { key });
    expect(again.status).toBe(200);
    expect(again.operationId).toBe(first.operationId);
    const next = await f.revoke("env1a", runtime.credentialId);
    expect(next.status).toBe(409);
    expect(next.code).toBe("state_conflict");
  });

  it("a runtime credential's id on another environment's path is 404, and it stays active", async () => {
    const runtime = await issueRuntimeFor(f, "env1a");
    const answer = await f.revoke("env1b", runtime.credentialId);
    expect(answer.status).toBe(404);
    expect(await stateOf(runtime.credentialId)).toBe("active");
  });

  it("OpenBao's accessor list of the namespace is the same before and after an issue and a revoke", async () => {
    const accessors = async (): Promise<string[]> =>
      [...(await f.admin.listAccessors(f.fx.namespace))].sort();
    const machine = async (): Promise<number> => (await machineAccessors(f, envId("env1a"))).length;
    const before = await accessors();
    const machineBefore = await machine();
    const runtime = await issueRuntimeFor(f, "env1a");
    expect((await accessors()).length).toBe(before.length);
    expect((await f.revoke("env1a", runtime.credentialId)).status).toBe(200);
    const after = await accessors();
    // Accessors are not secrets, but only counts and booleans are printed.
    expect(after.length).toBe(before.length);
    expect(after.every((accessor, index) => accessor === before[index])).toBe(true);
    expect(await machine()).toBe(machineBefore);
  });
});
