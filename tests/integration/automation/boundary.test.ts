// Run 11.5 Task B (Session 11, P-191 to P-194, D-82; spec §6 items 4 and 5):
// the automation auth class, against real PostgreSQL. The harness's stub
// stands in for every automation handler, so this file tests the pipeline
// alone: who is recognised, what a credential's rights and its chain's
// projects let it reach, and that everything else is one 404.
//
// A secret is compared here by what the API answers to it; nothing prints one
// (Doc 10 §4.1 rule 2).
import { randomBytes, randomUUID } from "node:crypto";
import {
  AUTOMATION_RIGHTS,
  AUTOMATION_SECRET_PREFIX,
  type AutomationRight,
} from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUTOMATION_ROUTES,
  automationCall,
  automationDenials,
  automationPathOf,
  automationRoute,
  issueAutomationFor,
  revokeAutomation,
  strangerSecret,
  type AutomationIds,
  type IssuedAutomation,
} from "../../harness/automation.ts";
import {
  createCredentialsFixture,
  issueFor,
  issueRuntimeFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { exchangeCall, machineCall, type MachineAnswer } from "../../harness/machine.ts";

const ALL: readonly AutomationRight[] = AUTOMATION_RIGHTS;

let f: CredentialsFixture;
/** Chain X, every right; its chain manages project 1. */
let all: IssuedAutomation;
/** Chain Y, every right; its chain manages project 2. */
let other: IssuedAutomation;
/** A project the owner made: managed by no chain. */
let ownerProject: string;
/** Project 1 and its first environment: what chain X may reach. */
let own: Required<Pick<AutomationIds, "project" | "env">>;
/** Project 2 and its environment: chain Y's. */
let theirs: Required<Pick<AutomationIds, "project" | "env">>;

/** One more credential of chain X. */
const more = (body: Record<string, unknown> = {}): Promise<IssuedAutomation> =>
  issueAutomationFor(f, { rights: ALL, replaces: all.credentialId, ...body });

async function databaseNow(): Promise<Date> {
  const result = await f.api.superuser.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  return result.rows[0]!.now;
}

const manage = (projectId: string, ownerId: string | null): Promise<unknown> =>
  f.api.superuser.query("UPDATE app.project SET managed_by = $2 WHERE id = $1", [
    projectId,
    ownerId,
  ]);

/** The answer but for its request id: what two refusals must have in common. */
function shape(answer: MachineAnswer): unknown {
  const requestId = answer.headers.get("x-request-id") ?? "";
  expect(requestId).not.toBe("");
  return {
    status: answer.status,
    type: answer.headers.get("content-type"),
    text: answer.text.split(requestId).join("<request>"),
  };
}

beforeAll(async () => {
  f = await createCredentialsFixture({ stubRoutes: AUTOMATION_ROUTES.map((route) => route.id) });
  all = await issueAutomationFor(f, { name: "x", rights: ALL });
  other = await issueAutomationFor(f, { name: "y", rights: ALL });
  const one = f.env("env1a");
  const two = f.env("env2a");
  own = { project: one.projectId, env: one.environmentId };
  theirs = { project: two.projectId, env: two.environmentId };
  await manage(own.project, all.ownerId);
  await manage(theirs.project, other.ownerId);
  ownerProject = randomUUID();
  await f.api.superuser.query(
    "INSERT INTO app.project (id, organization_id, name, state) VALUES ($1, $2, $3, 'active')",
    [ownerProject, f.tenants.a.organizationId, `owner-${randomBytes(4).toString("hex")}`],
  );
}, 600_000);

afterAll(async () => {
  await f.close();
});

describe("who is recognised", () => {
  it("with its secret, from its networks: every route its rights allow reaches the handler's door, and the credential's last use is recorded", async () => {
    for (const route of AUTOMATION_ROUTES) {
      // An operation is named by an id only its maker knows (below).
      if (route.id === "automation.operations.get") continue;
      const before = f.api.reached.length;
      const answer = await automationCall(f, route.id, { secret: all.secret, ids: own });
      expect(answer.status, `${route.id}: ${answer.code ?? ""}`).toBe(204);
      expect(f.api.reached.slice(before), route.id).toEqual([route.id]);
    }
    const row = await f.api.superuser.query<{ last_used_at: Date | null }>(
      "SELECT last_used_at FROM app.automation_credential WHERE id = $1",
      [all.credentialId],
    );
    expect(row.rows[0]?.last_used_at).toBeInstanceOf(Date);
  });

  it("a secret nobody can attribute is 401 with no audit row: an id of nothing, another secret for a real id, and a row a writer of the database alone changed", async () => {
    const since = await databaseNow();
    const audited = async (): Promise<number> =>
      (
        await f.api.superuser.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit.event WHERE occurred_at >= $1",
          [since],
        )
      ).rows[0]!.n;
    const widened = await more({ rights: ["projects.create"] });
    const freed = await more();
    const moved = await more();
    // The control: each is recognised as issued.
    for (const credential of [widened, freed, moved]) {
      const answer = await automationCall(f, "automation.projects.list", {
        secret: credential.secret,
      });
      expect(answer.status, answer.code ?? "").toBe(204);
    }
    const issuedRows = await audited();
    await f.api.superuser.query(
      "UPDATE app.automation_credential SET rights = $2::text[] WHERE id = $1",
      [widened.credentialId, [...ALL]],
    );
    await f.api.superuser.query(
      "UPDATE app.automation_credential SET bound_cidrs = $2::text[] WHERE id = $1",
      [freed.credentialId, ["10.0.0.0/8", "127.0.0.0/8"]],
    );
    await f.api.superuser.query(
      "UPDATE app.automation_credential SET owner_id = $2 WHERE id = $1",
      [moved.credentialId, other.ownerId],
    );
    const real = all.secret.split(".");
    const presented: [string, string][] = [
      ["an id of nothing", strangerSecret(AUTOMATION_SECRET_PREFIX, randomBytes(32))],
      [
        "another secret for a real id",
        `${real[0]!}.${real[1]!}.${randomBytes(32).toString("base64url")}`,
      ],
      ["rights widened in the row", widened.secret],
      ["networks changed in the row", freed.secret],
      ["moved to another chain in the row", moved.secret],
    ];
    const logged = f.api.logs.length;
    for (const [label, secret] of presented) {
      const before = f.api.reached.length;
      for (const id of ["automation.projects.list", "automation.secrets.create"]) {
        const answer = await automationCall(f, id, { secret, ids: theirs });
        expect([answer.status, answer.code], `${label}, ${id}`).toEqual([401, "unauthenticated"]);
      }
      expect(f.api.reached.length, label).toBe(before);
    }
    expect(await audited()).toBe(issuedRows);
    const causes = f.api.logs
      .slice(logged)
      .filter((entry) => entry.event === "machine_unauthenticated")
      .map((entry) => (entry as { cause?: string }).cause);
    expect(causes).toEqual(Array.from({ length: 10 }, () => "catalog"));
    expect(JSON.stringify(f.api.logs.slice(logged))).not.toContain(`${AUTOMATION_SECRET_PREFIX}.`);
  });

  it("from outside the bound addresses: 401 before any backend is asked, and the row holds no address", async () => {
    const elsewhere = await more({ cidrs: ["192.0.2.0/24"] });
    f.setBao("closed");
    try {
      const since = await databaseNow();
      const before = f.api.reached.length;
      const refused = await automationCall(f, "automation.projects.get", {
        secret: elsewhere.secret,
        ids: own,
      });
      expect([refused.status, refused.code]).toEqual([401, "unauthenticated"]);
      expect(f.api.reached.length).toBe(before);
      expect(await automationDenials(f, elsewhere.credentialId, since)).toEqual([
        { routeId: "automation.projects.get", reason: "source", targetKind: "organization" },
      ]);
      const rows = await f.api.superuser.query<{ row: string }>(
        `SELECT row_to_json(e)::text AS row FROM audit.event e
          WHERE actor_id = $1 AND occurred_at >= $2`,
        [elsewhere.credentialId, since],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.row).not.toContain("127.0.0.1");
      // The control, with OpenBao still unreachable: from inside its networks it is served.
      const inside = await automationCall(f, "automation.projects.get", {
        secret: all.secret,
        ids: own,
      });
      expect(inside.status, inside.code ?? "").toBe(204);
    } finally {
      f.setBao("relay");
    }
  });

  it("expired, and revoked: 401 on the next request, with an access.denied row", async () => {
    const expired = await more();
    const revoked = await more();
    for (const credential of [expired, revoked]) {
      const served = await automationCall(f, "automation.secrets.list", {
        secret: credential.secret,
        ids: own,
      });
      expect(served.status, served.code ?? "").toBe(204);
    }
    await f.api.superuser.query(
      `UPDATE app.automation_credential
          SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [expired.credentialId],
    );
    const answer = await revokeAutomation(f, revoked.credentialId);
    expect(answer.status, answer.code ?? "").toBe(200);
    for (const credential of [expired, revoked]) {
      const since = await databaseNow();
      const before = f.api.reached.length;
      const refused = await automationCall(f, "automation.secrets.list", {
        secret: credential.secret,
        ids: own,
      });
      expect([refused.status, refused.code]).toEqual([401, "unauthenticated"]);
      expect(f.api.reached.length).toBe(before);
      expect(await automationDenials(f, credential.credentialId, since)).toEqual([
        { routeId: "automation.secrets.list", reason: "state", targetKind: "organization" },
      ]);
    }
  });

  it("the automation secret on a human route, a machine route and the exchange is 401; a session cookie beside it is 400 mixed_authentication; a session cookie alone on an automation route is 401", async () => {
    const cookie = await f.tenants.cookie("ownerA");
    const human = await machineCall(f, "keys", {
      path: "/v1/organizations",
      token: all.secret,
    });
    expect([human.status, human.code]).toEqual([401, "unauthenticated"]);
    const machine = await machineCall(f, "keys", { token: all.secret });
    expect([machine.status, machine.code]).toEqual([401, "unauthenticated"]);
    const exchange = await exchangeCall(f, { secret: all.secret });
    expect([exchange.status, exchange.code]).toEqual([401, "unauthenticated"]);

    const before = f.api.reached.length;
    for (const id of ["automation.projects.list", "automation.secrets.create"]) {
      const mixed = await automationCall(f, id, {
        secret: all.secret,
        ids: own,
        headers: { cookie },
      });
      expect([mixed.status, mixed.code], id).toEqual([400, "mixed_authentication"]);
      const session = await automationCall(f, id, { ids: own, headers: { cookie } });
      expect([session.status, session.code], id).toEqual([401, "unauthenticated"]);
      const nothing = await automationCall(f, id, { ids: own });
      expect([nothing.status, nothing.code], id).toEqual([401, "unauthenticated"]);
      const twice = await automationCall(f, id, {
        ids: own,
        headers: { authorization: [`Bearer ${all.secret}`, `Bearer ${all.secret}`] },
      });
      expect([twice.status, twice.code], id).toEqual([401, "unauthenticated"]);
    }
    // The other two kinds of bearer are nobody here.
    const runtime = await issueRuntimeFor(f, "env1a");
    const token = await issueFor(f, "env1a");
    for (const secret of [runtime.clientSecret, token.token]) {
      const answer = await automationCall(f, "automation.projects.list", { secret });
      expect([answer.status, answer.code]).toEqual([401, "unauthenticated"]);
    }
    expect(f.api.reached.length).toBe(before);
  });

  it("an anonymous caller learns nothing from a wrong body: 401; the credential gets 422 validation_failed, and precondition_required without an Idempotency-Key", async () => {
    // The types are right and the name is not a secret name: a 422, not the 400 of a wrong shape.
    const wrong = { name: "lower-case", value: "synthetic" };
    const anonymous = await automationCall(f, "automation.secrets.create", {
      ids: own,
      body: wrong,
    });
    expect([anonymous.status, anonymous.code]).toEqual([401, "unauthenticated"]);
    const before = f.api.reached.length;
    const invalid = await automationCall(f, "automation.secrets.create", {
      secret: all.secret,
      ids: own,
      body: wrong,
    });
    expect([invalid.status, invalid.code]).toEqual([422, "validation_failed"]);
    for (const key of [null, "not-a-key"]) {
      const answer = await automationCall(f, "automation.secrets.create", {
        secret: all.secret,
        ids: own,
        key,
      });
      expect([answer.status, answer.code], String(key)).toEqual([422, "precondition_required"]);
    }
    expect(f.api.reached.length).toBe(before);
  });
});

describe("least privilege (spec §6 item 4)", () => {
  it("for each automation route with a right: a credential without it gets 403 action_denied and an access.denied row; a credential with only it passes", async () => {
    const guarded = AUTOMATION_ROUTES.filter((route) => route.right !== "any");
    expect(guarded.map((route) => route.id)).toEqual([
      "automation.projects.create",
      "automation.environments.create",
      "automation.secrets.create",
      "automation.runtime_credentials.list",
      "automation.runtime_credentials.issue",
      "automation.runtime_credentials.revoke",
    ]);
    for (const right of ALL) {
      const without = await more({ name: "without", rights: ALL.filter((r) => r !== right) });
      const only = await more({ name: "only", rights: [right] });
      const routes = guarded.filter((route) => route.right === right);
      expect(routes.length, right).toBeGreaterThan(0);
      for (const route of routes) {
        const since = await databaseNow();
        const before = f.api.reached.length;
        const refused = await automationCall(f, route.id, { secret: without.secret, ids: own });
        expect([refused.status, refused.code], route.id).toEqual([403, "action_denied"]);
        expect(f.api.reached.length, route.id).toBe(before);
        expect(await automationDenials(f, without.credentialId, since), route.id).toEqual([
          {
            routeId: route.id,
            reason: "action",
            targetKind: route.path.includes(":env")
              ? "environment"
              : route.path.includes(":project")
                ? "project"
                : "organization",
          },
        ]);
        const passed = await automationCall(f, route.id, { secret: only.secret, ids: own });
        expect(passed.status, `${route.id}: ${passed.code ?? ""}`).toBe(204);
        expect(f.api.reached.at(-1)).toBe(route.id);
      }
      // What every credential may do, whatever its rights: read what its chain manages.
      for (const id of [
        "automation.projects.list",
        "automation.projects.get",
        "automation.secrets.list",
      ]) {
        expect(automationRoute(id).right).toBe("any");
        const passed = await automationCall(f, id, { secret: only.secret, ids: own });
        expect(passed.status, `${id}: ${passed.code ?? ""}`).toBe(204);
      }
    }
  });
});

describe("one 404 (spec §6 item 5, Review focus 5)", () => {
  it("a project of another chain, a project made by the owner, an absent UUID, a path that is not a UUID, and an environment of another project all answer 404 with one body, on a GET and on a mutation", async () => {
    const absent = randomUUID();
    const projects: [string, string][] = [
      ["a project of another chain", theirs.project],
      ["a project made by the owner", ownerProject],
      ["an absent UUID", absent],
      ["not a UUID", "not-an-id"],
      ["another organization's project", f.tenants.b.project1],
    ];
    const environments: [string, AutomationIds][] = [
      ...projects.map(([label, project]): [string, AutomationIds] => [
        label,
        { project, env: own.env },
      ]),
      ["another chain's project and environment", theirs],
      ["an environment of another project", { project: own.project, env: theirs.env }],
      ["an absent environment", { project: own.project, env: randomUUID() }],
      ["an environment that is not a UUID", { project: own.project, env: "not-an-id" }],
    ];
    const cases: [string, string, AutomationIds][] = [
      ...projects.flatMap(([label, project]): [string, string, AutomationIds][] => [
        ["automation.projects.get", label, { project }],
        ["automation.environments.create", label, { project }],
      ]),
      ...environments.flatMap(([label, ids]): [string, string, AutomationIds][] => [
        ["automation.secrets.list", label, ids],
        ["automation.secrets.create", label, ids],
        ["automation.runtime_credentials.revoke", label, ids],
      ]),
    ];
    const since = await databaseNow();
    const before = f.api.reached.length;
    const shapes = new Set<string>();
    for (const [id, label, ids] of cases) {
      const answer = await automationCall(f, id, { secret: all.secret, ids });
      expect([answer.status, answer.code], `${id}: ${label}`).toEqual([404, "not_found"]);
      shapes.add(JSON.stringify(shape(answer)));
    }
    expect(f.api.reached.length).toBe(before);
    expect([...shapes]).toHaveLength(1);
    const denials = await automationDenials(f, all.credentialId, since);
    expect(denials.map((row) => row.reason)).toEqual(cases.map(() => "hidden"));
    expect(denials.map((row) => row.routeId)).toEqual(cases.map(([id]) => id));
    // The control: its own project and environment are served.
    for (const id of ["automation.projects.get", "automation.secrets.create"]) {
      const answer = await automationCall(f, id, { secret: all.secret, ids: own });
      expect(answer.status, `${id}: ${answer.code ?? ""}`).toBe(204);
    }
  });

  it("an environment of another project its chain manages too is still 404 under the wrong project, and served under its own", async () => {
    await manage(theirs.project, all.ownerId);
    try {
      const crossed = await automationCall(f, "automation.secrets.list", {
        secret: all.secret,
        ids: { project: own.project, env: theirs.env },
      });
      expect([crossed.status, crossed.code]).toEqual([404, "not_found"]);
      const served = await automationCall(f, "automation.secrets.list", {
        secret: all.secret,
        ids: theirs,
      });
      expect(served.status, served.code ?? "").toBe(204);
      // And chain Y no longer reaches what it managed a moment ago.
      const lost = await automationCall(f, "automation.secrets.list", {
        secret: other.secret,
        ids: theirs,
      });
      expect([lost.status, lost.code]).toEqual([404, "not_found"]);
    } finally {
      await manage(theirs.project, other.ownerId);
    }
  });

  it("an operation that is not the caller's own — the owner's, an absent id, and an id that is not a UUID — is the same 404", async () => {
    const route = automationRoute("automation.operations.get");
    const shapes = new Set<string>();
    const before = f.api.reached.length;
    for (const operation of [all.operationId, other.operationId, randomUUID(), "not-an-id"]) {
      const answer = await automationCall(f, route.id, {
        secret: all.secret,
        path: automationPathOf(route, { operation }),
      });
      expect([answer.status, answer.code]).toEqual([404, "not_found"]);
      shapes.add(JSON.stringify(shape(answer)));
    }
    expect([...shapes]).toHaveLength(1);
    expect(f.api.reached.length).toBe(before);
  });
});

describe("states (P-53) answer after the path and the right", () => {
  it("an archived environment refuses a write with 409 state_conflict and an access.denied row, and is still listed", async () => {
    const setState = (state: string): Promise<unknown> =>
      f.api.superuser.query("UPDATE app.environment SET state = $2 WHERE id = $1", [
        own.env,
        state,
      ]);
    await setState("archived");
    try {
      const since = await databaseNow();
      const before = f.api.reached.length;
      const refused = await automationCall(f, "automation.secrets.create", {
        secret: all.secret,
        ids: own,
      });
      expect([refused.status, refused.code]).toEqual([409, "state_conflict"]);
      expect(f.api.reached.length).toBe(before);
      expect(await automationDenials(f, all.credentialId, since)).toEqual([
        { routeId: "automation.secrets.create", reason: "state", targetKind: "environment" },
      ]);
      const listed = await automationCall(f, "automation.secrets.list", {
        secret: all.secret,
        ids: own,
      });
      expect(listed.status, listed.code ?? "").toBe(204);
    } finally {
      await setState("active");
    }
  });
});
