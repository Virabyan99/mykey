// Run 5.3 Task C (P-92, FR-1.18, D-41): reactivation is database work and
// reads only. Before the transition it verifies the machine policy and token
// role against the stored digest, the names OpenBao lists against the index,
// and that every credential is revoked and each accessor answers 400. A
// failed verification changes nothing: 503 backend_inconsistent, the resource
// archived, the operation rejected. No token comes back. Tokens are compared
// by status codes only.
import { createHash, randomUUID } from "node:crypto";
import type { EnvironmentId, ProjectId } from "@mykey/contracts";
import { environmentPrefix, machineName, renderMachinePolicy } from "@mykey/openbao";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { baoAnswer } from "../../harness/bao-raw.ts";
import {
  createCredentialsFixture,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import {
  accessorAnswer,
  accessorsOf,
  archive,
  issueAt,
  newEnvironment,
  newProject,
  reactivate,
  resourceState,
  type Place,
} from "../../harness/lifecycle-fixture.ts";
import { readAuditLog } from "../../harness/stack.ts";

let f: CredentialsFixture;

beforeAll(async () => {
  f = await createCredentialsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

afterEach(() => {
  f.setFaults(null);
  f.relay.clear();
});

const credentialStates = async (environmentId: string): Promise<string[]> =>
  (
    await f.api.superuser.query<{ state: string }>(
      "SELECT state FROM app.machine_credential WHERE environment_id = $1 ORDER BY state",
      [environmentId],
    )
  ).rows.map((row) => row.state);

const operationByKey = async (key: string) =>
  (
    await f.api.superuser.query<{ state: string; error_code: string | null }>(
      "SELECT state, error_code FROM app.operation WHERE idempotency_key = $1",
      [key],
    )
  ).rows;

const digest = (value: unknown) => createHash("sha256").update(String(value)).digest("hex");

async function revealDigest(place: Place, name: string): Promise<string> {
  const answer = await f.send("POST", `${place.path}/secrets/${name}/reveal`, {
    body: {},
    key: null,
  });
  expect(answer.status, `reveal: ${answer.code ?? ""}`).toBe(200);
  return digest(answer.body.value);
}

async function secretIn(place: Place, name: string, value: string): Promise<void> {
  const made = await f.send("POST", `${place.path}/secrets`, { body: { name, value } });
  expect(made.status, `create: ${made.code ?? ""}`).toBe(201);
}

async function archived(place: Place, path = place.path): Promise<void> {
  const answer = await archive(f, path);
  expect(answer.status, `archive: ${answer.code ?? ""}`).toBe(200);
}

const root = (method: string, path: string, body?: unknown) =>
  baoAnswer(f.stack, f.stack.bao.rootToken, method, path, {
    namespace: f.fx.namespace,
    ...(body === undefined ? {} : { body }),
  });

/** An archived environment with two revoked credentials and one secret. */
async function archivedPlace(): Promise<{ place: Place; tokens: string[] }> {
  const place = await newProject(f);
  const tokens = [(await issueAt(f, place)).token, (await issueAt(f, place)).token];
  await secretIn(place, "KEPT", "synthetic-kept");
  await archived(place);
  return { place, tokens };
}

/** Each refusal of the verification: 503 backend_inconsistent, still archived, operation rejected. */
async function expectInconsistent(place: Place, path = place.path): Promise<void> {
  const key = randomUUID();
  const answer = await reactivate(f, path, { key });
  expect([answer.status, answer.code]).toEqual([503, "backend_inconsistent"]);
  expect((await resourceState(f, "environment", place.environmentId)).state).toBe("archived");
  expect(await operationByKey(key)).toEqual([
    { state: "rejected", error_code: "backend_inconsistent" },
  ]);
}

describe("environment reactivation", () => {
  it("200 active; no credential is active; the old token is still denied by OpenBao and by the catalog; a new issuance works; the values read by the owner have the digests they had before the archive", async () => {
    const place = await newProject(f);
    const tokens = [(await issueAt(f, place)).token, (await issueAt(f, place)).token];
    await secretIn(place, "KEPT", "synthetic-kept");
    const before = await revealDigest(place, "KEPT");
    await archived(place);

    const answer = await reactivate(f, place.path);
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(answer.body).toMatchObject({
      state: "succeeded",
      result: { state: "active", environments: 1 },
    });
    const state = await resourceState(f, "environment", place.environmentId);
    expect(state).toEqual({ state: "active", archive_origin: null, archive_operation_id: null });
    // The catalog: every credential of the archive stays revoked.
    expect(await credentialStates(place.environmentId)).toEqual(["revoked", "revoked"]);
    // OpenBao: the old tokens are gone.
    for (const token of tokens) {
      const self = await baoAnswer(f.stack, token, "GET", "auth/token/lookup-self", {
        namespace: f.fx.namespace,
      });
      expect(self.status).toBe(403);
    }
    for (const accessor of await accessorsOf(f, place.environmentId)) {
      expect(await accessorAnswer(f, accessor)).toBe(400);
    }
    expect(await revealDigest(place, "KEPT")).toBe(before);
    const fresh = await issueAt(f, place);
    expect(fresh.token.length).toBeGreaterThan(0);
    expect(await credentialStates(place.environmentId)).toEqual(["active", "revoked", "revoked"]);
  });

  it("replay → the same answer; an active environment → 409 state_conflict", async () => {
    const { place } = await archivedPlace();
    const key = randomUUID();
    const first = await reactivate(f, place.path, { key });
    expect(first.status, first.code ?? "").toBe(200);
    const again = await reactivate(f, place.path, { key });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const other = await reactivate(f, place.path);
    expect([other.status, other.code]).toEqual([409, "state_conflict"]);
  });

  it("reactivation sends nothing that changes OpenBao: the audit device between the request's start and end holds reads only", async () => {
    const { place } = await archivedPlace();
    const start = (await readAuditLog(f.stack)).length;
    const answer = await reactivate(f, place.path);
    expect(answer.status, answer.code ?? "").toBe(200);
    const seen = (await readAuditLog(f.stack))
      .slice(start)
      .filter(
        (entry) => entry.type === "request" && entry.namespacePath.startsWith(f.fx.namespace),
      );
    // The issuer's own session (login and revoke-self) and accessor lookups are not changes.
    const session = new Set([
      "auth/approle/login",
      "auth/token/revoke-self",
      "auth/token/lookup-accessor",
    ]);
    const changes = seen.filter(
      (entry) =>
        !session.has(entry.path) && entry.operation !== "read" && entry.operation !== "list",
    );
    expect(changes.map((entry) => `${entry.operation} ${entry.path}`)).toEqual([]);
    // Control: the verification did read the policy, the role, the names and the accessors.
    const name = machineName(place.environmentId as EnvironmentId);
    const paths = new Set(seen.map((entry) => entry.path));
    expect(paths.has(`sys/policies/acl/${name}`)).toBe(true);
    expect(paths.has(`auth/token/roles/${name}`)).toBe(true);
    expect(seen.some((entry) => entry.path.startsWith("kv/metadata/"))).toBe(true);
    expect(paths.has("auth/token/lookup-accessor")).toBe(true);
  });
});

describe("verification", () => {
  it("the machine policy rewritten by the root token → 503 backend_inconsistent; restored → 200", async () => {
    const { place } = await archivedPlace();
    const name = machineName(place.environmentId as EnvironmentId);
    const written = await root("PUT", `sys/policies/acl/${name}`, {
      policy: 'path "kv/data/elsewhere/*" { capabilities = ["read"] }',
    });
    expect(written.status).toBe(204);
    await expectInconsistent(place);
    const restored = await root("PUT", `sys/policies/acl/${name}`, {
      policy: renderMachinePolicy(
        place.projectId as ProjectId,
        place.environmentId as EnvironmentId,
      ),
    });
    expect(restored.status).toBe(204);
    expect((await reactivate(f, place.path)).status).toBe(200);
  });

  it("a name written straight into OpenBao → 503 backend_inconsistent; removed → 200", async () => {
    const { place } = await archivedPlace();
    const prefix = environmentPrefix(
      place.projectId as ProjectId,
      place.environmentId as EnvironmentId,
    );
    const written = await root("POST", `kv/data/${prefix}STRAY`, {
      options: { cas: 0 },
      data: { value: "synthetic", operation_id: randomUUID(), format: 1 },
    });
    expect(written.status).toBe(200);
    await expectInconsistent(place);
    const removed = await root("DELETE", `kv/metadata/${prefix}STRAY`);
    expect(removed.status).toBe(204);
    expect((await reactivate(f, place.path)).status).toBe(200);
  });

  it("a revoked row whose accessor still answers 200 → 503 backend_inconsistent; the token gone → 200", async () => {
    const { place } = await archivedPlace();
    const name = machineName(place.environmentId as EnvironmentId);
    const made = await root("POST", `auth/token/create/${name}`, { ttl: "10m" });
    expect(made.status).toBe(200);
    const live = (made.body as { auth: { accessor: string } }).auth.accessor;
    const rows = await f.api.superuser.query(
      `UPDATE app.machine_credential SET accessor = $2
        WHERE id = (SELECT id FROM app.machine_credential WHERE environment_id = $1 LIMIT 1)`,
      [place.environmentId, live],
    );
    expect(rows.rowCount).toBe(1);
    await expectInconsistent(place);
    const gone = await root("POST", "auth/token/revoke-accessor", { accessor: live });
    expect(gone.status).toBe(204);
    expect((await reactivate(f, place.path)).status).toBe(200);
  });
});

describe("project reactivation", () => {
  it("its project-origin children are active again; the one archived on its own stays archived; neither can be reactivated alone while the project is archived", async () => {
    const own = await newProject(f);
    const child = await newEnvironment(f, own);
    await issueAt(f, child);
    await archived(own);
    await archived(own, own.projectPath);
    expect((await resourceState(f, "environment", child.environmentId)).archive_origin).toBe(
      "project",
    );

    // An environment under an archived project → 409; one with origin project → 409.
    for (const place of [own, child]) {
      const alone = await reactivate(f, place.path);
      expect([alone.status, alone.code]).toEqual([409, "state_conflict"]);
    }

    const answer = await reactivate(f, own.projectPath);
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(answer.body).toMatchObject({
      state: "succeeded",
      result: { state: "active", environments: 1 },
    });
    expect((await resourceState(f, "project", own.projectId)).state).toBe("active");
    expect((await resourceState(f, "environment", child.environmentId)).state).toBe("active");
    expect((await resourceState(f, "environment", own.environmentId)).state).toBe("archived");
    expect(await credentialStates(child.environmentId)).toEqual(["revoked"]);

    // The one archived on its own comes back by its own reactivation.
    const alone = await reactivate(f, own.path);
    expect(alone.status, alone.code ?? "").toBe(200);
  });

  it("a child that fails verification keeps the whole project archived", async () => {
    const place = await newProject(f);
    await secretIn(place, "KEPT", "synthetic-kept");
    await archived(place, place.projectPath);
    const prefix = environmentPrefix(
      place.projectId as ProjectId,
      place.environmentId as EnvironmentId,
    );
    const written = await root("POST", `kv/data/${prefix}STRAY`, {
      options: { cas: 0 },
      data: { value: "synthetic", operation_id: randomUUID(), format: 1 },
    });
    expect(written.status).toBe(200);
    const key = randomUUID();
    const answer = await reactivate(f, place.projectPath, { key });
    expect([answer.status, answer.code]).toEqual([503, "backend_inconsistent"]);
    expect((await resourceState(f, "project", place.projectId)).state).toBe("archived");
    expect((await resourceState(f, "environment", place.environmentId)).state).toBe("archived");
    expect(await operationByKey(key)).toEqual([
      { state: "rejected", error_code: "backend_inconsistent" },
    ]);
  });
});
