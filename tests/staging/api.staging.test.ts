// Run 3.1 Task F: the API image with the service gate on staging, proven
// through the public name. Leaves the gate open.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATE_FILE, gateRecordText, gateWriteCommand } from "../../scripts/host.ts";
import { httpsGet, type HttpsAnswer } from "../harness/outside.ts";
import {
  REMOTE,
  expectSuccess,
  loadHosts,
  parseHostEnv,
  sshExec,
  type HostEntry,
} from "../harness/staging.ts";

const host: HostEntry = loadHosts().staging;
const API_CONTAINER = "mykey-api-1";
let hostInstanceId = "";

const run = async (command: string, opts: { stdin?: string } = {}): Promise<string> =>
  expectSuccess(await sshExec(host, command, { sudo: true, timeoutMs: 120_000, ...opts }), command)
    .stdout;

async function writeGate(state: "open" | "closed"): Promise<void> {
  const current = await sshExec(host, `cat ${GATE_FILE}`, { sudo: true });
  const previous = current.code === 0 ? current.stdout : null;
  await run(gateWriteCommand(), {
    stdin: gateRecordText(state, previous, hostInstanceId, new Date().toISOString()),
  });
}

const errorCode = (answer: HttpsAnswer): string | undefined => {
  try {
    return (JSON.parse(answer.body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
};

async function startedAt(): Promise<string> {
  return (await run(`docker inspect --format '{{.State.StartedAt}}' ${API_CONTAINER}`)).trim();
}

beforeAll(async () => {
  // The target first: host.env must name the host of hosts.json.
  const env = parseHostEnv(await run(`cat ${REMOTE.hostEnv}`));
  expect(env.MYKEY_HOSTNAME).toBe(host.hostname);
  expect(env.MYKEY_HOST).toBe("staging");
  hostInstanceId = env.MYKEY_HOST_INSTANCE_ID ?? "";
  expect(hostInstanceId).toMatch(/^[0-9a-f-]{36}$/);
});

afterAll(async () => {
  await run(`chmod 0644 ${GATE_FILE}`).catch(() => undefined);
  await writeGate("open");
});

describe("staging service gate", () => {
  it("the gate file is root-owned and the API container sees it read-only", async () => {
    await writeGate("open");
    expect((await run(`stat -c '%U:%G %a' ${GATE_FILE}`)).trim()).toBe("root:root 644");
    // As root inside the container, so only the mount can refuse the write.
    const attempt = await sshExec(
      host,
      `docker exec -u 0 ${API_CONTAINER} sh -c 'echo x >> /run/mykey/gate/gate.json'`,
      { sudo: true },
    );
    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toMatch(/Read-only file system/);
    const mounts = JSON.parse(
      await run(`docker inspect --format '{{json .Mounts}}' ${API_CONTAINER}`),
    ) as { Source: string; Destination: string; RW: boolean }[];
    expect(mounts.filter((mount) => mount.Destination === "/run/mykey/gate")).toEqual([
      expect.objectContaining({ Source: "/etc/mykey/gate", RW: false }),
    ]);
  });

  it("closed gate: /health down and /v1/version quarantined through the public name", async () => {
    await writeGate("closed");
    const health = await httpsGet(host.hostname, "/health");
    expect(health.status).toBe(503);
    expect(health.body).toBe('{"status":"down"}');
    const version = await httpsGet(host.hostname, "/v1/version");
    expect(version.status).toBe(503);
    expect(errorCode(version)).toBe("quarantined");
  });

  it("after the gate opens the next request answers 200 without a restart", async () => {
    const before = await startedAt();
    await writeGate("open");
    const version = await httpsGet(host.hostname, "/v1/version");
    expect(version.status).toBe(200);
    expect(JSON.parse(version.body)).toMatchObject({ apiMajor: 1 });
    expect((await httpsGet(host.hostname, "/health")).status).toBe(200);
    expect(await startedAt()).toBe(before);
  });

  it("an atomic replacement under load is never read half-written", async () => {
    const answers: { status: number; code: string | undefined }[] = [];
    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 20; i += 1) await writeGate(i % 2 === 0 ? "closed" : "open");
      writing = false;
    })();
    const load = async (): Promise<void> => {
      while (writing || answers.length < 200) {
        const answer = await httpsGet(host.hostname, "/v1/version");
        answers.push({ status: answer.status, code: errorCode(answer) });
        if (answers.length >= 400) return;
      }
    };
    await Promise.all([writer, ...Array.from({ length: 8 }, load)]);
    expect(answers.length).toBeGreaterThanOrEqual(200);
    const unexpected = answers.filter(
      (answer) =>
        answer.status !== 200 && !(answer.status === 503 && answer.code === "quarantined"),
    );
    expect(unexpected).toEqual([]);
    // Both states were seen: the load overlapped the writes.
    expect(new Set(answers.map((answer) => answer.status))).toEqual(new Set([200, 503]));
    await writeGate("open");
  });

  it("the response carries no-store and Strict-Transport-Security", async () => {
    for (const path of ["/v1/version", "/v1/no-such-route"]) {
      const answer = await httpsGet(host.hostname, path);
      expect(answer.headers["cache-control"], path).toBe("no-store");
      expect(answer.headers["strict-transport-security"], path).toBe("max-age=63072000");
    }
  });

  it("an unreadable gate file is closed with cause unreadable", async () => {
    await writeGate("open");
    await run(`chmod 000 ${GATE_FILE}`);
    try {
      const answer = await httpsGet(host.hostname, "/v1/version");
      expect(answer.status).toBe(503);
      expect(errorCode(answer)).toBe("quarantined");
      const requestId = String(answer.headers["x-request-id"]);
      const line = await run(
        `docker logs --since 5m ${API_CONTAINER} 2>&1 | grep -F '"event":"gate_closed"' | grep -F ${requestId}`,
      );
      expect(JSON.parse(line.trim())).toMatchObject({ event: "gate_closed", cause: "unreadable" });
    } finally {
      await run(`chmod 0644 ${GATE_FILE}`);
    }
    expect((await httpsGet(host.hostname, "/v1/version")).status).toBe(200);
  });
});
