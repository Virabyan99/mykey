// Run 5.4 Task D (FR-1.17, FR-1.18, AC-1.11, P-91, P-92): archive and
// reactivation on staging through the public name. A project of its own with
// two environments and a token each; the project archive closes both: on the
// public name both tokens are refused, and OpenBao on the host answers 400 to
// a lookup of both accessors (ids cross the command line, accessors stay on
// the host). Reactivation brings the project back; the old tokens stay
// refused and a new token resolves. Cleanup revokes what is left and archives
// the project.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { loadHosts, registerSecret } from "../harness/staging.ts";
import { accessorStatusesOnHost, machineRequest } from "../harness/staging-machine.ts";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";

const host = loadHosts().staging;
/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";

let cookie: string;
let projectId: string;
let projectPath: string;
let archived = false;
const environments: { id: string; name: string; path: string }[] = [];
const issued = new Map<string, string>(); // credentialId → environment path
const evidence: Record<string, unknown> = {};
const EVIDENCE = "docs/evidence/session-5/run-5.4-staging-archive.json";
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;
const codeOf = (answer: PublicAnswer): string | undefined =>
  (json(answer).error as { code?: string } | undefined)?.code;

function send(method: string, path: string, body: unknown): Promise<PublicAnswer> {
  return publicRequest(method, path, {
    body,
    cookie,
    headers: { "idempotency-key": randomUUID() },
  });
}

async function states(): Promise<Map<string, string>> {
  const listed = await publicRequest("GET", `${projectPath}/environments`, { cookie });
  expect(listed.status).toBe(200);
  const all = (json(listed).environments ?? []) as { id: string; state: string }[];
  return new Map(all.map((environment) => [environment.id, environment.state]));
}

async function waitStates(want: string, ids: string[], ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const now = await states();
    if (ids.every((id) => now.get(id) === want)) return;
    if (Date.now() > deadline) {
      throw new Error(`environments not ${want}: ${JSON.stringify([...now.values()])}`);
    }
    await sleep(3000);
  }
}

/** Issues; a 201's token is registered for redaction at once and never printed. */
async function issue(environment: {
  path: string;
}): Promise<{ credentialId: string; token: string }> {
  const answer = await send("POST", `${environment.path}/credentials`, {
    name: "s5-archive",
    ttlSeconds: 300,
  });
  expect(answer.status, answer.body.slice(0, 200)).toBe(201);
  const body = json(answer) as { credential: { credentialId: string }; token: string };
  registerSecret(body.token);
  issued.set(body.credential.credentialId, environment.path);
  return { credentialId: body.credential.credentialId, token: body.token };
}

async function cleanup(): Promise<void> {
  ({ cookie } = await stagingOwnerSession());
  if (!archived) {
    for (const [credentialId, path] of issued) {
      const answer = await send("POST", `${path}/credentials/${credentialId}/revoke`, {
        confirmed: true,
      });
      if (answer.status === 200 || codeOf(answer) === "state_conflict") issued.delete(credentialId);
    }
    const answer = await send("POST", `${projectPath}/archive`, { confirmed: true });
    expect([200, 409], answer.body.slice(0, 200)).toContain(answer.status);
    archived = true;
  }
}

beforeAll(async () => {
  ({ cookie } = await stagingOwnerSession());
  const name = `s5-archive-${randomBytes(3).toString("hex")}`;
  const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, { name });
  expect(created.status).toBe(201);
  const result = json(created).result as { projectId: string; developmentEnvironmentId: string };
  projectId = result.projectId;
  projectPath = `/v1/organizations/${ORGANIZATION}/projects/${projectId}`;
  const second = await send("POST", `${projectPath}/environments`, { name: "drill" });
  expect(second.status, second.body.slice(0, 200)).toBe(201);
  const secondId = (json(second).result as { environmentId: string }).environmentId;
  const pairs = [
    { id: result.developmentEnvironmentId, name: "development" },
    { id: secondId, name: "drill" },
  ];
  await waitStates(
    "active",
    pairs.map((pair) => pair.id),
    240_000,
  );
  for (const pair of pairs)
    environments.push({ ...pair, path: `${projectPath}/environments/${pair.id}` });
  record("project", { name, id: projectId, environments: pairs });
}, 420_000);

describe("archive and reactivation on staging", () => {
  it("two tokens → project archive → both refused on the public name and both accessors 400 on the host → reactivation → the old tokens stay refused, a new token resolves", async () => {
    try {
      const tokens = [];
      for (const environment of environments) tokens.push(await issue(environment));
      const ids = tokens.map((token) => token.credentialId).sort();
      for (const [index, token] of tokens.entries()) {
        const before = await machineRequest(
          "keys",
          projectId,
          environments[index]!.name,
          token.token,
        );
        expect(before.status, codeOf(before) ?? "").toBe(200);
      }
      // The control: OpenBao knows both accessors before the archive.
      expect(await accessorStatusesOnHost(host, ids)).toEqual({ count: 2, statuses: [200, 200] });

      ({ cookie } = await stagingOwnerSession());
      const archiveStarted = performance.now();
      const answer = await send("POST", `${projectPath}/archive`, { confirmed: true });
      expect(answer.status, answer.body.slice(0, 300)).toBe(200);
      const result = json(answer).result as {
        state: string;
        environments: number;
        credentialsRevoked: number;
      };
      expect(result.environments).toBe(2);
      if (result.state !== "archived") {
        await waitStates(
          "archived",
          environments.map((environment) => environment.id),
          180_000,
        );
      }
      const archiveMs = performance.now() - archiveStarted;
      archived = true;
      for (const id of ids) issued.delete(id);

      const refused: [number, string | undefined][] = [];
      for (const [index, token] of tokens.entries()) {
        for (const route of ["resolve", "keys"] as const) {
          const after = await machineRequest(
            route,
            projectId,
            environments[index]!.name,
            token.token,
          );
          refused.push([after.status, codeOf(after)]);
          expect([401, 403], `${route} ${String(index)}: ${codeOf(after) ?? ""}`).toContain(
            after.status,
          );
        }
      }
      const onHostArchived = await accessorStatusesOnHost(host, ids);
      expect(onHostArchived).toEqual({ count: 2, statuses: [400, 400] });

      const reactivated = await send("POST", `${projectPath}/reactivate`, { confirmed: true });
      expect(reactivated.status, reactivated.body.slice(0, 300)).toBe(200);
      expect(json(reactivated).result).toEqual({ state: "active", environments: 2 });
      archived = false;
      await waitStates(
        "active",
        environments.map((environment) => environment.id),
        30_000,
      );

      const refusedAfter: [number, string | undefined][] = [];
      for (const [index, token] of tokens.entries()) {
        const again = await machineRequest(
          "resolve",
          projectId,
          environments[index]!.name,
          token.token,
        );
        refusedAfter.push([again.status, codeOf(again)]);
        expect([again.status, codeOf(again)], String(index)).toEqual([401, "unauthenticated"]);
      }

      const fresh = await issue(environments[0]!);
      const resolved = await machineRequest(
        "resolve",
        projectId,
        environments[0]!.name,
        fresh.token,
      );
      expect(resolved.status, codeOf(resolved) ?? "").toBe(200);
      expect(json(resolved).count).toBe(0);

      record("journey", {
        credentials: ids,
        archive: { state: result.state, credentialsRevoked: result.credentialsRevoked },
        archiveMs: Math.round(archiveMs),
        refusedWhileArchived: refused,
        accessorsOnHostArchived: onHostArchived.statuses,
        refusedAfterReactivation: refusedAfter,
        freshCredential: fresh.credentialId,
        freshResolve: resolved.status,
      });
    } finally {
      await cleanup();
    }
  }, 900_000);
});
