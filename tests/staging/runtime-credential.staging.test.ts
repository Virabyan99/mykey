// Run 11.8 Task C Step 2 (spec §6 items 1, 2, 8; Review focus 4): the runtime
// credential on staging, through the public name and the real edge.
//
// The staging owner seeds 25 values in a project of its own and issues a
// runtime credential bound to this workstation as the edge sees it. It is
// exchanged; the token resolves the 25 values (their digests equal the owner's
// export), lists the names and reads the metadata. A credential bound to
// another network is refused from here, beside one that is served. After the
// revocation the exchange and the token already minted both answer 401, beside
// a credential that still works. Then ten servers of the one environment, each
// with its own credential, start twice through the CLI's own client.
//
// Last, every client secret and every exchanged token this file held is
// searched on the host (fd 3, counts only), each surface with a control.
//
// The caller's address is the owner's own: it is never printed, compared in a
// message or written down. Everything issued here is revoked and the project
// archived at the end.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@mykey/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countOnHost, loadHosts, nextMinute, registerSecret } from "../harness/staging.ts";
import {
  callerNetwork,
  exchangeRequest,
  exportedDigests,
  machineRequest,
  resolvedDigests,
} from "../harness/staging-machine.ts";
import {
  STAGING_ORIGIN,
  publicRequest,
  stagingOwnerSession,
  type PublicAnswer,
} from "../harness/staging-owner.ts";

const host = loadHosts().staging;
/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const ENVIRONMENT = "development";
const SEEDED = 25;
const FLEET = 10;
/** The spec's figure for a fleet's start, recorded against the measurement. */
const SPEC_MS = 20_000;
/** The worst case allowed for two rounds: every start waits out all the CLI's `busy` pauses. */
const FLEET_WITHIN_MS = 60_000;
/** The workstation's clock against the host's. */
const CLOCK_SLACK_MS = 5_000;
const EVIDENCE = "docs/evidence/session-11/staging-runtime-credential.json";

let cookie: string;
let projectId: string;
let environmentId: string;
let projectPath: string;
let environmentPath: string;
/** True once the project exists: the cleanup has something to close. */
let made = false;
/** This workstation as the edge reports it, as one network. Never printed. */
let caller: string;
const names: string[] = [];
const issued = new Set<string>();
/** Every client secret (whole, and its secret part) and exchanged token this file held. */
const held: string[] = [];
/** Request ids of exchanges that answered 200: what the API and OpenBao recorded them under. */
const exchangeRequests: string[] = [];
const startedAt = new Date();
const evidence: Record<string, unknown> = {
  note: "Names, ids, counts and times only. No address, token or secret is in this file.",
};
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

/** Issues a runtime credential. A failure names the status and the code only: a body could echo a network. */
async function issueRuntime(
  name: string,
  cidrs: string[],
): Promise<{ credentialId: string; clientSecret: string; ms: number }> {
  const began = performance.now();
  const answer = await send("POST", `${environmentPath}/runtime-credentials`, {
    name,
    ttlSeconds: 3600,
    cidrs,
  });
  const ms = performance.now() - began;
  expect([answer.status, codeOf(answer)], `issue ${name}`).toEqual([201, undefined]);
  expect(answer.headers.get("cache-control")).toBe("no-store");
  const body = json(answer) as {
    credential: { credentialId: string; kind: string };
    clientSecret: string;
  };
  registerSecret(body.clientSecret);
  const parts = body.clientSecret.split(".");
  expect(parts.length).toBe(3);
  expect(parts[0]).toBe("mkrc");
  expect(parts[1]).toBe(body.credential.credentialId);
  registerSecret(parts[2] ?? "");
  held.push(body.clientSecret, parts[2] ?? "");
  expect(body.credential.kind).toBe("runtime");
  issued.add(body.credential.credentialId);
  return { credentialId: body.credential.credentialId, clientSecret: body.clientSecret, ms };
}

/** An exchange that must answer 200: the token, registered and remembered for the search. */
async function exchange(
  clientSecret: string,
): Promise<{ token: string; expiresAt: string; answer: PublicAnswer; ms: number }> {
  const began = performance.now();
  const answer = await exchangeRequest(clientSecret);
  const ms = performance.now() - began;
  expect([answer.status, codeOf(answer)]).toEqual([200, undefined]);
  const body = json(answer) as { token: string; expiresAt: string };
  registerSecret(body.token);
  held.push(body.token);
  exchangeRequests.push(answer.headers.get("x-request-id") ?? "");
  return { token: body.token, expiresAt: body.expiresAt, answer, ms };
}

beforeAll(async () => {
  ({ cookie } = await stagingOwnerSession());
  caller = await callerNetwork(host);
  const name = `s11-runtime-${randomBytes(3).toString("hex")}`;
  const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, { name });
  expect(created.status).toBe(201);
  const result = json(created).result as { projectId: string; developmentEnvironmentId: string };
  projectId = result.projectId;
  environmentId = result.developmentEnvironmentId;
  projectPath = `/v1/organizations/${ORGANIZATION}/projects/${projectId}`;
  environmentPath = `${projectPath}/environments/${environmentId}`;
  made = true;
  const deadline = Date.now() + 180_000;
  for (;;) {
    const listed = await publicRequest("GET", `${projectPath}/environments`, { cookie });
    const all = (json(listed).environments ?? []) as { id: string; state: string }[];
    const own = all.find((environment) => environment.id === environmentId);
    if (own?.state === "active") break;
    if (Date.now() > deadline) throw new Error(`environment stayed ${String(own?.state)}`);
    await sleep(3000);
  }
  for (let index = 0; index < SEEDED; index += 1) {
    const secretName = `S11_RUNTIME_${String(index).padStart(2, "0")}`;
    const made = await send("POST", `${environmentPath}/secrets`, {
      name: secretName,
      value: `synthetic-${randomUUID()}`,
    });
    expect(made.status, secretName).toBe(201);
    names.push(secretName);
  }
  record("project", { name, id: projectId, environment: environmentId, seeded: SEEDED });
}, 600_000);

afterAll(async () => {
  if (!made) return;
  ({ cookie } = await stagingOwnerSession());
  for (const credentialId of issued) {
    const answer = await send("POST", `${environmentPath}/credentials/${credentialId}/revoke`, {
      confirmed: true,
    });
    if (answer.status === 200 || codeOf(answer) === "state_conflict") issued.delete(credentialId);
  }
  const archived = await send("POST", `${projectPath}/archive`, { confirmed: true });
  record("cleanup", { notRevoked: issued.size, archive: archived.status });
  expect(issued.size).toBe(0);
  expect([200, 409]).toContain(archived.status);
}, 300_000);

describe("the runtime credential on staging", () => {
  it("bound to the caller: exchange → 25 values equal the owner's export → keys → metadata; another network is refused; after the revocation the exchange and the minted token answer 401", async () => {
    ({ cookie } = await stagingOwnerSession());
    const own = await issueRuntime("s11-own", [caller]);
    const elsewhere = await issueRuntime("s11-elsewhere", ["192.0.2.0/24"]);
    const survivor = await issueRuntime("s11-survivor", [caller]);

    const first = await exchange(own.clientSecret);
    expect(first.answer.headers.get("cache-control")).toBe("no-store");
    const exchanged = json(first.answer) as { projectId: string; environmentName: string };
    expect(exchanged.projectId).toBe(projectId);
    expect(exchanged.environmentName).toBe(ENVIRONMENT);
    const left = Date.parse(first.expiresAt) - Date.now();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(900_000 + CLOCK_SLACK_MS);

    const resolveStarted = performance.now();
    const resolved = await machineRequest("resolve", projectId, ENVIRONMENT, first.token);
    const resolveMs = performance.now() - resolveStarted;
    expect([resolved.status, codeOf(resolved)]).toEqual([200, undefined]);
    expect(resolved.headers.get("cache-control")).toBe("no-store");
    const exported = await publicRequest("POST", `${environmentPath}/export`, {
      body: { confirmed: true },
      cookie,
    });
    expect(exported.status).toBe(200);
    expect(json(resolved).count).toBe(SEEDED);
    expect(resolvedDigests(resolved)).toEqual(exportedDigests(exported));

    const keys = await machineRequest("keys", projectId, ENVIRONMENT, first.token);
    expect([keys.status, codeOf(keys)]).toEqual([200, undefined]);
    expect(json(keys).names).toEqual([...names].sort());

    const metadataStarted = performance.now();
    const metadata = await machineRequest("metadata", projectId, ENVIRONMENT, first.token);
    const metadataMs = performance.now() - metadataStarted;
    expect([metadata.status, codeOf(metadata)]).toEqual([200, undefined]);
    const meta = json(metadata) as {
      environmentId: string;
      count: number;
      complete: boolean;
      entries: Record<string, unknown>[];
    };
    expect(meta.environmentId).toBe(environmentId);
    expect(meta.count).toBe(SEEDED);
    expect(meta.complete).toBe(true);
    expect(meta.entries.map((entry) => entry.name)).toEqual([...names].sort());
    for (const entry of meta.entries) {
      expect(Object.keys(entry).sort()).toEqual(["createdAt", "name", "updatedAt", "version"]);
      expect(entry.version).toBe(1);
    }

    // Review focus 4, through the real edge: a credential bound to another
    // network is refused from here; the one bound to this caller was served above.
    const refused = await exchangeRequest(elsewhere.clientSecret);
    expect([refused.status, codeOf(refused)]).toEqual([401, "unauthenticated"]);

    const revokeStarted = performance.now();
    const revoked = await send(
      "POST",
      `${environmentPath}/credentials/${own.credentialId}/revoke`,
      {
        confirmed: true,
      },
    );
    const revokeMs = performance.now() - revokeStarted;
    expect([revoked.status, codeOf(revoked)]).toEqual([200, undefined]);
    issued.delete(own.credentialId);
    const afterExchange = await exchangeRequest(own.clientSecret);
    expect([afterExchange.status, codeOf(afterExchange)]).toEqual([401, "unauthenticated"]);
    for (const route of ["resolve", "keys", "metadata"] as const) {
      const after = await machineRequest(route, projectId, ENVIRONMENT, first.token);
      expect([after.status, codeOf(after)], route).toEqual([401, "unauthenticated"]);
    }
    // The control: a credential that was not revoked still exchanges and reads.
    const alive = await exchange(survivor.clientSecret);
    const aliveKeys = await machineRequest("keys", projectId, ENVIRONMENT, alive.token);
    expect([aliveKeys.status, codeOf(aliveKeys)]).toEqual([200, undefined]);

    record("journey", {
      credentials: {
        own: own.credentialId,
        elsewhere: elsewhere.credentialId,
        survivor: survivor.credentialId,
      },
      boundTo: "the caller's address as the edge reports it, one address; not recorded",
      issueMs: Math.round(own.ms),
      exchangeMs: Math.round(first.ms),
      tokenSecondsLeftAtMost: Math.round(left / 1000),
      resolve25ValuesMs: Math.round(resolveMs),
      metadataMs: Math.round(metadataMs),
      revokeMs: Math.round(revokeMs),
      anotherNetwork: [refused.status, codeOf(refused)],
      afterRevoke: { exchange: afterExchange.status, mintedToken: 401, survivor: aliveKeys.status },
    });
  }, 600_000);

  it("the fleet: ten runtime credentials of the one environment, each exchanging and resolving twice through the CLI's own client, all start", async () => {
    const client = createClient(new URL(STAGING_ORIGIN));
    const secrets: string[] = [];
    // A person issues five credentials a minute (rl:issue): two windows for ten.
    for (let index = 0; index < FLEET; index += 1) {
      if (index % 5 === 0) {
        await nextMinute();
        ({ cookie } = await stagingOwnerSession());
      }
      secrets.push((await issueRuntime(`s11-fleet-${String(index)}`, [caller])).clientSecret);
    }
    const start = async (secret: string): Promise<{ ms: number; values: number }> => {
      const began = performance.now();
      const exchanged = await client.exchange(secret);
      registerSecret(exchanged.token);
      held.push(exchanged.token);
      const resolved = await client.resolve(
        { project: projectId, env: ENVIRONMENT },
        exchanged.token,
      );
      return { ms: performance.now() - began, values: resolved.entries.length };
    };

    // A whole window ahead: the fleet meets the limits as they are.
    await nextMinute();
    const began = performance.now();
    const first = await Promise.all(secrets.map((secret) => start(secret)));
    const firstMs = performance.now() - began;
    const second = await Promise.all(secrets.map((secret) => start(secret)));
    const total = performance.now() - began;

    for (const [round, starts] of [first, second].entries()) {
      expect(starts.length, `round ${String(round + 1)}`).toBe(FLEET);
      for (const one of starts) expect(one.values).toBe(SEEDED);
    }
    expect(total).toBeLessThan(FLEET_WITHIN_MS);
    const all = [...first, ...second].map((one) => one.ms);
    record("fleet", {
      servers: FLEET,
      firstRoundMs: Math.round(firstMs),
      twoRoundsMs: Math.round(total),
      slowestStartMs: Math.round(Math.max(...all)),
      firstRoundWithinSpec20s: firstMs < SPEC_MS,
    });
  }, 900_000);

  it("no client secret and no exchanged token is on a host surface; every surface shows a control", async () => {
    expect(held.length).toBeGreaterThan(0);
    expect(exchangeRequests.every((id) => id.length > 0)).toBe(true);
    const since = startedAt.toISOString();
    const credentialIds = [...issued].slice(0, 3);
    expect(credentialIds.length).toBe(3);
    const surfaces: [string, string, string[]][] = [
      [
        "API log",
        `docker logs --since ${since} mykey-api-1`,
        ["/v1/machine/exchange", ...exchangeRequests],
      ],
      [
        "provisioner log",
        `docker logs --since ${since} mykey-provisioner-1`,
        // The job that provisioned this file's environment (its log names operation ids only).
        ['"event":"job"'],
      ],
      [
        "pg_dump (database postgres)",
        `docker exec mykey-postgres-1 sh -c 'PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" pg_dump -U postgres -d postgres'`,
        credentialIds,
      ],
      [
        "OpenBao audit device",
        "docker exec mykey-openbao-1 cat /openbao/audit/audit.log",
        // Each exchange's token was made under the exchange's request id.
        [`auth/token/create/machine-env-${environmentId}`, ...exchangeRequests],
      ],
      ["Traefik access log", `docker logs --since ${since} mykey-edge-1`, ["/v1/machine/exchange"]],
    ];
    const found: Record<string, { searched: number; found: number; controls: string }> = {};
    let total = 0;
    for (const [surface, producer, controls] of surfaces) {
      const result = await countOnHost(host, producer, held, controls);
      total += result.found;
      found[surface] = {
        searched: held.length,
        found: result.found,
        controls: `${String(result.controls)} of ${String(controls.length)}`,
      };
    }
    record("search", found);
    expect(total).toBe(0);
  }, 1_800_000);
});
