// Run 8.2 (P-151, FR-1.13, AC-1.07): the second organization attacks with the
// first one's real ids. Every human route of ROUTES that names an id, asked
// by one owner with the other organization's ids, on either organization's
// API, answers exactly as it answers for ids nobody has: the same status,
// header names and body (but for the request id), and the same length.
import { randomUUID } from "node:crypto";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ask,
  differences,
  fill,
  humanRoutesWithIds,
  idsOf,
  randomIds,
  seen,
  type Seen,
} from "./answers.ts";
import { createIsolationFixture, type IsolationFixture, type Side } from "./fixture.ts";

let fx: IsolationFixture;

beforeAll(async () => {
  fx = await createIsolationFixture();
}, 900_000);

afterAll(async () => {
  await (fx as IsolationFixture | undefined)?.close();
});

const route = (id: string): RouteDef => {
  const found = ROUTES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no route ${id}`);
  return found;
};

describe("the other organization's ids answer as ids nobody has", () => {
  it("control: the comparison fails when one byte of a body differs", () => {
    const one: Seen = { status: 404, headers: ["content-type"], body: '{"a":1}', length: 7 };
    expect(differences(one, { ...one })).toEqual([]);
    expect(differences(one, { ...one, body: '{"a":2}' })).toEqual(["body"]);
    expect(differences(one, { ...one, status: 403 })).not.toEqual([]);
    expect(differences(one, { ...one, headers: ["content-type", "x-a"] })).not.toEqual([]);
  });

  it("every human route of ROUTES, asked by B's owner with A's ids and by A's owner with B's ids, answers exactly as for a random id: status, header names, body but for the request id, length", async () => {
    const routes = humanRoutesWithIds();
    expect(routes.length).toBeGreaterThanOrEqual(30);
    const found: string[] = [];
    let asked = 0;
    const cases: [string, Side, Side, Side][] = [
      // [label, asker, the API asked, the side whose ids are used]
      ["B's owner, A's ids, A's API", fx.b, fx.a, fx.a],
      ["B's owner, A's ids, B's API", fx.b, fx.b, fx.a],
      ["A's owner, B's ids, A's API", fx.a, fx.a, fx.b],
      ["A's owner, B's ids, B's API", fx.a, fx.b, fx.b],
    ];
    for (const [label, asker, api, target] of cases) {
      await fx.freshen();
      for (const r of routes) {
        const foreign = await seen(await ask(api, r, fill(r, idsOf(target)), asker.owner));
        const random = await seen(
          await ask(api, r, fill(r, randomIds(target.ids.environmentName)), asker.owner),
        );
        asked += 2;
        const diff = differences(foreign, random);
        if (diff.length > 0) {
          found.push(`${label}: ${r.id}: ${diff.join("; ")} (foreign ${String(foreign.status)})`);
        }
        // Hidden is never more than absent: a foreign id is never answered 2xx.
        expect(foreign.status, `${label}: ${r.id}`).toBeGreaterThanOrEqual(400);
      }
    }
    expect(asked).toBe(routes.length * 2 * cases.length);
    expect(found).toEqual([]);
  }, 600_000);

  it("an id of B of the right kind under A's own path — a credential, an operation, an import preview, a session — is the same 404", async () => {
    await fx.freshen();
    const a = fx.a;
    const own = idsOf(a);
    const found: string[] = [];
    const probes: [string, (value: string) => Promise<Response>, string][] = [
      [
        "credentials.revoke",
        (credential) =>
          ask(
            a,
            route("credentials.revoke"),
            fill(route("credentials.revoke"), { ...own, credential }),
            a.owner,
          ),
        fx.b.ids.credentialId,
      ],
      [
        "operations.get",
        (operation) =>
          ask(
            a,
            route("operations.get"),
            fill(route("operations.get"), { ...own, operation }),
            a.owner,
          ),
        fx.b.ids.operationId,
      ],
      [
        "import.resume",
        (operation) =>
          ask(
            a,
            route("import.resume"),
            fill(route("import.resume"), { ...own, operation }),
            a.owner,
          ),
        fx.b.ids.operationId,
      ],
      [
        "import.apply",
        (preview) =>
          ask(a, route("import.apply"), fill(route("import.apply"), { ...own, preview }), a.owner),
        fx.b.ids.previewId,
      ],
      [
        "secrets.history",
        (name) =>
          ask(
            a,
            route("secrets.history"),
            fill(route("secrets.history"), { ...own, name }),
            a.owner,
          ),
        fx.b.ids.secretName,
      ],
      [
        "auth sessions/revoke",
        (sessionId) =>
          a.request("POST", "/v1/auth/sessions/revoke", { cookie: a.owner, body: { sessionId } }),
        fx.b.ids.sessionId,
      ],
    ];
    for (const [label, probe, foreignValue] of probes) {
      const randomValue = label === "secrets.history" ? randomIds("x").name : randomUUID();
      const foreign = await seen(await probe(foreignValue));
      const random = await seen(await probe(randomValue));
      expect(foreign.status, label).toBe(404);
      const diff = differences(foreign, random);
      if (diff.length > 0) found.push(`${label}: ${diff.join("; ")}`);
    }
    expect(found).toEqual([]);
    // B's session still works: nothing above ended it.
    const still = await fx.b.request("GET", "/v1/auth/sessions", { cookie: fx.b.owner });
    expect(still.status).toBe(200);
    await still.arrayBuffer();
  }, 300_000);

  it("A's machine token on B's project path is the same 404 as on an absent project", async () => {
    const keys = route("machine.keys");
    const found: string[] = [];
    for (const api of [fx.a, fx.b]) {
      const askWith = (project: string) =>
        api.request("GET", fill(keys, { ...idsOf(fx.b), project }), {
          headers: { authorization: `Bearer ${fx.a.machineToken}` },
        });
      const foreign = await seen(await askWith(fx.b.ids.projectId));
      const absent = await seen(await askWith(randomUUID()));
      // A's API knows the token: 404. B's API serves B only and does not know it: 401 for both.
      expect(foreign.status, `${api.name}'s API`).toBe(api === fx.a ? 404 : 401);
      const diff = differences(foreign, absent);
      if (diff.length > 0) found.push(`${api.name}'s API: ${diff.join("; ")}`);
    }
    expect(found).toEqual([]);
    // Control: the token works on its own path.
    const ownKeys = await fx.a.request("GET", fill(keys, idsOf(fx.a)), {
      headers: { authorization: `Bearer ${fx.a.machineToken}` },
    });
    expect(ownKeys.status).toBe(200);
    await ownKeys.arrayBuffer();
  }, 300_000);
});
