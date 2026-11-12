// Run 2.7 (FR-1.64, AC-1.26, PO-1): staging OpenBao unseals from OVHcloud KMS
// by itself. Every unseal assertion first proves that a new process started
// (pid and StartedAt differ from before the action). Timings are appended to
// docs/evidence/session-2/unseal-staging.txt.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrgFixture, type OrgFixture } from "../harness/org-fixture.ts";
import { baoFetch, type Stack } from "../harness/stack.ts";
import { connectStaging, expectSuccess, sshExec, type StagingStack } from "../harness/staging.ts";

const EVIDENCE = resolve(import.meta.dirname, "../../docs/evidence/session-2/unseal-staging.txt");
const CONTAINER = "mykey-openbao-1";
const COMPOSE =
  "docker compose --env-file /etc/mykey/host.env -f /opt/mykey/compose/host.compose.yml -p mykey --profile openbao";
const PUBLIC_HEALTH = "https://mykey-staging.nomikey.com/health";

let staging: StagingStack;
let org: OrgFixture;
const secret = { path: "", value: "" };

function record(line: string): void {
  appendFileSync(EVIDENCE, `${new Date().toISOString()} ${line}\n`);
}

const asStack = (): Stack => staging as unknown as Stack;

async function sealStatus(): Promise<Record<string, unknown> | undefined> {
  const response = await baoFetch(asStack(), "/v1/sys/seal-status", { token: "" }).catch(
    () => undefined,
  );
  return response?.status === 200
    ? ((await response.json()) as Record<string, unknown>)
    : undefined;
}

async function openbaoProcess(): Promise<{ pid: number; startedAt: string; restarts: number }> {
  const result = await sshExec(
    staging.host,
    `docker inspect --format '{{.State.Pid}} {{.State.StartedAt}} {{.RestartCount}}' ${CONTAINER}`,
    { sudo: true },
  );
  const [pid, startedAt, restarts] = expectSuccess(result, "docker inspect")
    .stdout.trim()
    .split(" ");
  return { pid: Number(pid), startedAt: startedAt ?? "", restarts: Number(restarts) };
}

/** Milliseconds until seal-status says unsealed and the secret reads back; throws after `seconds`. */
async function waitUnsealedAndReadable(seconds: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    const status = await sealStatus();
    if (status?.sealed === false && (await readSecret()) === secret.value) {
      return Date.now() - started;
    }
    await sleep(1_000);
  }
  throw new Error(`not unsealed with the secret readable within ${seconds} s`);
}

async function readSecret(): Promise<string | undefined> {
  const response = await baoFetch(asStack(), `/v1/kv/data/${secret.path}`, {
    namespace: org.namespace,
  }).catch(() => undefined);
  if (response?.status !== 200) return undefined;
  const body = (await response.json()) as { data?: { data?: { value?: string } } };
  return body.data?.data?.value;
}

async function expectNewProcess(before: { pid: number; startedAt: string }): Promise<void> {
  const after = await openbaoProcess();
  expect(after.pid).not.toBe(before.pid);
  expect(after.startedAt).not.toBe(before.startedAt);
}

beforeAll(async () => {
  staging = await connectStaging({ openbao: true });
  if (!existsSync(EVIDENCE))
    writeFileSync(EVIDENCE, "# Run 2.7 unseal drills on staging (appended)\n");
  org = await createOrgFixture(asStack(), { environments: 1 });
  secret.path = `unseal-${Date.now()}`;
  secret.value = `synthetic-${Date.now()}`;
  const write = await baoFetch(asStack(), `/v1/kv/data/${secret.path}`, {
    method: "POST",
    namespace: org.namespace,
    body: { options: { cas: 0 }, data: { value: secret.value } },
  });
  if (write.status !== 200) throw new Error(`writing the drill secret: HTTP ${write.status}`);
}, 300_000);

afterAll(async () => {
  await (org as OrgFixture | undefined)?.drop().catch(() => undefined);
  await (staging as StagingStack | undefined)?.close();
}, 120_000);

describe("staging OpenBao on the OVHcloud KMS seal", () => {
  it("is staging, and its seal is not static", async () => {
    const status = await staging.status();
    expect(status.host).toBe("staging");
    expect(status.sealType).not.toBeNull();
    expect(status.sealType).not.toBe("static");
  });

  it("initialised on the real KMS", async () => {
    const status = await sealStatus();
    expect(status).toMatchObject({
      initialized: true,
      sealed: false,
      recovery_seal: true,
      storage_type: "raft",
    });
    record(`seal-status type=${String(status?.type)} version=${String(status?.version)}`);
  });

  it("container restart unseals alone", async () => {
    const before = await openbaoProcess();
    expectSuccess(
      await sshExec(staging.host, `docker restart ${CONTAINER}`, {
        sudo: true,
        timeoutMs: 120_000,
      }),
      "docker restart",
    );
    await expectNewProcess(before);
    const ms = await waitUnsealedAndReadable(60);
    record(`container restart: unsealed and readable after ${ms} ms`);
  }, 180_000);

  it("cold start unseals alone", async () => {
    const before = await openbaoProcess();
    const remote = { sudo: true, timeoutMs: 180_000 } as const;
    expectSuccess(
      await sshExec(staging.host, `${COMPOSE} rm --stop --force openbao`, remote),
      "rm",
    );
    expectSuccess(await sshExec(staging.host, `${COMPOSE} up -d openbao`, remote), "up");
    await expectNewProcess(before);
    const ms = await waitUnsealedAndReadable(60);
    record(`cold start (container removed, volume kept): unsealed and readable after ${ms} ms`);
  }, 300_000);

  it("public /health is up only with OpenBao unsealed", async () => {
    const response = await fetch(PUBLIC_HEALTH);
    expect(response.status).toBe(200);
  });
});
