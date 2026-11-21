// Run 5.2 Task D (FR-1.39, FR-1.41, FR-1.42, FR-1.43, P-102): machine
// credentials on staging, through the public name as the staging owner, in a
// project of their own.
//
// 1. The journey: issue (300 s) → the inventory shows it → the replay answers
//    409 credential_not_replayable → revoke → the inventory says revoked. On
//    the host the token's bytes are searched (on fd 3, counts only) in the
//    API's log, a pg_dump and Traefik's access log: 0 each, with the controls
//    found.
// 2. The drill of an issuance left unknown is credential-drill.staging.test.ts
//    since Run 8.7, so that this journey's result stands on its own.
//
// Every credential this file issues is revoked in `finally` (they live 300 s
// in any case). The token never leaves this process except on stdin.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { countOnHost, loadHosts, registerSecret } from "../harness/staging.ts";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";

const host = loadHosts().staging;
/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";

let cookie: string;
let projectPath: string;
const environments: { id: string; path: string }[] = [];
const issued = new Map<string, string>(); // credentialId → environment path
const evidence: Record<string, unknown> = {};
const EVIDENCE = "docs/evidence/session-5/run-5.2-staging.json";
const record = (key: string, value: unknown): void => {
  evidence[key] = value;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
};
const now = (): string => new Date().toISOString();
const startedAt = new Date();

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;
const errorOf = (
  answer: PublicAnswer,
): { code?: string; operationId?: string; details?: unknown } => json(answer).error ?? {};

function send(
  method: string,
  path: string,
  body: unknown,
  key: string = randomUUID(),
): Promise<PublicAnswer> {
  return publicRequest(method, path, { body, cookie, headers: { "idempotency-key": key } });
}

/** Issues; a 201's token is registered for redaction at once and never printed. */
async function issue(
  path: string,
  ttlSeconds: number,
  key?: string,
): Promise<{ answer: PublicAnswer; credentialId?: string; token?: string }> {
  const answer = await send("POST", `${path}/credentials`, { name: "s5-machine", ttlSeconds }, key);
  if (answer.status !== 201) return { answer };
  const body = json(answer) as { credential: { credentialId: string }; token: string };
  registerSecret(body.token);
  issued.set(body.credential.credentialId, path);
  return { answer, credentialId: body.credential.credentialId, token: body.token };
}

async function inventory(path: string): Promise<{ credentialId: string; state: string }[]> {
  const listed = await publicRequest("GET", `${path}/credentials`, { cookie });
  expect(listed.status).toBe(200);
  return json(listed).credentials as { credentialId: string; state: string }[];
}

/** Revokes every credential of this file that is not revoked yet; answers how many it revoked. */
async function revokeAll(): Promise<number> {
  let revoked = 0;
  for (const [credentialId, path] of issued) {
    const answer = await send("POST", `${path}/credentials/${credentialId}/revoke`, {
      confirmed: true,
    });
    if (answer.status === 200) revoked += 1;
    if (answer.status === 200 || errorOf(answer).code === "state_conflict")
      issued.delete(credentialId);
  }
  return revoked;
}

async function waitUntil<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(value)}`);
    await sleep(5000);
  }
}

async function environmentActive(environmentId: string): Promise<void> {
  await waitUntil(
    "environment active",
    async () => {
      const listed = await publicRequest("GET", `${projectPath}/environments`, { cookie });
      const all = (json(listed).environments ?? []) as { id: string; state: string }[];
      return all.find((e) => e.id === environmentId)?.state;
    },
    (state) => state === "active",
    180_000,
  );
}

beforeAll(async () => {
  ({ cookie } = await stagingOwnerSession());
  const name = `s5-credentials-${randomBytes(3).toString("hex")}`;
  const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, { name });
  expect(created.status).toBe(201);
  const result = json(created).result as { projectId: string; developmentEnvironmentId: string };
  projectPath = `/v1/organizations/${ORGANIZATION}/projects/${result.projectId}`;
  const id = result.developmentEnvironmentId;
  await environmentActive(id);
  environments.push({ id, path: `${projectPath}/environments/${id}` });
  record("project", { name, id: result.projectId, environments: environments.map((e) => e.id) });
}, 420_000);

describe("machine credentials on staging", () => {
  it("issue → inventory → replay 409 → revoke → revoked; the token is in no log, dump or access log", async () => {
    const path = environments[0]!.path;
    try {
      const key = randomUUID();
      const first = await issue(path, 300, key);
      expect(first.answer.status, first.answer.body.slice(0, 200)).toBe(201);
      const credentialId = first.credentialId!;
      expect((await inventory(path)).find((c) => c.credentialId === credentialId)?.state).toBe(
        "active",
      );
      const replay = await send(
        "POST",
        `${path}/credentials`,
        { name: "s5-machine", ttlSeconds: 300 },
        key,
      );
      expect(replay.status).toBe(409);
      expect(errorOf(replay).code).toBe("credential_not_replayable");
      expect(errorOf(replay).details).toEqual({ credentialId, state: "active" });
      expect(replay.body.includes(first.token!)).toBe(false);
      const revoked = await send("POST", `${path}/credentials/${credentialId}/revoke`, {
        confirmed: true,
      });
      expect(revoked.status, revoked.body.slice(0, 200)).toBe(200);
      issued.delete(credentialId);
      expect((await inventory(path)).find((c) => c.credentialId === credentialId)?.state).toBe(
        "revoked",
      );
      record("journey", { credentialId, at: now() });

      // On the host: the token travels on stdin; only counts come back.
      const since = startedAt.toISOString();
      const token = [first.token!];
      const apiLog = await countOnHost(host, `docker logs --since ${since} mykey-api-1`, token, [
        "/credentials/:credential/revoke",
      ]);
      const dump = await countOnHost(
        host,
        `docker exec mykey-postgres-1 sh -c 'PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" pg_dump -U postgres -d postgres'`,
        token,
        [credentialId],
      );
      const access = await countOnHost(host, `docker logs --since ${since} mykey-edge-1`, token, [
        `/credentials/${credentialId}/revoke`,
      ]);
      record("search", { apiLog, dump, access });
      expect(apiLog.found).toBe(0);
      expect(dump.found).toBe(0);
      expect(access.found).toBe(0);
    } finally {
      await revokeAll();
    }
  }, 600_000);
});
