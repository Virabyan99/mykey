// Run 5.4 Task D (FR-1.44, AC-1.19, P-102): machine access on staging through
// the public name. The staging owner seeds ten values in a project of its own,
// issues a credential (300 s), and the token resolves the environment: the
// value digests equal those of the owner's export; keys lists the names; after
// the revocation both answer 401. Then the token's bytes are searched on the
// host (fd 3, counts only) in the API's log, a pg_dump and Traefik's access
// log. Every credential issued here is revoked in `finally`.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { countOnHost, loadHosts, registerSecret } from "../harness/staging.ts";
import {
  accessorStatusesOnHost,
  exportedDigests,
  machineRequest,
  resolvedDigests,
} from "../harness/staging-machine.ts";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";

const host = loadHosts().staging;
/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const ENVIRONMENT = "development";

let cookie: string;
let projectId: string;
let environmentPath: string;
const issued = new Set<string>();
const evidence: Record<string, unknown> = {};
const EVIDENCE = "docs/evidence/session-5/run-5.4-staging-machine.json";
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};
const startedAt = new Date();

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

async function revokeAll(): Promise<void> {
  ({ cookie } = await stagingOwnerSession());
  for (const credentialId of issued) {
    const answer = await send("POST", `${environmentPath}/credentials/${credentialId}/revoke`, {
      confirmed: true,
    });
    if (answer.status === 200 || codeOf(answer) === "state_conflict") issued.delete(credentialId);
  }
}

beforeAll(async () => {
  ({ cookie } = await stagingOwnerSession());
  const name = `s5-machine-${randomBytes(3).toString("hex")}`;
  const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, { name });
  expect(created.status).toBe(201);
  const result = json(created).result as { projectId: string; developmentEnvironmentId: string };
  projectId = result.projectId;
  const projectPath = `/v1/organizations/${ORGANIZATION}/projects/${projectId}`;
  environmentPath = `${projectPath}/environments/${result.developmentEnvironmentId}`;
  const deadline = Date.now() + 180_000;
  for (;;) {
    const listed = await publicRequest("GET", `${projectPath}/environments`, { cookie });
    const all = (json(listed).environments ?? []) as { id: string; state: string; name: string }[];
    const own = all.find((environment) => environment.id === result.developmentEnvironmentId);
    expect(own?.name).toBe(ENVIRONMENT);
    if (own?.state === "active") break;
    if (Date.now() > deadline) throw new Error(`environment stayed ${String(own?.state)}`);
    await sleep(3000);
  }
  record("project", { name, id: projectId, environment: result.developmentEnvironmentId });
}, 300_000);

describe("machine access on staging", () => {
  it("ten values → issue (300 s) → resolve through the public name equals the owner's export → keys → revoke → both 401; the token is in no log, dump or access log", async () => {
    try {
      const names: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        const name = `S5_MACHINE_${String(index)}`;
        const made = await send("POST", `${environmentPath}/secrets`, {
          name,
          value: `synthetic-${randomUUID()}`,
        });
        expect(made.status, name).toBe(201);
        names.push(name);
      }

      ({ cookie } = await stagingOwnerSession());
      const issueStarted = performance.now();
      const issuedAnswer = await send("POST", `${environmentPath}/credentials`, {
        name: "s5-machine",
        ttlSeconds: 300,
      });
      const issueMs = performance.now() - issueStarted;
      expect(issuedAnswer.status, issuedAnswer.body.slice(0, 200)).toBe(201);
      const body = json(issuedAnswer) as { credential: { credentialId: string }; token: string };
      registerSecret(body.token);
      const token = body.token;
      const credentialId = body.credential.credentialId;
      issued.add(credentialId);

      const resolveStarted = performance.now();
      const resolved = await machineRequest("resolve", projectId, ENVIRONMENT, token);
      const resolveMs = performance.now() - resolveStarted;
      expect(resolved.status, codeOf(resolved) ?? "").toBe(200);
      expect(resolved.headers.get("cache-control")).toBe("no-store");
      expect(resolved.headers.get("content-encoding")).toBeNull();
      expect(Number(resolved.headers.get("content-length"))).toBe(resolved.bytes.length);
      const exported = await publicRequest("POST", `${environmentPath}/export`, {
        body: { confirmed: true },
        cookie,
      });
      expect(exported.status).toBe(200);
      expect(resolvedDigests(resolved)).toEqual(exportedDigests(exported));
      expect(json(resolved).count).toBe(10);

      const keys = await machineRequest("keys", projectId, ENVIRONMENT, token);
      expect(keys.status, codeOf(keys) ?? "").toBe(200);
      expect(json(keys).names).toEqual([...names].sort());

      const revoked = await send("POST", `${environmentPath}/credentials/${credentialId}/revoke`, {
        confirmed: true,
      });
      expect(revoked.status, revoked.body.slice(0, 200)).toBe(200);
      issued.delete(credentialId);
      for (const route of ["resolve", "keys"] as const) {
        const after = await machineRequest(route, projectId, ENVIRONMENT, token);
        expect([after.status, codeOf(after)], route).toEqual([401, "unauthenticated"]);
      }
      const onHost = await accessorStatusesOnHost(host, [credentialId]);
      expect(onHost).toEqual({ count: 1, statuses: [400] });
      record("journey", {
        credentialId,
        issueMs: Math.round(issueMs),
        resolveTenValuesMs: Math.round(resolveMs),
        afterRevoke: 401,
        accessorOnHost: onHost.statuses,
      });

      // On the host: the token travels on fd 3; only counts come back.
      const since = startedAt.toISOString();
      const apiLog = await countOnHost(
        host,
        `docker logs --since ${since} mykey-api-1`,
        [token],
        ["/v1/machine/projects/:project/environments/:envName/resolve"],
      );
      const dump = await countOnHost(
        host,
        `docker exec mykey-postgres-1 sh -c 'PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" pg_dump -U postgres -d postgres'`,
        [token],
        [credentialId],
      );
      const access = await countOnHost(
        host,
        `docker logs --since ${since} mykey-edge-1`,
        [token],
        [`/v1/machine/projects/${projectId}/environments/${ENVIRONMENT}/resolve`],
      );
      record("search", { apiLog, dump, access });
      expect(apiLog.found).toBe(0);
      expect(dump.found).toBe(0);
      expect(access.found).toBe(0);
    } finally {
      await revokeAll();
    }
  }, 600_000);
});
