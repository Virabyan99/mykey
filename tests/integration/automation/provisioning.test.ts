// Run 11.5 Task C (Session 11, P-191 to P-194, D-82; spec §2.1 and §6 items
// 2, 3, 7): the ten automation routes, driven by the generic tenant
// provisioner (tests/fixtures/automation/tenant-provisioner.ts) against real
// PostgreSQL and OpenBao, with the real provisioner building each environment.
//
// The script holds the automation credential alone. What it makes is then
// read back two ways: by a server (exchange, then resolve) and by the owner
// through the human routes, who keeps every right.
//
// Secrets, client secrets and tokens are locals of the tests and never appear
// in an assertion message. Values are synthetic and compared by digest.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { AUTOMATION_RIGHTS } from "@mykey/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  provision,
  timings,
  type Provisioned,
  type ProvisionerApi,
} from "../../fixtures/automation/tenant-provisioner.ts";
import {
  automationCall,
  issueAutomationFor,
  revokeAutomation,
  type IssuedAutomation,
} from "../../harness/automation.ts";
import {
  createCredentialsFixture,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import {
  digestOf,
  exchangeCall,
  machineFetch,
  machinePath,
  resolveDigests,
} from "../../harness/machine.ts";
import { measure } from "../../harness/measure.ts";

const COUNT = 25;
const ENVIRONMENT = "production";

let f: CredentialsFixture;
let provisioner: { stop(): Promise<void> };
let api: ProvisionerApi;
/** Chain X: the script's credential, every right. */
let auto: IssuedAutomation;
/** Chain Y: another script's. */
let other: IssuedAutomation;
/** What the script made for its tenant. */
let made: Provisioned;
const secrets: Record<string, string> = {};
const tenant = `Tenant ${randomUUID().slice(0, 8)}`;
let started: Date;

const q = () => f.api.superuser;
const ids = () => ({ project: made.projectId, env: made.environmentId });
/** The owner's path of the environment the script made. */
const ownerPath = (): string =>
  `/v1/organizations/${f.tenants.a.organizationId}/projects/${made.projectId}/environments/${made.environmentId}`;

async function databaseNow(): Promise<Date> {
  return (await q().query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
}

/** The owner's reveal of one name, as a digest. */
async function ownerDigest(name: string): Promise<string> {
  await f.freshen();
  const answer = await f.send("POST", `${ownerPath()}/secrets/${name}/reveal`, {
    body: {},
    key: null,
  });
  expect(answer.status, `reveal: ${answer.code ?? ""}`).toBe(200);
  return digestOf(answer.body.value as string);
}

const freeSlot = (): Promise<unknown> =>
  q().query("DELETE FROM app.effect_slot WHERE scope_key = $1", [`env:${made.environmentId}`]);

beforeAll(async () => {
  f = await createCredentialsFixture();
  // The real job makes each new environment ready (D-32).
  provisioner = await f.fx.start();
  api = {
    baseUrl: `https://127.0.0.1:${String(f.api.port)}`,
    ca: readFileSync(f.stack.api.certAuthorityPath),
  };
  auto = await issueAutomationFor(f, { name: "x", rights: AUTOMATION_RIGHTS });
  other = await issueAutomationFor(f, { name: "y", rights: AUTOMATION_RIGHTS });
  for (let index = 0; index < COUNT; index += 1) {
    secrets[`TENANT_${String(index).padStart(2, "0")}`] = `synthetic-${randomUUID()}`;
  }
  started = await databaseNow();
  made = await provision(api, auto.secret, { tenant, secrets, environment: ENVIRONMENT });
}, 600_000);

afterAll(async () => {
  await (provisioner as { stop(): Promise<void> } | undefined)?.stop();
  await (f as CredentialsFixture | undefined)?.close();
});

afterEach(() => {
  f.setFaults(null);
  f.setBeforeHandler(null);
});

describe("the script, with the automation credential alone", () => {
  it("makes a project and an environment, waits until it is ready, writes 25 synthetic secrets and issues a runtime credential; the client secret then exchanges and resolves all 25 with the digests the script computed; each step is timed", async () => {
    const totals = timings(made.steps);
    expect(Object.keys(totals).sort()).toEqual(
      ["environment", "project", "ready", "runtime-credential", "secret"].sort(),
    );
    expect(totals.secret?.count).toBe(COUNT);
    for (const [step, total] of Object.entries(totals)) {
      expect(total.ms, step).toBeGreaterThan(0);
      measure(`automation_provision_${step.replace("-", "_")}_ms`, total.ms);
    }
    measure(
      "automation_provision_total_ms",
      made.steps.reduce((sum, step) => sum + step.ms, 0),
    );
    // One request per change: nothing was sent twice.
    for (const step of made.steps) {
      if (step.step !== "ready") expect(step.requests, step.step).toBe(1);
    }

    const exchanged = await exchangeCall(f, { secret: made.clientSecret });
    expect(exchanged.status, `exchange: ${exchanged.code ?? ""}`).toBe(200);
    const resolved = await machineFetch(
      { port: f.api.port, ca: readFileSync(f.stack.api.certAuthorityPath) },
      "POST",
      machinePath(made.projectId, ENVIRONMENT, "resolve"),
      { token: exchanged.body.token as string },
    );
    expect(resolved.status, `resolve: ${resolved.code ?? ""}`).toBe(200);
    expect(resolved.body.complete).toBe(true);
    expect(resolveDigests(resolved)).toEqual(
      Object.entries(secrets)
        .map(([name, value]): [string, string] => [name, digestOf(value)])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }, 120_000);

  it("the project is managed by the caller's chain and listed by automation.projects.list; a project made by the owner is not listed", async () => {
    const row = await q().query<{ managed_by: string | null }>(
      "SELECT managed_by FROM app.project WHERE id = $1",
      [made.projectId],
    );
    expect(row.rows[0]?.managed_by).toBe(auto.ownerId);
    const listed = await automationCall(f, "automation.projects.list", { secret: auto.secret });
    expect(listed.status, listed.code).toBe(200);
    const projects = listed.body.projects as { id: string; name: string; managedBy: string }[];
    expect(projects.map((project) => project.id)).toEqual([made.projectId]);
    expect(projects[0]).toMatchObject({ name: tenant, managedBy: auto.ownerId });
    expect(listed.body.nextCursor).toBeNull();
    // The other chain sees none of it.
    const theirs = await automationCall(f, "automation.projects.list", { secret: other.secret });
    expect(theirs.body.projects).toEqual([]);
    // The project, by id: its environments, and whether the store is ready.
    const got = await automationCall(f, "automation.projects.get", {
      secret: auto.secret,
      ids: ids(),
    });
    expect(got.status, got.code).toBe(200);
    expect(got.body).toMatchObject({ id: made.projectId, name: tenant, truncated: false });
    const environments = got.body.environments as { id: string; name: string; kvReady: boolean }[];
    expect(environments.map((environment) => environment.name).sort()).toEqual([
      "development",
      ENVIRONMENT,
    ]);
    expect(environments.find((one) => one.id === made.environmentId)?.kvReady).toBe(true);
  });

  it("the owner sees the project, its secrets and its credential in the human routes, with managedBy set and issuedByKind automation, and can reveal a value", async () => {
    const org = f.tenants.a.organizationId;
    const projects = await f.send("GET", `/v1/organizations/${org}/projects?limit=100`, {
      key: null,
    });
    expect(projects.status, projects.code).toBe(200);
    const mine = (projects.body.projects as { id: string; managedBy: string | null }[]).find(
      (project) => project.id === made.projectId,
    );
    expect(mine?.managedBy).toBe(auto.ownerId);
    const listed = await f.send("GET", `${ownerPath()}/secrets?limit=100`, { key: null });
    expect(listed.status, listed.code).toBe(200);
    expect((listed.body.secrets as { name: string }[]).map((row) => row.name)).toEqual(
      Object.keys(secrets).sort(),
    );
    const credentials = await f.send("GET", `${ownerPath()}/credentials`, { key: null });
    expect(credentials.status, credentials.code).toBe(200);
    const credential = (
      credentials.body.credentials as {
        credentialId: string;
        kind: string;
        issuedByKind: string;
        issuedBy: string;
      }[]
    ).find((row) => row.credentialId === made.credentialId);
    expect(credential).toMatchObject({
      kind: "runtime",
      issuedByKind: "automation",
      issuedBy: auto.credentialId,
    });
    expect(await ownerDigest("TENANT_00")).toBe(digestOf(secrets.TENANT_00!));
  });

  it("writing an existing name answers 409 already_exists, and the value, read by the owner, is unchanged", async () => {
    const before = await ownerDigest("TENANT_03");
    const answer = await automationCall(f, "automation.secrets.create", {
      secret: auto.secret,
      ids: ids(),
      body: { name: "TENANT_03", value: `synthetic-${randomUUID()}` },
    });
    expect([answer.status, answer.code]).toEqual([409, "already_exists"]);
    expect(await ownerDigest("TENANT_03")).toBe(before);
    expect(before).toBe(digestOf(secrets.TENANT_03!));
    const history = await f.send("GET", `${ownerPath()}/secrets/TENANT_03/history`, { key: null });
    expect(history.body.currentVersion).toBe(1);
  });

  it("automation.secrets.list returns name, state, version, createdAt and updatedAt for all 25 and no value", async () => {
    const listed = await automationCall(f, "automation.secrets.list", {
      secret: auto.secret,
      ids: ids(),
      query: "limit=100",
    });
    expect(listed.status, listed.code).toBe(200);
    const rows = listed.body.secrets as Record<string, unknown>[];
    expect(rows.map((row) => row.name)).toEqual(Object.keys(secrets).sort());
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["createdAt", "name", "state", "updatedAt", "version"].sort(),
      );
      expect(row).toMatchObject({ state: "live", version: 1 });
      expect(Number.isNaN(Date.parse(row.createdAt as string))).toBe(false);
      expect(Number.isNaN(Date.parse(row.updatedAt as string))).toBe(false);
    }
    // No value in the body; the control is the owner's reveal, which holds one.
    const found = Object.values(secrets).filter((value) => listed.text.includes(value)).length;
    expect(found).toBe(0);
    await f.freshen();
    const control = await f.send("POST", `${ownerPath()}/secrets/TENANT_00/reveal`, {
      body: {},
      key: null,
    });
    expect(JSON.stringify(control.body).includes(secrets.TENANT_00!)).toBe(true);
    // A prefix and a page, as the owner's list takes them.
    const paged = await automationCall(f, "automation.secrets.list", {
      secret: auto.secret,
      ids: ids(),
      query: "prefix=TENANT_0&limit=4",
    });
    expect((paged.body.secrets as unknown[]).length).toBe(4);
    const next = await automationCall(f, "automation.secrets.list", {
      secret: auto.secret,
      ids: ids(),
      query: `prefix=TENANT_0&limit=4&cursor=${encodeURIComponent(paged.body.nextCursor as string)}`,
    });
    expect((next.body.secrets as { name: string }[]).map((row) => row.name)).toEqual([
      "TENANT_04",
      "TENANT_05",
      "TENANT_06",
      "TENANT_07",
    ]);
  });

  it("the secret's history, read by the owner, names a machine actor with the credential's id", async () => {
    const history = await f.send("GET", `${ownerPath()}/secrets/TENANT_07/history`, { key: null });
    expect(history.status, history.code).toBe(200);
    const versions = history.body.versions as {
      version: number;
      written: { action: string; actor: { kind: string; id: string } };
    }[];
    expect(versions).toHaveLength(1);
    expect(versions[0]?.written).toMatchObject({
      action: "create",
      actor: { kind: "machine", id: auto.credentialId },
    });
  });
});

describe("operations", () => {
  it("automation.operations.get shows the caller's own operation, and answers 404 for the owner's operation and for another chain's", async () => {
    const mine = await automationCall(f, "automation.secrets.create", {
      secret: auto.secret,
      ids: ids(),
    });
    expect(mine.status, mine.code).toBe(201);
    const operationId = mine.body.operationId as string;
    const read = await automationCall(f, "automation.operations.get", {
      secret: auto.secret,
      ids: { operation: operationId },
    });
    expect(read.status, read.code).toBe(200);
    expect(read.body).toMatchObject({ operationId, state: "succeeded" });
    expect(read.text).not.toContain("synthetic");
    // A replacement is the same chain: it can settle what its predecessor began.
    const successor = await issueAutomationFor(f, {
      name: "x2",
      rights: AUTOMATION_RIGHTS,
      replaces: auto.credentialId,
    });
    const bySuccessor = await automationCall(f, "automation.operations.get", {
      secret: successor.secret,
      ids: { operation: operationId },
    });
    expect(bySuccessor.status).toBe(200);
    expect((await revokeAutomation(f, successor.credentialId)).status).toBe(200);

    const owners = await f.create("env1a", `OWNER_${randomUUID().slice(0, 8).toUpperCase()}`, "s");
    expect(owners.status).toBe(201);
    const theirs = await automationCall(f, "automation.projects.create", { secret: other.secret });
    expect(theirs.status, theirs.code).toBe(201);
    const absent = await automationCall(f, "automation.operations.get", {
      secret: auto.secret,
      ids: { operation: randomUUID() },
    });
    expect([absent.status, absent.code]).toEqual([404, "not_found"]);
    for (const hidden of [owners.body.operationId as string, theirs.body.operationId as string]) {
      const answer = await automationCall(f, "automation.operations.get", {
        secret: auto.secret,
        ids: { operation: hidden },
      });
      expect([answer.status, answer.code]).toEqual([404, "not_found"]);
    }
    // The control: its maker reads it.
    const control = await automationCall(f, "automation.operations.get", {
      secret: other.secret,
      ids: { operation: theirs.body.operationId as string },
    });
    expect(control.status).toBe(200);
  });

  it("the same key and body again replays the first answer; the same key with another body is 409 idempotency_conflict", async () => {
    const key = randomUUID();
    const body = { name: `REPLAY_${randomUUID().slice(0, 8).toUpperCase()}`, value: "synthetic" };
    const first = await automationCall(f, "automation.secrets.create", {
      secret: auto.secret,
      ids: ids(),
      body,
      key,
    });
    expect(first.status, first.code).toBe(201);
    const again = await automationCall(f, "automation.secrets.create", {
      secret: auto.secret,
      ids: ids(),
      body,
      key,
    });
    expect(again.status).toBe(201);
    expect(again.body.operationId).toBe(first.body.operationId);
    const changed = await automationCall(f, "automation.secrets.create", {
      secret: auto.secret,
      ids: ids(),
      body: { ...body, value: "synthetic-other" },
      key,
    });
    expect([changed.status, changed.code]).toEqual([409, "idempotency_conflict"]);
    // A project's creation replays too, and makes one project.
    const projectKey = randomUUID();
    const name = `Replay ${randomUUID().slice(0, 8)}`;
    const one = await automationCall(f, "automation.projects.create", {
      secret: auto.secret,
      body: { name },
      key: projectKey,
    });
    const two = await automationCall(f, "automation.projects.create", {
      secret: auto.secret,
      body: { name },
      key: projectKey,
    });
    expect([one.status, two.status]).toEqual([201, 201]);
    expect(two.body.operationId).toBe(one.body.operationId);
    const count = await q().query("SELECT 1 FROM app.project WHERE name = $1", [name]);
    expect(count.rowCount).toBe(1);
    // The same name under a new key: the contract's refusal, as for a person.
    const taken = await automationCall(f, "automation.projects.create", {
      secret: auto.secret,
      body: { name },
    });
    expect([taken.status, taken.code]).toEqual([409, "already_exists"]);
  });

  it("an answer lost after the change: 503 outcome_unknown with an operation id, the operation read later is not a failure, and nothing is sent again", async () => {
    const name = `LOST_${randomUUID().slice(0, 8).toUpperCase()}`;
    f.setFaults((at) => {
      if (at === "after_send") throw new Error("fault");
    });
    const answer = await automationCall(f, "automation.secrets.create", {
      secret: auto.secret,
      ids: ids(),
      body: { name, value: "synthetic" },
    });
    f.setFaults(null);
    try {
      expect([answer.status, answer.code]).toEqual([503, "outcome_unknown"]);
      const operationId = (answer.body.error as { operationId?: string }).operationId;
      expect(operationId).toBeDefined();
      const read = await automationCall(f, "automation.operations.get", {
        secret: auto.secret,
        ids: { operation: operationId! },
      });
      expect(read.status, read.code).toBe(200);
      // Rule 3: unfinished or uncertain, never rejected and never succeeded unproven.
      expect(["executing", "uncertain"]).toContain(read.body.state);
    } finally {
      await freeSlot();
    }
  });

  it("an answer lost after the change was finished: the script reads the operation and goes on, with one change and one read", async () => {
    let lost = false;
    f.setFaults((at) => {
      if (at === "after_finalize" && !lost) {
        lost = true;
        throw new Error("fault");
      }
    });
    const second = await provision(api, auto.secret, {
      tenant: `Tenant ${randomUUID().slice(0, 8)}`,
      secrets: { ONLY_ONE: "synthetic" },
    });
    f.setFaults(null);
    expect(lost).toBe(true);
    const step = second.steps.find((one) => one.step === "secret");
    // The change, then the operation: never the change again.
    expect(step?.requests).toBe(2);
    const rows = await q().query(
      "SELECT 1 FROM app.secret_index WHERE environment_id = $1 AND name = 'ONLY_ONE'",
      [second.environmentId],
    );
    expect(rows.rowCount).toBe(1);
  }, 180_000);
});

describe("runtime credentials by automation", () => {
  it("issue, list (kind runtime only, no secret), revoke; a 30-day token's id on the automation revoke route is 404", async () => {
    const issued = await automationCall(f, "automation.runtime_credentials.issue", {
      secret: auto.secret,
      ids: ids(),
      body: { name: "second server" },
    });
    expect(issued.status, issued.code).toBe(201);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const credential = issued.body.credential as { credentialId: string };
    expect(issued.body.credential).toMatchObject({
      kind: "runtime",
      issuedByKind: "automation",
      issuedBy: auto.credentialId,
      environmentId: made.environmentId,
    });
    const clientSecret = issued.body.clientSecret as string;
    expect(clientSecret.startsWith("mkrc.")).toBe(true);
    // The owner's 30-day token of the same environment.
    await f.freshen();
    const token = await f.send("POST", `${ownerPath()}/credentials`, {
      body: { name: "workstation" },
      key: randomUUID(),
    });
    expect(token.status, `issue: ${token.code ?? ""}`).toBe(201);
    const tokenId = (token.body.credential as { credentialId: string }).credentialId;

    const listed = await automationCall(f, "automation.runtime_credentials.list", {
      secret: auto.secret,
      ids: ids(),
    });
    expect(listed.status, listed.code).toBe(200);
    const rows = listed.body.credentials as { credentialId: string; kind: string }[];
    expect(rows.map((row) => row.kind)).toEqual(["runtime", "runtime"]);
    expect(rows.map((row) => row.credentialId).sort()).toEqual(
      [credential.credentialId, made.credentialId].sort(),
    );
    expect(listed.text.includes(clientSecret)).toBe(false);
    expect(listed.text.includes(made.clientSecret)).toBe(false);
    expect(listed.text).not.toContain("mkrc.");
    expect(listed.text).not.toContain("verifier");

    const wrong = await automationCall(f, "automation.runtime_credentials.revoke", {
      secret: auto.secret,
      ids: { ...ids(), credential: tokenId },
    });
    expect([wrong.status, wrong.code]).toEqual([404, "not_found"]);
    const tokenRow = await q().query<{ state: string }>(
      "SELECT state FROM app.machine_credential WHERE id = $1",
      [tokenId],
    );
    expect(tokenRow.rows[0]?.state).toBe("active");

    expect((await exchangeCall(f, { secret: clientSecret })).status).toBe(200);
    const revoked = await automationCall(f, "automation.runtime_credentials.revoke", {
      secret: auto.secret,
      ids: { ...ids(), credential: credential.credentialId },
    });
    expect(revoked.status, revoked.code).toBe(200);
    expect(revoked.body.result).toEqual({
      credentialId: credential.credentialId,
      state: "revoked",
    });
    expect((await exchangeCall(f, { secret: clientSecret })).status).toBe(401);
    // The control: the tenant's first credential still exchanges.
    expect((await exchangeCall(f, { secret: made.clientSecret })).status).toBe(200);
    // A replayed issuance never shows the client secret again.
    const key = randomUUID();
    const body = { name: "third server" };
    const first = await automationCall(f, "automation.runtime_credentials.issue", {
      secret: auto.secret,
      ids: ids(),
      body,
      key,
    });
    expect(first.status).toBe(201);
    const replay = await automationCall(f, "automation.runtime_credentials.issue", {
      secret: auto.secret,
      ids: ids(),
      body,
      key,
    });
    expect([replay.status, replay.code]).toEqual([409, "credential_not_replayable"]);
    expect(replay.text).not.toContain("mkrc.");
  });
});

describe("the check is made again inside the change (FR-1.10)", () => {
  it("a credential revoked after the pipeline looked changes nothing: 401, and no secret is written", async () => {
    const doomed = await issueAutomationFor(f, {
      name: "doomed",
      rights: AUTOMATION_RIGHTS,
      replaces: auto.credentialId,
    });
    const name = `LATE_${randomUUID().slice(0, 8).toUpperCase()}`;
    f.setBeforeHandler(async (routeId) => {
      if (routeId !== "automation.secrets.create") return;
      await q().query(
        "UPDATE app.automation_credential SET state = 'revoked', revoked_at = now() WHERE id = $1",
        [doomed.credentialId],
      );
    });
    const answer = await automationCall(f, "automation.secrets.create", {
      secret: doomed.secret,
      ids: ids(),
      body: { name, value: "synthetic" },
    });
    f.setBeforeHandler(null);
    expect([answer.status, answer.code]).toEqual([401, "unauthenticated"]);
    const rows = await q().query(
      "SELECT 1 FROM app.secret_index WHERE environment_id = $1 AND name = $2",
      [made.environmentId, name],
    );
    expect(rows.rowCount).toBe(0);
    // The control: the chain's live credential writes the same name.
    const control = await automationCall(f, "automation.secrets.create", {
      secret: auto.secret,
      ids: ids(),
      body: { name, value: "synthetic" },
    });
    expect(control.status, control.code).toBe(201);
  });

  it("a project the chain stopped managing after the pipeline looked: 404 from the environment, the project and the credential routes, and nothing is made", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["automation.environments.create", { name: `e${randomUUID().slice(0, 8)}` }],
      ["automation.secrets.create", { name: "UNMANAGED", value: "synthetic" }],
      ["automation.runtime_credentials.issue", { name: "unmanaged" }],
    ];
    const counts = async (): Promise<unknown> =>
      (
        await q().query(
          `SELECT (SELECT count(*) FROM app.environment WHERE project_id = $1) AS environments,
                  (SELECT count(*) FROM app.secret_index WHERE environment_id = $2) AS names,
                  (SELECT count(*) FROM app.machine_credential WHERE environment_id = $2) AS credentials`,
          [made.projectId, made.environmentId],
        )
      ).rows[0];
    const before = await counts();
    try {
      for (const [routeId, body] of cases) {
        f.setBeforeHandler(async (reached) => {
          if (reached !== routeId) return;
          await q().query("UPDATE app.project SET managed_by = NULL WHERE id = $1", [
            made.projectId,
          ]);
        });
        const answer = await automationCall(f, routeId, { secret: auto.secret, ids: ids(), body });
        f.setBeforeHandler(null);
        expect([answer.status, answer.code], routeId).toEqual([404, "not_found"]);
        await q().query("UPDATE app.project SET managed_by = $2 WHERE id = $1", [
          made.projectId,
          auto.ownerId,
        ]);
      }
      expect(await counts()).toEqual(before);
    } finally {
      f.setBeforeHandler(null);
      await q().query("UPDATE app.project SET managed_by = $2 WHERE id = $1", [
        made.projectId,
        auto.ownerId,
      ]);
    }
  });
});

describe("the record", () => {
  it("every audit row of the run has actor kind machine and the credential's id, and none holds a value or a secret", async () => {
    // Every operation the two scripts' credentials made, with its audit rows.
    const rows = await q().query<{ action: string; actor_kind: string; actor_id: string }>(
      `SELECT e.action, e.actor_kind, e.actor_id
         FROM audit.event e
         JOIN app.operation o ON o.id = e.operation_id
        WHERE o.principal_kind = 'machine' AND e.occurred_at >= $1`,
      [started],
    );
    const actions = new Set(rows.rows.map((row) => row.action));
    for (const action of [
      "project.create",
      "environment.create",
      "secret.create",
      "credential.issue",
      "credential.revoke",
    ]) {
      expect(actions.has(action), action).toBe(true);
    }
    const chain = await q().query<{ id: string }>("SELECT id FROM app.automation_credential");
    const known = new Set(chain.rows.map((row) => row.id));
    for (const row of rows.rows) {
      expect(row.actor_kind, row.action).toBe("machine");
      expect(known.has(row.actor_id), row.action).toBe(true);
    }
    // And no operation of a machine has a person's row.
    const machineOperations = await q().query(
      "SELECT 1 FROM app.operation WHERE principal_kind = 'machine' AND created_at >= $1",
      [started],
    );
    expect(machineOperations.rowCount).toBeGreaterThanOrEqual(COUNT + 3);

    // The three stores of text a row has: nothing of a value or of either secret.
    const needles = [
      ...Object.values(secrets),
      made.clientSecret,
      auto.secret,
      other.secret,
      auto.secret.split(".")[2]!,
      made.clientSecret.split(".")[2]!,
    ];
    const text = await q().query<{ found: string; control: string }>(
      `WITH rows AS (
         SELECT details::text AS t FROM audit.event WHERE occurred_at >= $1
         UNION ALL
         SELECT coalesce(result::text, '') FROM app.operation WHERE created_at >= $1
       )
       SELECT (SELECT count(*) FROM rows, unnest($2::text[]) n WHERE position(n IN t) > 0)::text AS found,
              (SELECT count(*) FROM rows WHERE position($3 IN t) > 0)::text AS control`,
      [started, needles, made.projectId],
    );
    expect(text.rows[0]?.found).toBe("0");
    // The control: the same search finds an id the run did write.
    expect(Number(text.rows[0]?.control)).toBeGreaterThan(0);
    // The API's log lines of the run.
    const lines = f.api.logs.map((line) => JSON.stringify(line)).join("\n");
    expect(needles.filter((needle) => lines.includes(needle)).length).toBe(0);
    expect(lines).not.toContain("mkac.");
    expect(lines).not.toContain("mkrc.");
    expect(lines.includes(made.projectId) || lines.length > 0).toBe(true);
  });
});
