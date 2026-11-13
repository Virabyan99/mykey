// Run 4.2 Task D: the first secret writes on staging, through the public name
// as the staging owner. A new project `s4-<8 hex>` (its `development`
// environment provisioned by the real provisioner) holds them; it stays, as
// projects cannot be deleted (ids in the run note). The create itself proves
// the API's inline AppRole login from its own address (D-34). Values are
// synthetic and never printed; the timing of fifty updates is the measurement
// of P-62 (no assertion yet).
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { expectSuccess, loadHosts, sshExec } from "../harness/staging.ts";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";

const host = loadHosts().staging;
/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const API = "mykey-api-1";

let cookie: string;
let environmentPath: string;
/** What the run note records (ids, timings; never a value): written to docs/evidence/session-4/. */
const evidence: Record<string, unknown> = {};
const EVIDENCE = "docs/evidence/session-4/run-4.2-staging.json";
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;
const codeOf = (answer: PublicAnswer): string | undefined =>
  (json(answer).error as { code?: string } | undefined)?.code;
const synthetic = (): string => `synthetic-${randomUUID()}`;

function send(method: string, path: string, body: unknown): Promise<PublicAnswer> {
  return publicRequest(method, path, {
    body,
    cookie,
    headers: { "idempotency-key": randomUUID() },
  });
}

beforeAll(async () => {
  ({ cookie } = await stagingOwnerSession());
  const name = `s4-${randomBytes(4).toString("hex")}`;
  const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, { name });
  expect(created.status).toBe(201);
  const result = (json(created).result ?? {}) as {
    projectId: string;
    developmentEnvironmentId: string;
  };
  environmentPath = `/v1/organizations/${ORGANIZATION}/projects/${result.projectId}/environments/${result.developmentEnvironmentId}`;
  record("project", { name, id: result.projectId, environmentId: result.developmentEnvironmentId });
  // The provisioner makes the environment active (Run 3.8).
  const deadline = Date.now() + 180_000;
  for (;;) {
    const listed = await publicRequest(
      "GET",
      `/v1/organizations/${ORGANIZATION}/projects/${result.projectId}/environments`,
      { cookie },
    );
    const environments = (json(listed).environments ?? []) as { id: string; state: string }[];
    const state = environments.find((e) => e.id === result.developmentEnvironmentId)?.state;
    if (state === "active") break;
    if (Date.now() > deadline) throw new Error(`environment stayed ${String(state)}`);
    await sleep(3000);
  }
}, 240_000);

describe("secrets on staging", () => {
  it("create and update through the public name; a stale tag is 409", async () => {
    const name = `S4_${randomBytes(4).toString("hex").toUpperCase()}`;
    const created = await send("POST", `${environmentPath}/secrets`, {
      name,
      value: synthetic(),
    });
    expect(created.status).toBe(201);
    const first = json(created).result as { version: number; stateTag: string };
    expect(first.version).toBe(1);

    const updated = await send("PATCH", `${environmentPath}/secrets/${name}`, {
      value: synthetic(),
      expectedVersion: first.version,
      expectedStateTag: first.stateTag,
    });
    expect(updated.status).toBe(200);
    expect((json(updated).result as { version: number }).version).toBe(2);

    const stale = await send("PATCH", `${environmentPath}/secrets/${name}`, {
      value: synthetic(),
      expectedVersion: 2,
      expectedStateTag: first.stateTag,
    });
    expect(stale.status).toBe(409);
    expect(codeOf(stale)).toBe("version_conflict");
  });

  it("the runtime credential works from the API's address: its self-check logged runtimeLogin ok", async () => {
    const logs = expectSuccess(
      await sshExec(host, `docker logs ${API} 2>&1 | grep '"selfcheck"' | tail -n 1`, {
        sudo: true,
        timeoutMs: 60_000,
      }),
      "docker logs",
    ).stdout;
    expect(logs).toContain('"runtimeLogin":"ok"');
  });

  it("fifty sequential updates (P-62 measurement)", async () => {
    const name = `S4_TIMING_${randomBytes(3).toString("hex").toUpperCase()}`;
    const created = await send("POST", `${environmentPath}/secrets`, {
      name,
      value: synthetic(),
    });
    expect(created.status).toBe(201);
    let current = json(created).result as { version: number; stateTag: string };
    const times: number[] = [];
    for (let round = 0; round < 50; round += 1) {
      const started = performance.now();
      const answer = await send("PATCH", `${environmentPath}/secrets/${name}`, {
        value: synthetic(),
        expectedVersion: current.version,
        expectedStateTag: current.stateTag,
      });
      times.push(performance.now() - started);
      expect(answer.status, `round ${String(round)}`).toBe(200);
      current = json(answer).result as { version: number; stateTag: string };
    }
    const sorted = [...times].sort((a, b) => a - b);
    const median = ((sorted[24] ?? 0) + (sorted[25] ?? 0)) / 2;
    record("fiftyUpdatesMs", {
      median: Math.round(median),
      slowest: Math.round(sorted[49] ?? 0),
      fastest: Math.round(sorted[0] ?? 0),
    });
    expect(current.version).toBe(51);
  }, 300_000);
});
