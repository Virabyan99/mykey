// Run 8.2 (P-151): what A's owner reads about A as a whole does not move when
// B grows. A's overview, credentials summary, metrics, activity and audit are
// read before and after B gains a project, a secret, a credential, an
// unresolved operation and five events; the bodies are equal but for the
// observation time, and none of them holds an id, a name or a request id of B.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolationFixture, type IsolationFixture } from "./fixture.ts";

let fx: IsolationFixture;

beforeAll(async () => {
  fx = await createIsolationFixture();
}, 900_000);

afterAll(async () => {
  await (fx as IsolationFixture | undefined)?.close();
});

const VIEWS = ["overview", "credentials/summary", "metrics", "activity", "audit"] as const;

/** The view's body with its observation time (also the end of metrics' window) and its page anchor taken out. */
async function view(name: (typeof VIEWS)[number]): Promise<string> {
  const a = fx.a;
  const answer = await a.request("GET", `/v1/organizations/${a.organizationId}/${name}`, {
    cookie: a.owner,
  });
  expect(answer.status, name).toBe(200);
  const body = (await answer.json()) as Record<string, unknown>;
  delete body.observedAt;
  delete body.anchor;
  // metrics: its window ends at the observation time.
  const window = body.window as Record<string, unknown> | undefined;
  if (window !== undefined) delete window.to;
  return JSON.stringify(body);
}

async function views(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of VIEWS) out[name] = await view(name);
  return out;
}

describe("A's aggregates do not see B", () => {
  it("A's overview, credentials summary, metrics, activity and audit bodies are equal, but for the observation time, before and after B gains a project, a secret, a credential, an unresolved operation and five events", async () => {
    const before = await views();
    const b = fx.b;
    const env = `/v1/organizations/${b.organizationId}/projects/${b.ids.projectId}/environments/${b.ids.environmentId}`;
    const requestIds: string[] = [];
    const names = {
      project: `Agg B ${randomUUID().slice(0, 6)}`,
      secret: `AGG_B_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
    };
    const send = async (method: string, path: string, body: unknown, idempotent = true) => {
      const answer = await b.request(method, path, {
        cookie: b.owner,
        headers: idempotent ? { "idempotency-key": randomUUID() } : {},
        body,
      });
      requestIds.push(answer.headers.get("x-request-id") ?? "");
      const text = await answer.text();
      expect(answer.status, `${method} ${path}: ${text.slice(0, 80)}`).toBeLessThan(300);
      return JSON.parse(text) as Record<string, unknown>;
    };
    const project = await send("POST", `/v1/organizations/${b.organizationId}/projects`, {
      name: names.project,
    });
    await send("POST", `${env}/secrets`, { name: names.secret, value: "synthetic" });
    await fx.freshen();
    const credential = await send("POST", `${env}/credentials`, { name: "agg-b" });
    // An unresolved operation of B, as an interrupted request leaves it.
    const unresolved = randomUUID();
    await fx.f.api.superuser.query(
      `INSERT INTO app.operation (id, organization_id, principal_kind, principal_id, action, target,
         idempotency_key, state)
       VALUES ($1::uuid, $2, 'system', 'test', 'environment.provision', $3, $1::text, 'uncertain')`,
      [unresolved, b.organizationId, b.ids.environmentId],
    );
    // Five events: five reveals of B's secret.
    for (let i = 0; i < 5; i += 1) {
      await send("POST", `${env}/secrets/${b.ids.secretName}/reveal`, {}, false);
    }
    const after = await views();
    for (const name of VIEWS) expect(after[name], name).toBe(before[name]);

    const ofB = [
      b.organizationId,
      b.ids.projectId,
      b.ids.environmentId,
      b.ids.secretName,
      b.ids.credentialId,
      b.ids.operationId,
      names.project,
      names.secret,
      unresolved,
      (project.result as { projectId?: string } | undefined)?.projectId ?? "-",
      (credential.credential as { credentialId?: string } | undefined)?.credentialId ?? "-",
      ...requestIds.filter((id) => id !== ""),
    ];
    const found: string[] = [];
    for (const name of VIEWS) {
      for (const value of ofB) if (after[name]?.includes(value) === true) found.push(name);
    }
    expect(found).toEqual([]);
  }, 600_000);
});
