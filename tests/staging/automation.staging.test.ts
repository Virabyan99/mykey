// Run 11.8 Task C Step 2 (spec §6 items 2 to 6): the automation credential on
// staging, through the public name and the real edge.
//
// The staging owner issues an automation credential bound to this workstation
// as the edge sees it. The generic script (tests/fixtures/automation/
// tenant-provisioner.ts, the HTTP contract alone) provisions one tenant: a
// project, an environment, 25 secrets and a runtime credential. A server
// started by the CLI from that credential gets the 25 values (their digests
// equal the owner's export). Then the boundary, each denial beside its
// control: another network, a project of nobody's chain, a missing right, no
// value anywhere, and a revoked credential. The owner revokes the server's
// runtime credential and the script's `reissue` brings the server back.
//
// Last, every automation secret and client secret this file held is searched
// on the host (fd 3, counts only), each surface with a control.
//
// The caller's address is the owner's own: it is never printed, compared in a
// message or written down. Everything issued here is revoked and both
// projects archived at the end.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { AUTOMATION_RIGHTS } from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  provision,
  reissue,
  timings,
  type ProvisionerApi,
} from "../fixtures/automation/tenant-provisioner.ts";
import { releasedCliDist, runCliInLinux } from "../harness/cli-linux.ts";
import { countOnHost, loadHosts, registerSecret } from "../harness/staging.ts";
import { callerNetwork, exchangeRequest, exportedDigests } from "../harness/staging-machine.ts";
import {
  STAGING_ORIGIN,
  publicRequest,
  stagingOwnerSession,
  type PublicAnswer,
} from "../harness/staging-owner.ts";

const host = loadHosts().staging;
/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const ORG = `/v1/organizations/${ORGANIZATION}`;
const TENANT_ENVIRONMENT = "production";
const SEEDED = 25;
const PREFIX = "S11_TENANT_";
const EVIDENCE = "docs/evidence/session-11/staging-automation.json";
const api: ProvisionerApi = { baseUrl: STAGING_ORIGIN };

let cookie: string;
/** This workstation as the edge reports it, as one network. Never printed. */
let caller: string;
/** Automation credentials to revoke at the end. */
const automationIssued = new Set<string>();
/** Runtime credentials to revoke at the end: [project, environment, credential]. */
const runtimeIssued: [string, string, string][] = [];
/** Projects to archive at the end. */
const projects = new Set<string>();
/** Every automation secret and client secret (whole, and its secret part) this file held. */
const held: string[] = [];
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
const outcome = (answer: PublicAnswer): [number, string | undefined] => [
  answer.status,
  codeOf(answer),
];

function send(method: string, path: string, body: unknown): Promise<PublicAnswer> {
  return publicRequest(method, path, {
    body,
    cookie,
    headers: { "idempotency-key": randomUUID() },
  });
}

/** A request with an automation secret as its bearer, and nothing else (no cookie). */
function automation(
  secret: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<PublicAnswer> {
  return publicRequest(method, path, {
    ...(body === undefined ? {} : { body }),
    headers: {
      authorization: `Bearer ${secret}`,
      ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}),
    },
  });
}

const hold = (secret: string): void => {
  registerSecret(secret);
  const part = secret.split(".")[2] ?? "";
  registerSecret(part);
  held.push(secret, part);
};

/** Issues an automation credential. A failure names the status and the code only: a body could echo a network. */
async function issueAutomation(body: {
  name: string;
  rights: readonly string[];
  cidrs: string[];
  replaces?: string;
}): Promise<{ credentialId: string; ownerId: string; secret: string; ms: number }> {
  const began = performance.now();
  const answer = await send("POST", `${ORG}/automation-credentials`, { ...body, ttlSeconds: 3600 });
  const ms = performance.now() - began;
  expect(outcome(answer), `issue ${body.name}`).toEqual([201, undefined]);
  const issued = json(answer) as {
    credential: { credentialId: string; ownerId: string };
    secret: string;
  };
  // Remembered before anything else is asserted: a failed assertion below must not leave it unrevoked.
  automationIssued.add(issued.credential.credentialId);
  hold(issued.secret);
  expect(answer.headers.get("cache-control")).toBe("no-store");
  const parts = issued.secret.split(".");
  expect(parts.length).toBe(3);
  expect(parts[0]).toBe("mkac");
  expect(parts[1]).toBe(issued.credential.credentialId);
  return {
    credentialId: issued.credential.credentialId,
    ownerId: issued.credential.ownerId,
    secret: issued.secret,
    ms,
  };
}

// Prints {name: sha256(value)} for the tenant's names: what the server was given.
const CHILD = [
  'const { createHash } = require("node:crypto");',
  "const out = {};",
  "for (const [name, value] of Object.entries(process.env)) {",
  `  if (name.startsWith("${PREFIX}")) out[name] = createHash("sha256").update(value, "utf8").digest("hex");`,
  "}",
  'out.__secrets = Object.keys(process.env).filter((name) => name.startsWith("SECRETS_")).length;',
  "console.log(JSON.stringify(out));",
].join("\n");

/** One start of the tenant's server by the CLI, from a runtime credential's client secret. */
function startServer(projectId: string, clientSecret: string) {
  return runCliInLinux(["run", "--", "node", "-e", CHILD], {
    env: {
      SECRETS_API_URL: STAGING_ORIGIN,
      SECRETS_MACHINE_TOKEN: clientSecret,
      SECRETS_PROJECT: projectId,
      SECRETS_ENVIRONMENT: TENANT_ENVIRONMENT,
    },
  });
}

async function ownerExport(projectId: string, environmentId: string) {
  const exported = await publicRequest(
    "POST",
    `${ORG}/projects/${projectId}/environments/${environmentId}/export`,
    { body: { confirmed: true }, cookie },
  );
  expect(exported.status).toBe(200);
  return Object.fromEntries(exportedDigests(exported));
}

beforeAll(async () => {
  // This file proves the tree's CLI: a published bundle named for another file's run must not be it.
  expect(releasedCliDist(), "MYKEY_CLI_DIST is set").toBeUndefined();
  const built = spawnSync(process.execPath, ["apps/cli/build.ts"], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
  const said = await runCliInLinux(["--version"]);
  expect(said.code, said.stderr).toBe(0);
  record("cli", { version: said.stdout.split(" ")[1] ?? "" });
  ({ cookie } = await stagingOwnerSession());
  caller = await callerNetwork(host);
}, 300_000);

afterAll(async () => {
  ({ cookie } = await stagingOwnerSession());
  for (const credentialId of automationIssued) {
    const answer = await send("POST", `${ORG}/automation-credentials/${credentialId}/revoke`, {
      confirmed: true,
    });
    if (answer.status === 200 || codeOf(answer) === "state_conflict")
      automationIssued.delete(credentialId);
  }
  let runtimeLeft = 0;
  for (const [projectId, environmentId, credentialId] of runtimeIssued) {
    const answer = await send(
      "POST",
      `${ORG}/projects/${projectId}/environments/${environmentId}/credentials/${credentialId}/revoke`,
      { confirmed: true },
    );
    if (answer.status !== 200 && codeOf(answer) !== "state_conflict") runtimeLeft += 1;
  }
  const archives: number[] = [];
  for (const projectId of projects) {
    archives.push(
      (await send("POST", `${ORG}/projects/${projectId}/archive`, { confirmed: true })).status,
    );
  }
  record("cleanup", { automationNotRevoked: automationIssued.size, runtimeLeft, archives });
  expect(automationIssued.size).toBe(0);
  expect(runtimeLeft).toBe(0);
  for (const status of archives) expect([200, 409]).toContain(status);
}, 300_000);

describe("the automation credential on staging", () => {
  it("one tenant provisioned by the script; its server starts with the 25 values; the boundary's five denials beside their controls; a revoked server comes back by reissue", async () => {
    ({ cookie } = await stagingOwnerSession());
    const auto = await issueAutomation({
      name: "s11-provisioner",
      rights: AUTOMATION_RIGHTS,
      cidrs: [caller],
    });
    expect(auto.ownerId).toBe(auto.credentialId);

    // ---- the script provisions one tenant
    const tenant = `s11-tenant-${randomBytes(3).toString("hex")}`;
    const values: Record<string, string> = {};
    for (let index = 0; index < SEEDED; index += 1) {
      values[`${PREFIX}${String(index).padStart(2, "0")}`] = `synthetic-${randomUUID()}`;
    }
    const provisionStarted = performance.now();
    const made = await provision(api, auto.secret, {
      tenant,
      secrets: values,
      environment: TENANT_ENVIRONMENT,
      cidrs: [caller],
    }).catch(async (error: unknown) => {
      // A script that stopped half way has made a project already: the end archives it.
      const left = await automation(auto.secret, "GET", "/v1/automation/projects");
      if (left.status === 200)
        for (const project of json(left).projects as { id: string }[]) projects.add(project.id);
      throw error;
    });
    const provisionMs = performance.now() - provisionStarted;
    hold(made.clientSecret);
    projects.add(made.projectId);
    runtimeIssued.push([made.projectId, made.environmentId, made.credentialId]);
    const scope = `/v1/automation/projects/${made.projectId}/environments/${made.environmentId}`;

    // ---- its server starts
    const expected = await ownerExport(made.projectId, made.environmentId);
    expect(Object.keys(expected).length).toBe(SEEDED);
    const startBegan = performance.now();
    const started = await startServer(made.projectId, made.clientSecret);
    const startMs = performance.now() - startBegan;
    expect(started.code, started.stderr).toBe(0);
    const seen = JSON.parse(started.stdout) as Record<string, string | number>;
    expect(seen.__secrets).toBe(0);
    delete seen.__secrets;
    expect(seen).toEqual(expected);
    record("provisioned", {
      tenant,
      project: made.projectId,
      environment: made.environmentId,
      // Ids of catalog rows. Their keys name no "credential": the secret scan
      // reads a UUID beside that word as a generic key when its entropy is high.
      ids: { automation: auto.credentialId, runtime: made.credentialId },
      issueAutomationMs: Math.round(auto.ms),
      provisionMs: Math.round(provisionMs),
      steps: timings(made.steps),
      serverStartByCliMs: Math.round(startMs),
      valuesTheServerGot: Object.keys(seen).length,
    });

    // ---- 1. another network (Review focus 4, through the real edge)
    ({ cookie } = await stagingOwnerSession());
    const elsewhere = await issueAutomation({
      name: "s11-elsewhere",
      rights: AUTOMATION_RIGHTS,
      cidrs: ["192.0.2.0/24"],
    });
    const fromElsewhere = await automation(elsewhere.secret, "GET", "/v1/automation/projects");
    expect(outcome(fromElsewhere)).toEqual([401, "unauthenticated"]);
    const listed = await automation(auto.secret, "GET", "/v1/automation/projects");
    expect(outcome(listed)).toEqual([200, undefined]);
    const mine = (json(listed).projects as { id: string }[]).map((project) => project.id);
    expect(mine).toEqual([made.projectId]);

    // ---- 2. a project its chain does not manage is the 404 of an absent one
    const ownerProject = await send("POST", `${ORG}/projects`, {
      name: `s11-owner-${randomBytes(3).toString("hex")}`,
    });
    expect(ownerProject.status).toBe(201);
    const ownerProjectId = (json(ownerProject).result as { projectId: string }).projectId;
    projects.add(ownerProjectId);
    const notMine = await automation(
      auto.secret,
      "GET",
      `/v1/automation/projects/${ownerProjectId}`,
    );
    const absent = await automation(auto.secret, "GET", `/v1/automation/projects/${randomUUID()}`);
    expect(outcome(notMine)).toEqual([404, "not_found"]);
    expect(outcome(absent)).toEqual([404, "not_found"]);
    const own = await automation(auto.secret, "GET", `/v1/automation/projects/${made.projectId}`);
    expect(outcome(own)).toEqual([200, undefined]);
    expect(json(own).name).toBe(tenant);

    // ---- 3. a credential of the same chain without the right
    const narrow = await issueAutomation({
      name: "s11-narrow",
      rights: ["projects.create"],
      cidrs: [caller],
      replaces: auto.credentialId,
    });
    expect(narrow.ownerId).toBe(auto.ownerId);
    const extra = { name: `${PREFIX}EXTRA`, value: `synthetic-${randomUUID()}` };
    const denied = await automation(narrow.secret, "POST", `${scope}/secrets`, extra);
    expect(outcome(denied)).toEqual([403, "action_denied"]);
    const allowed = await automation(auto.secret, "POST", `${scope}/secrets`, extra);
    expect(outcome(allowed)).toEqual([201, undefined]);

    // ---- 4. no value: the list has none, and the secret opens no other door
    const names = await automation(auto.secret, "GET", `${scope}/secrets?limit=100`);
    expect(outcome(names)).toEqual([200, undefined]);
    const rows = json(names).secrets as Record<string, unknown>[];
    expect(rows.map((row) => row.name).sort()).toEqual([...Object.keys(values), extra.name].sort());
    for (const row of rows) expect(Object.keys(row)).not.toContain("value");
    for (const value of [...Object.values(values), extra.value]) {
      expect(names.body.includes(value)).toBe(false);
    }
    const asMachine = await exchangeRequest(auto.secret);
    expect(outcome(asMachine)).toEqual([401, "unauthenticated"]);
    const asPerson = await publicRequest(
      "POST",
      `${ORG}/projects/${made.projectId}/environments/${made.environmentId}/export`,
      { body: { confirmed: true }, headers: { authorization: `Bearer ${auto.secret}` } },
    );
    expect(asPerson.status).toBe(401);
    // The control: the server's own credential is exchanged.
    const asServer = await exchangeRequest(made.clientSecret);
    expect(outcome(asServer)).toEqual([200, undefined]);
    registerSecret((json(asServer) as { token: string }).token);
    held.push((json(asServer) as { token: string }).token);

    // ---- the owner revokes the server's credential; the script reissues
    ({ cookie } = await stagingOwnerSession());
    const serverRevoked = await send(
      "POST",
      `${ORG}/projects/${made.projectId}/environments/${made.environmentId}/credentials/${made.credentialId}/revoke`,
      { confirmed: true },
    );
    expect(outcome(serverRevoked)).toEqual([200, undefined]);
    const stopped = await startServer(made.projectId, made.clientSecret);
    expect(stopped.code).toBe(77);
    expect(stopped.stdout).toBe("");
    const reissueStarted = performance.now();
    const again = await reissue(api, auto.secret);
    const reissueMs = performance.now() - reissueStarted;
    for (const one of again.issued) {
      hold(one.clientSecret);
      runtimeIssued.push([one.projectId, one.environmentId, one.credentialId]);
    }
    expect(again.projects).toBe(1);
    const fresh = again.issued.find((one) => one.environmentId === made.environmentId);
    expect(fresh).toBeDefined();
    const expectedNow = await ownerExport(made.projectId, made.environmentId);
    expect(Object.keys(expectedNow).length).toBe(SEEDED + 1);
    const back = await startServer(made.projectId, fresh?.clientSecret ?? "");
    expect(back.code, back.stderr).toBe(0);
    const seenAgain = JSON.parse(back.stdout) as Record<string, string | number>;
    delete seenAgain.__secrets;
    expect(seenAgain).toEqual(expectedNow);

    // ---- 5. revoked: the next request is 401, and what it made keeps working
    const autoRevoked = await send(
      "POST",
      `${ORG}/automation-credentials/${auto.credentialId}/revoke`,
      { confirmed: true },
    );
    expect(outcome(autoRevoked)).toEqual([200, undefined]);
    automationIssued.delete(auto.credentialId);
    const afterRevoke = await automation(auto.secret, "GET", "/v1/automation/projects");
    expect(outcome(afterRevoke)).toEqual([401, "unauthenticated"]);
    const stillServed = await exchangeRequest(fresh?.clientSecret ?? "");
    expect(outcome(stillServed)).toEqual([200, undefined]);
    registerSecret((json(stillServed) as { token: string }).token);
    held.push((json(stillServed) as { token: string }).token);

    record("boundary", {
      anotherNetwork: outcome(fromElsewhere),
      projectOfNoChain: outcome(notMine),
      absentProject: outcome(absent),
      withoutTheRight: outcome(denied),
      withTheRight: outcome(allowed),
      listHoldsNoValue: true,
      automationSecretOnTheExchange: outcome(asMachine),
      automationSecretOnAHumanRoute: asPerson.status,
      afterRevocation: outcome(afterRevoke),
      whatItMadeAfterItsRevocation: outcome(stillServed),
    });
    record("reissue", {
      serverAfterItsCredentialWasRevoked: stopped.code,
      projects: again.projects,
      credentialsIssued: again.issued.length,
      reissueMs: Math.round(reissueMs),
      steps: timings(again.steps),
      valuesTheServerGot: Object.keys(seenAgain).length,
    });
    record("search-controls", {
      project: made.projectId,
      environment: made.environmentId,
      automation: auto.credentialId,
    });
  }, 1_200_000);

  it("no automation secret and no client secret is on a host surface; every surface shows a control", async () => {
    const controls = evidence["search-controls"] as
      { project: string; environment: string; automation: string } | undefined;
    expect(controls, "the journey did not finish: nothing to search for").toBeDefined();
    if (controls === undefined) return;
    expect(held.length).toBeGreaterThan(0);
    const since = startedAt.toISOString();
    // The second review of Run 11.8 (M3): the last string of each surface is not
    // an argument but travels as the needles do. Found, it shows that the
    // needles reached the search as patterns, not only that the producer ran.
    const kv = `kv/data/p/${controls.project}/e/${controls.environment}/${PREFIX}`;
    const surfaces: [string, string, string[], string][] = [
      [
        "API log",
        `docker logs --since ${since} mykey-api-1`,
        ["/v1/automation/projects"],
        "/v1/machine/exchange",
      ],
      [
        "provisioner log",
        `docker logs --since ${since} mykey-provisioner-1`,
        // The job that provisioned the tenant's environment (its log names operation ids only).
        ['"event":"job"'],
        '"operationId":"',
      ],
      [
        "pg_dump (database postgres)",
        `docker exec mykey-postgres-1 sh -c 'PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" pg_dump -U postgres -d postgres'`,
        [controls.automation],
        controls.project,
      ],
      [
        "OpenBao audit device",
        "docker exec mykey-openbao-1 cat /openbao/audit/audit.log",
        [`${kv}00`],
        `${kv}01`,
      ],
      [
        "Traefik access log",
        `docker logs --since ${since} mykey-edge-1`,
        ["/v1/automation/projects"],
        "/v1/machine/exchange",
      ],
    ];
    const found: Record<string, { searched: number; found: number; controls: string }> = {};
    let total = 0;
    for (const [surface, producer, wanted, asNeedle] of surfaces) {
      const result = await countOnHost(host, producer, held, wanted, [asNeedle]);
      total += result.found;
      found[surface] = {
        searched: held.length,
        found: result.found,
        controls: `${String(result.controls)} of ${String(wanted.length + 1)}, one of them sent as a needle`,
      };
    }
    record("search", found);
    expect(total).toBe(0);
  }, 1_800_000);
});
