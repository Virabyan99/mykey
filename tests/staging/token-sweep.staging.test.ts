// Run 5.10 Step 5 (the token sweep): machine tokens issued on staging here and
// one run-time canary resolved by a machine are searched on every host surface:
// the API's and the provisioner's log, a pg_dump, PostgreSQL's log, OpenBao's
// audit device and Traefik's access log. The values travel on fd 3 of the
// search (countOnHost); only counts come back, and each surface has a control
// that must be found, or the search read nothing. Tokens are stored nowhere:
// the sweep can only search the tokens this file holds. The clean machine's
// history files and process list are searched by `pnpm run test:consumers`.
// Writes docs/evidence/session-5/token-sweep.txt; every credential is revoked.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { countOnHost, loadHosts, registerSecret } from "../harness/staging.ts";
import { machineRequest } from "../harness/staging-machine.ts";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";

const host = loadHosts().staging;
/** The staging owner's organization (Run 3.2). */
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const ENVIRONMENT = "development";
const OUTPUT = "docs/evidence/session-5/token-sweep.txt";

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
  it("three tokens and a canary resolved by a machine are found on no host surface", async () => {
    const startedAt = new Date().toISOString();
    ({ cookie } = await stagingOwnerSession());
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
    const canary = ["MYKEY", "CANARY", randomBytes(16).toString("hex")].join("_");
    registerSecret(canary);
    const secretName = "S5_SWEEP_CANARY";
    const made = await send("POST", `${environmentPath}/secrets`, {
      name: secretName,
      value: canary,
    });
    expect(made.status).toBe(201);

    const issued: { credentialId: string; token: string }[] = [];
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
    } finally {
      ({ cookie } = await stagingOwnerSession());
      for (const { credentialId } of issued) {
        const revoked = await send(
          "POST",
          `${environmentPath}/credentials/${credentialId}/revoke`,
          { confirmed: true },
        );
        expect(revoked.status, revoked.body.slice(0, 200)).toBe(200);
      }
    }

    const values = [...issued.map((entry) => entry.token), canary];
    const resolvePath = `/v1/machine/projects/${projectId}/environments/${ENVIRONMENT}/resolve`;
    const surfaces: [string, string, string[]][] = [
      [
        "API log",
        `docker logs --since ${startedAt} mykey-api-1`,
        ["/v1/machine/projects/:project/environments/:envName/resolve"],
      ],
      [
        "provisioner log",
        `docker logs --since ${startedAt} mykey-provisioner-1`,
        // The job that provisioned this file's environment (its log names operation ids only).
        ['"event":"job"'],
      ],
      [
        "pg_dump (database postgres)",
        `docker exec mykey-postgres-1 sh -c 'PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")" pg_dump -U postgres -d postgres'`,
        issued.map((entry) => entry.credentialId),
      ],
      [
        "PostgreSQL log",
        "docker logs mykey-postgres-1",
        ["database system is ready to accept connections"],
      ],
      [
        "OpenBao audit device",
        "docker exec mykey-openbao-1 cat /openbao/audit/audit.log",
        [`kv/data/p/${projectId}/e/${environmentId}/${secretName}`],
      ],
      ["Traefik access log", `docker logs --since ${startedAt} mykey-edge-1`, [resolvePath]],
    ];
    const lines = [
      "# Token sweep on staging (Run 5.10 Step 5)",
      `# ${new Date().toISOString()}; project ${name} (${projectId}), environment ${environmentId}`,
      "# Three machine tokens issued here (two resolved, the first also listed keys, one never used; all revoked)",
      "# and one run-time canary value resolved by those machines.",
      "# Values reach the host on fd 3 of the search, never the pipe; only counts come back (countOnHost).",
      "# Each surface has controls, strings that are not secret and must be found there; a search missing one fails.",
      "# surface | command | values searched | values found | controls found",
    ];
    let total = 0;
    for (const [surface, producer, controls] of surfaces) {
      const result = await countOnHost(host, producer, values, controls);
      total += result.found;
      lines.push(
        `${surface} | ${producer} | ${String(values.length)} | ${String(result.found)} | ${String(result.controls)} of ${String(controls.length)}`,
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
