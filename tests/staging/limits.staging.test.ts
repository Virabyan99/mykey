// Run 6.3 Task C (P-115, FR-1.61, AC-1.24): disk pressure on staging.
// `status.sh` (run every minute by the heartbeat timer) writes the capacity
// record; it must be younger than 120 s and name the expected volumes. Then,
// with the heartbeat timer stopped and the record replaced by a `low` one, a
// secret write is 507 { limit: disk } and a credential revocation succeeds.
// The timer and the record are restored in `finally`.
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectSuccess, loadHosts, sshExec } from "../harness/staging.ts";
import { publicRequest, stagingOwnerSession, type PublicAnswer } from "../harness/staging-owner.ts";

const host = loadHosts().staging;
const ORGANIZATION = "e2350312-420b-4fde-84c5-d582a008080b";
const RECORD = "/etc/mykey/gate/capacity.json";
const TIMER = "mykey-heartbeat.timer";
const VOLUMES = ["bao-audit", "bao-rotated", "docker", "openbao", "postgres"];

let cookie: string;
let environmentPath = "";

const json = (answer: PublicAnswer): Record<string, unknown> =>
  JSON.parse(answer.body) as Record<string, unknown>;
const send = (method: string, path: string, body?: unknown) =>
  publicRequest(method, path, {
    ...(body === undefined ? {} : { body }),
    cookie,
    headers: { "idempotency-key": randomUUID() },
  });
const root = (command: string) => sshExec(host, command, { sudo: true, timeoutMs: 120_000 });

beforeAll(async () => {
  ({ cookie } = await stagingOwnerSession());
  const created = await send("POST", `/v1/organizations/${ORGANIZATION}/projects`, {
    name: `s6-limits-${randomBytes(4).toString("hex")}`,
  });
  expect(created.status, created.body).toBe(201);
  const result = json(created).result as { projectId: string; developmentEnvironmentId: string };
  environmentPath = `/v1/organizations/${ORGANIZATION}/projects/${result.projectId}/environments/${result.developmentEnvironmentId}`;
  const deadline = Date.now() + 180_000;
  for (;;) {
    const listed = await publicRequest(
      "GET",
      `/v1/organizations/${ORGANIZATION}/projects/${result.projectId}/environments`,
      { cookie },
    );
    const environments = (json(listed).environments ?? []) as { id: string; state: string }[];
    if (environments.find((e) => e.id === result.developmentEnvironmentId)?.state === "active") {
      break;
    }
    if (Date.now() > deadline) throw new Error("the environment did not become active");
    await sleep(3000);
  }
  console.log(`limits.staging: project ${result.projectId}`);
}, 300_000);

afterAll(async () => {
  // Whatever happened: the timer runs and the record is the host's own again.
  await root(`systemctl start ${TIMER} && /opt/mykey/hosts/checks/status.sh >/dev/null`);
});

describe("disk pressure on staging (P-115)", () => {
  it("status.sh writes a record younger than 120 s whose volumes are the expected ones", async () => {
    const text = expectSuccess(await root(`cat ${RECORD}`), "reading the record").stdout;
    const record = JSON.parse(text) as {
      version: number;
      observedAt: string;
      state: string;
      volumes: Record<string, { freeBytes: number; sizeBytes: number; freeInodesPercent: number }>;
    };
    expect(record.version).toBe(1);
    expect(Date.now() - Date.parse(record.observedAt)).toBeLessThan(120_000);
    expect(Object.keys(record.volumes).sort()).toEqual(VOLUMES);
    expect(record.state).toBe("ok");
    for (const volume of Object.values(record.volumes)) {
      expect(volume.sizeBytes).toBeGreaterThan(volume.freeBytes);
      expect(volume.freeBytes).toBeGreaterThan(0);
    }
  });

  it("with a low record a secret write is 507 { limit: disk } and a credential revocation succeeds", async () => {
    await sleep(1000);
    const issued = await send("POST", `${environmentPath}/credentials`, {
      name: "limits-staging",
      ttlSeconds: 600,
    });
    // Issuance needs a fresh second factor; the staging owner session has one.
    expect(issued.status, issued.body).toBe(201);
    const credentialId = (json(issued).credential as { credentialId: string }).credentialId;
    expectSuccess(await root(`systemctl stop ${TIMER}`), "stopping the heartbeat timer");
    try {
      const low = JSON.stringify({
        version: 1,
        observedAt: new Date().toISOString(),
        state: "low",
        volumes: Object.fromEntries(
          VOLUMES.map((name) => [name, { freeBytes: 1, sizeBytes: 100, freeInodesPercent: 50 }]),
        ),
      });
      expectSuccess(
        await sshExec(
          host,
          `tee ${RECORD}.test >/dev/null && chmod 0644 ${RECORD}.test && mv -f ${RECORD}.test ${RECORD}`,
          {
            sudo: true,
            stdin: low,
          },
        ),
        "writing a low record",
      );
      const write = await send("POST", `${environmentPath}/secrets`, {
        name: `S6_LIMITS_${randomBytes(4).toString("hex").toUpperCase()}`,
        value: `synthetic-${randomUUID()}`,
      });
      expect(write.status, write.body).toBe(507);
      expect(json(write).error).toMatchObject({
        code: "capacity_exceeded",
        details: { limit: "disk" },
      });
      const revoked = await send("POST", `${environmentPath}/credentials/${credentialId}/revoke`, {
        confirmed: true,
      });
      expect(revoked.status, revoked.body).toBe(200);
    } finally {
      expectSuccess(
        await root(`systemctl start ${TIMER} && /opt/mykey/hosts/checks/status.sh >/dev/null`),
        "restoring the timer and the record",
      );
    }
    const after = JSON.parse(expectSuccess(await root(`cat ${RECORD}`), "re-reading").stdout) as {
      state: string;
    };
    expect(after.state).toBe("ok");
  }, 300_000);
});
