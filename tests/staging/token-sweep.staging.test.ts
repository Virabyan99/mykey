// Run 5.10 Step 5 (the token sweep): machine tokens issued on staging here and
// one run-time canary resolved by a machine are searched on every host surface:
// the API's and the provisioner's log, a pg_dump, PostgreSQL's log, OpenBao's
// audit device and Traefik's access log. The values travel on fd 3 of the
// search (countOnHost); only counts come back, and each surface has a control
// that must be found, or the search read nothing. Tokens are stored nowhere:
// the sweep can only search the tokens this file holds. The clean machine's
// history files and process list are searched by `pnpm run test:consumers`.
//
// Session 11 (Run 11.8 Task C Step 3): the sweep also holds a runtime
// credential's client secret, the token of its exchange (which resolves the
// canary too) and an automation secret that listed its projects. The client
// secret and the automation secret are searched whole and by their secret
// part alone.
// Writes docs/evidence/session-11/token-sweep.txt (Session 5's file is that
// session's record and is no longer rewritten); every credential is revoked.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { countOnHost, loadHosts, nextMinute, registerSecret } from "../harness/staging.ts";
import { callerNetwork, exchangeRequest, machineRequest } from "../harness/staging-machine.ts";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";

const host = loadHosts().staging;
/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const ENVIRONMENT = "development";
const OUTPUT = "docs/evidence/session-11/token-sweep.txt";

let cookie: string;
const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;

function send(method: string, path: string, body: unknown): Promise<PublicAnswer> {
  return publicRequest(method, path, {
    body,
    cookie,
    headers: { "idempotency-key": randomUUID() },
  });
}

describe("the token sweep on staging", () => {
  it("three tokens, a client secret, the token of its exchange, an automation secret and a canary resolved by machines are found on no host surface", async () => {
    const startedAt = new Date().toISOString();
    ({ cookie } = await stagingOwnerSession());
    // The automation credential must name a network: this workstation as the edge sees it (never printed).
    const caller = await callerNetwork(host);
    const name = `s5-sweep-${randomBytes(3).toString("hex")}`;
    const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, { name });
    expect(created.status).toBe(201);
    const { projectId, developmentEnvironmentId: environmentId } = json(created).result as {
      projectId: string;
      developmentEnvironmentId: string;
    };
    const projectPath = `/v1/organizations/${ORGANIZATION}/projects/${projectId}`;
    const environmentPath = `${projectPath}/environments/${environmentId}`;
    for (const deadline = Date.now() + 180_000; ;) {
      const listed = await publicRequest("GET", `${projectPath}/environments`, { cookie });
      const all = (json(listed).environments ?? []) as { id: string; state: string }[];
      if (all.find((environment) => environment.id === environmentId)?.state === "active") break;
      if (Date.now() > deadline) throw new Error("the environment did not become active");
      await sleep(3000);
    }

    // The canary is assembled at run time (CLAUDE.md: never a literal in a file).
    const canary = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
    registerSecret(canary);
    const secretName = "S5_SWEEP_CANARY";
    const made = await send("POST", `${environmentPath}/secrets`, {
      name: secretName,
      value: canary,
    });
    expect(made.status).toBe(201);

    const issued: { credentialId: string; token: string }[] = [];
    /** Session 11: the runtime credential, the automation credential, and what they held. */
    const runtimeIds: string[] = [];
    const automationIds: string[] = [];
    const presented: string[] = [];
    const keep = (secret: string): void => {
      registerSecret(secret);
      const part = secret.split(".")[2] ?? "";
      registerSecret(part);
      presented.push(secret, part);
    };
    // Five issuances follow, and a person has five a minute (Run 6.3): a fresh minute.
    await nextMinute();
    /** What each revocation answered: asserted after every one was tried. */
    const revocations: number[] = [];
    try {
      for (let index = 0; index < 3; index += 1) {
        const answer = await send("POST", `${environmentPath}/credentials`, {
          name: `s5-sweep-${String(index)}`,
          ttlSeconds: 300,
        });
        expect(answer.status, answer.body.slice(0, 200)).toBe(201);
        const body = json(answer) as { credential: { credentialId: string }; token: string };
        registerSecret(body.token);
        issued.push({ credentialId: body.credential.credentialId, token: body.token });
      }
      // Two tokens resolve (the first also lists keys); the third is never used.
      for (const { token } of issued.slice(0, 2)) {
        const resolved = await machineRequest("resolve", projectId, ENVIRONMENT, token);
        expect(resolved.status).toBe(200);
        expect(json(resolved).count).toBe(1);
        // The canary came back to the machine: the control that it was resolved.
        expect(resolved.bytes.includes(Buffer.from(canary))).toBe(true);
      }
      expect((await machineRequest("keys", projectId, ENVIRONMENT, issued[0]!.token)).status).toBe(
        200,
      );

      // Session 11: a runtime credential, exchanged; its token resolves the canary.
      const runtime = await send("POST", `${environmentPath}/runtime-credentials`, {
        name: "s11-sweep-runtime",
        ttlSeconds: 3600,
      });
      expect(runtime.status).toBe(201);
      const runtimeBody = json(runtime) as {
        credential: { credentialId: string };
        clientSecret: string;
      };
      keep(runtimeBody.clientSecret);
      runtimeIds.push(runtimeBody.credential.credentialId);
      const exchanged = await exchangeRequest(runtimeBody.clientSecret);
      expect(exchanged.status).toBe(200);
      const exchangedToken = (json(exchanged) as { token: string }).token;
      registerSecret(exchangedToken);
      presented.push(exchangedToken);
      const byExchange = await machineRequest("resolve", projectId, ENVIRONMENT, exchangedToken);
      expect(byExchange.status).toBe(200);
      expect(byExchange.bytes.includes(Buffer.from(canary))).toBe(true);

      // Session 11: an automation credential that lists its (no) projects.
      const automation = await send(
        "POST",
        `/v1/organizations/${ORGANIZATION}/automation-credentials`,
        {
          name: "s11-sweep-automation",
          rights: ["projects.create"],
          ttlSeconds: 3600,
          cidrs: [caller],
        },
      );
      expect(automation.status).toBe(201);
      const automationBody = json(automation) as {
        credential: { credentialId: string };
        secret: string;
      };
      keep(automationBody.secret);
      automationIds.push(automationBody.credential.credentialId);
      const listed = await publicRequest("GET", "/v1/automation/projects", {
        headers: { authorization: `Bearer ${automationBody.secret}` },
      });
      expect(listed.status).toBe(200);
    } finally {
      ({ cookie } = await stagingOwnerSession());
      for (const { credentialId } of issued) {
        const revoked = await send(
          "POST",
          `${environmentPath}/credentials/${credentialId}/revoke`,
          { confirmed: true },
        );
        revocations.push(revoked.status);
      }
      for (const credentialId of runtimeIds) {
        const revoked = await send(
          "POST",
          `${environmentPath}/credentials/${credentialId}/revoke`,
          { confirmed: true },
        );
        revocations.push(revoked.status);
      }
      for (const credentialId of automationIds) {
        const revoked = await send(
          "POST",
          `/v1/organizations/${ORGANIZATION}/automation-credentials/${credentialId}/revoke`,
          { confirmed: true },
        );
        revocations.push(revoked.status);
      }
    }
    // Every revocation was tried before any is judged: one refusal must not leave the rest alive.
    expect(revocations.length).toBe(issued.length + runtimeIds.length + automationIds.length);
    expect(revocations.every((status) => status === 200)).toBe(true);

    // What must have been made, or the search below would prove less than it says.
    expect(runtimeIds.length).toBe(1);
    expect(automationIds.length).toBe(1);
    expect(presented.length).toBe(5);
    const values = [...issued.map((entry) => entry.token), canary, ...presented];
    const resolvePath = `/v1/machine/projects/${projectId}/environments/${ENVIRONMENT}/resolve`;
    // The second review of Run 11.8 (M3): the last string of each surface is not
    // an argument but travels as the needles do. Found, it shows that the
    // needles reached the search as patterns, not only that the producer ran.
    const surfaces: [string, string, string[], string][] = [
      [
        "API log",
        `docker logs --since ${startedAt} mykey-api-1`,
        ["/v1/machine/projects/:project/environments/:envName/resolve", "/v1/machine/exchange"],
        "/v1/automation/projects",
      ],
      [
        "provisioner log",
        `docker logs --since ${startedAt} mykey-provisioner-1`,
        // The job that provisioned this file's environment (its log names operation ids only).
        ['"event":"job"'],
        '"operationId":"',
      ],
      [
        "pg_dump (database postgres)",
        `docker exec mykey-postgres-1 sh -c 'PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" pg_dump -U postgres -d postgres'`,
        [...issued.map((entry) => entry.credentialId), ...runtimeIds],
        automationIds[0] ?? "",
      ],
      [
        "PostgreSQL log",
        "docker logs mykey-postgres-1",
        ["database system is ready to accept connections"],
        "starting PostgreSQL",
      ],
      [
        "OpenBao audit device",
        "docker exec mykey-openbao-1 cat /openbao/audit/audit.log",
        [`kv/data/p/${projectId}/e/${environmentId}/${secretName}`],
        `auth/token/create/machine-env-${environmentId}`,
      ],
      [
        "Traefik access log",
        `docker logs --since ${startedAt} mykey-edge-1`,
        [resolvePath, "/v1/machine/exchange"],
        "/v1/automation/projects",
      ],
    ];
    const lines = [
      "# Token sweep on staging (Run 5.10 Step 5; Session 11's three kinds added in Run 11.8)",
      `# ${new Date().toISOString()}; project ${name} (${projectId}), environment ${environmentId}`,
      "# Three machine tokens issued here (two resolved, the first also listed keys, one never used; all revoked)",
      "# and one run-time canary value resolved by those machines.",
      "# Session 11: one runtime credential's client secret (whole, and its secret part), the token of its exchange",
      "# (which resolved the canary too), and one automation secret (whole, and its secret part) that listed its projects.",
      "# Values reach the host on fd 3 of the search, never the pipe; only counts come back (countOnHost).",
      "# Each surface has controls, strings that are not secret and must be found there; a search missing one fails.",
      "# The last control of each surface is sent as the values are (a needle control): found, it shows the values arrived as patterns.",
      "# surface | command | values searched | values found | controls found",
    ];
    let total = 0;
    for (const [surface, producer, controls, asNeedle] of surfaces) {
      const result = await countOnHost(host, producer, values, controls, [asNeedle]);
      total += result.found;
      lines.push(
        `${surface} | ${producer} | ${String(values.length)} | ${String(result.found)} | ${String(result.controls)} of ${String(controls.length + 1)}`,
      );
    }
    lines.push(`# total values found outside the responses: ${String(total)}`);
    lines.push(
      "# The clean machine's history files and process list: docs/evidence/session-5/run-5.8-consumers.json (pnpm run test:consumers).",
    );
    writeFileSync(OUTPUT, `${lines.join("\n")}\n`);
    expect(total).toBe(0);
  }, 900_000);
});
