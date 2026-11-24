// Run 2.7 (FR-1.64, AC-1.26, PO-1): staging OpenBao unseals from OVHcloud KMS
// by itself. Every unseal assertion first proves that a new process started
// (pid and StartedAt differ from before the action). Timings are appended to
// docs/evidence/session-2/unseal-staging.txt.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kmsRemoveCommand, kmsUseCommand, okmsCommand } from "../../scripts/host.ts";
import { createOrgFixture, type OrgFixture } from "../harness/org-fixture.ts";
import { baoFetch, type Stack } from "../harness/stack.ts";
import {
  connectStaging,
  expectSuccess,
  registerSecret,
  sshExec,
  STAGING_SEAL_CERT,
  STAGING_SEAL_CERT_PREVIOUS,
  type StagingStack,
} from "../harness/staging.ts";

const EVIDENCE = resolve(import.meta.dirname, "../../docs/evidence/session-2/unseal-staging.txt");
const CONTAINER = "mykey-openbao-1";
const COMPOSE =
  "docker compose --env-file /etc/mykey/host.env -f /opt/mykey/compose/host.compose.yml -p mykey --profile openbao";
const PUBLIC_HEALTH = "https://mykey-staging.nomikey.com/health";
const EGRESS = "/opt/mykey/hosts/firewall/mykey-egress.sh";
const PROBE = "https://mykey-probe.nomikey.com";

interface ProbeView {
  state: { open: Record<string, { openedAt: number; lastAlertAt: number | null }> };
}

async function probeView(): Promise<ProbeView> {
  const token = readFileSync(join(homedir(), ".mykey", "secrets", "probe", "read-token"), "utf8");
  const response = await fetch(`${PROBE}/v1/state/staging`, {
    headers: { authorization: `Bearer ${token.trim()}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) throw new Error(`probe state: HTTP ${response.status}`);
  return (await response.json()) as ProbeView;
}

async function publicHealth(): Promise<number> {
  try {
    return (await fetch(PUBLIC_HEALTH, { signal: AbortSignal.timeout(10_000) })).status;
  } catch {
    return 0;
  }
}

/** The recovery key from the custody copy, registered so it is never printed. */
function custodyRecoveryKey(): string {
  const answer = JSON.parse(
    readFileSync(join(homedir(), ".mykey", "custody", "staging", "openbao-init.json"), "utf8"),
  ) as { recovery_keys_base64?: string[] };
  const key = answer.recovery_keys_base64?.[0];
  if (key === undefined) throw new Error("custody copy has no recovery key");
  registerSecret(key);
  return key;
}

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

  it("host reboot unseals alone", async () => {
    // Never reboot with a firewall or SSH revert pending.
    expect((await staging.status()).pendingRevert).toEqual([]);
    const before = await openbaoProcess();
    const started = Date.now();
    const { secondsUntilSsh } = await staging.reboot();
    // No command on the host: only the public endpoint is asked.
    while ((await publicHealth()) !== 200) {
      if (Date.now() - started > 300_000)
        throw new Error("/health not 200 within 300 s of the reboot");
      await sleep(2_000);
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    record(
      `host reboot: ssh back after ${secondsUntilSsh} s, public /health 200 after ${seconds} s`,
    );
    expect(seconds).toBeLessThanOrEqual(300);
    await expectNewProcess(before);
    expect(await readSecret()).toBe(secret.value);
  }, 900_000);

  it("KMS away at start: stays sealed, says 503, recovers alone", async () => {
    const before = await openbaoProcess();
    expectSuccess(await sshExec(staging.host, `${EGRESS} block kms 240`, { sudo: true }), "block");
    const blockedAt = Date.now();
    expectSuccess(
      await sshExec(staging.host, `docker restart ${CONTAINER}`, {
        sudo: true,
        timeoutMs: 120_000,
      }),
      "docker restart",
    );
    const window = {
      unsealed: false,
      saw503: false,
      recoveryUnsealed: false,
      statusFlagged: false,
    };
    const recoveryKey = custodyRecoveryKey();
    while (Date.now() - blockedAt < 90_000) {
      const status = await sealStatus();
      if (status?.sealed === false) window.unsealed = true;
      if ((await publicHealth()) === 503) window.saw503 = true;
      // FR-1.64, no silent manual-key fallback: the recovery key cannot unseal.
      const unseal = await baoFetch(asStack(), "/v1/sys/unseal", {
        method: "POST",
        token: "",
        body: { key: recoveryKey },
      }).catch(() => undefined);
      if (unseal?.status === 200) {
        const body = (await unseal.json()) as { sealed?: boolean };
        if (body.sealed === false) window.recoveryUnsealed = true;
      }
      await sleep(5_000);
    }
    const host = await staging.status();
    window.statusFlagged = host.sealed !== false || host.kmsReachable === false;
    const during = await openbaoProcess();
    record(
      `KMS away at start: restarts ${before.restarts} -> ${during.restarts}, sealed throughout ${!window.unsealed}, public 503 seen ${window.saw503}, status sealed=${String(host.sealed)} kmsReachable=${String(host.kmsReachable)}`,
    );
    expect(window).toEqual({
      unsealed: false,
      saw503: true,
      recoveryUnsealed: false,
      statusFlagged: true,
    });

    // The kernel lifts the block after 240 s; nothing is typed.
    const remaining = 240_000 - (Date.now() - blockedAt);
    if (remaining > 0) await sleep(remaining);
    const ms = await waitUnsealedAndReadable(240);
    record(
      `KMS away at start: unsealed and readable ${ms} ms after the block ended, with no command`,
    );
  }, 900_000);

  it("KMS away while running: still serving, separately visible", async () => {
    await waitUnsealedAndReadable(60);
    expectSuccess(await sshExec(staging.host, `${EGRESS} block kms 420`, { sudo: true }), "block");
    const blockedAt = Date.now();
    await sleep(15_000);
    // Reads and writes go on: the seal key is not needed while unsealed.
    const value = `synthetic-${Date.now()}`;
    const write = await baoFetch(asStack(), `/v1/kv/data/${secret.path}`, {
      method: "POST",
      namespace: org.namespace,
      body: { options: { cas: 1 }, data: { value } },
    });
    expect(write.status).toBe(200);
    secret.value = value;
    expect(await readSecret()).toBe(value);
    const host = await staging.status();
    expect({ sealed: host.sealed, kmsReachable: host.kmsReachable }).toEqual({
      sealed: false,
      kmsReachable: false,
    });
    expect(await publicHealth()).toBe(200);

    // The probe tells the two apart: kms_unreachable, not openbao_sealed. It opens after three
    // minutes of bad reports, and the first bad report can come a minute after the block, with
    // the cron's minute on top: 255 to 292 s on staging (Sessions 2 to 8). The block outlasts
    // the window, so the condition is still open when it is looked for.
    let opened: ProbeView | undefined;
    while (Date.now() - blockedAt < 410_000 && opened === undefined) {
      const current = await probeView().catch(() => undefined);
      if (current?.state.open.kms_unreachable !== undefined) opened = current;
      else await sleep(15_000);
    }
    expect(opened?.state.open.kms_unreachable).toBeDefined();
    expect(opened?.state.open.openbao_sealed).toBeUndefined();
    record(
      `KMS away while running: writes and reads OK, status kmsReachable=false sealed=false, probe opened kms_unreachable after ${Math.round(((opened?.state.open.kms_unreachable?.openedAt ?? 0) - blockedAt) / 1000)} s`,
    );

    let resolved = false;
    while (Date.now() - blockedAt < 900_000 && !resolved) {
      const current = await probeView().catch(() => undefined);
      resolved = current !== undefined && current.state.open.kms_unreachable === undefined;
      if (!resolved) await sleep(15_000);
    }
    expect(resolved).toBe(true);
    record(
      `KMS away while running: kms_unreachable resolved ${Math.round((Date.now() - blockedAt) / 1000)} s after the block began (block 420 s)`,
    );
  }, 1_200_000);
});

// FR-1.65 / AC-1.26 (after sitting 2): the policy lost create and activate,
// the current certificate (STAGING_SEAL_CERT) was issued from a key made on the host.
describe("certificate replacement", () => {
  const KMS_DIR = "/etc/mykey/secrets/kms";

  it("rights are what was granted", async () => {
    const create = await sshExec(
      staging.host,
      okmsCommand(STAGING_SEAL_CERT, [
        "kmip",
        "create",
        "symmetric",
        "--alg",
        "AES",
        "--size",
        "256",
        "--name",
        `mykey-rights-probe-${Date.now()}`,
      ]),
      { sudo: true, timeoutMs: 120_000 },
    );
    expect(create.code).not.toBe(0);
    const locate = await sshExec(staging.host, okmsCommand(STAGING_SEAL_CERT, ["kmip", "locate"]), {
      sudo: true,
      timeoutMs: 120_000,
    });
    expect(locate.code).toBe(0);
    record(
      `rights: kmip create with the seal certificate refused (${(create.stdout + create.stderr).replace(/\s+/g, " ").slice(-160)}); kmip locate works`,
    );
  }, 300_000);

  // Review (Run 10.6): after the replacement, only the short branch can run, and it
  // claims only that the current certificate unseals after a restart. It records
  // which branch ran. The deleted-certificate half was proven at the replacement
  // it names (staging-seal-1 → -2, 12 Nov 2026, docs/evidence/session-2/unseal-staging.txt); seal-2 → seal-3 came
  // with a reinstall that took seal-2's key, so it had no such half.
  it("a deleted certificate cannot unseal; a reissued one can", async () => {
    const onSecond =
      expectSuccess(
        await sshExec(
          staging.host,
          `if [ "$(readlink ${KMS_DIR}/seal.key)" = ${STAGING_SEAL_CERT}.key ]; then echo yes; else echo no; fi`,
          { sudo: true, secretOutput: true },
        ),
        "reading the seal link",
      ).stdout.trim() === "yes";
    if (onSecond) {
      // Replaced by an earlier run: the old key is gone and the current certificate unseals.
      expectSuccess(
        await sshExec(staging.host, `test ! -e ${KMS_DIR}/${STAGING_SEAL_CERT_PREVIOUS}.key`, {
          sudo: true,
          secretOutput: true,
        }),
        "the old key is gone",
      );
      const before = await openbaoProcess();
      expectSuccess(
        await sshExec(staging.host, `docker restart ${CONTAINER}`, {
          sudo: true,
          timeoutMs: 120_000,
        }),
        "docker restart",
      );
      await expectNewProcess(before);
      await waitUnsealedAndReadable(120);
      record(
        `certificate replacement: already done; the current certificate ${STAGING_SEAL_CERT} unseals after a restart (the deleted-certificate half not run)`,
      );
      return;
    }

    // The long branch needs the previous key on the host: without it okms fails
    // for that reason alone, which would pass for "deleted in the console".
    expectSuccess(
      await sshExec(staging.host, `test -s ${KMS_DIR}/${STAGING_SEAL_CERT_PREVIOUS}.key`, {
        sudo: true,
        secretOutput: true,
      }),
      `the previous key ${STAGING_SEAL_CERT_PREVIOUS} is on the host`,
    );

    // The owner deleted the previous certificate in the console: the KMS refuses it.
    const old = await sshExec(
      staging.host,
      okmsCommand(STAGING_SEAL_CERT_PREVIOUS, ["kmip", "locate"]),
      {
        sudo: true,
        timeoutMs: 120_000,
      },
    );
    expect(old.code, `${STAGING_SEAL_CERT_PREVIOUS} must be deleted in the console first`).not.toBe(
      0,
    );

    // Restarted on the deleted certificate: stays sealed, says 503.
    const before = await openbaoProcess();
    expectSuccess(
      await sshExec(staging.host, `docker restart ${CONTAINER}`, {
        sudo: true,
        timeoutMs: 120_000,
      }),
      "docker restart",
    );
    await expectNewProcess(before);
    let unsealed = false;
    let saw503 = false;
    const started = Date.now();
    while (Date.now() - started < 60_000) {
      if ((await sealStatus())?.sealed === false) unsealed = true;
      if ((await publicHealth()) === 503) saw503 = true;
      await sleep(5_000);
    }
    const restarts = (await openbaoProcess()).restarts;
    record(
      `deleted certificate ${STAGING_SEAL_CERT_PREVIOUS}: sealed throughout ${!unsealed}, public 503 seen ${saw503}, restart count ${restarts}`,
    );
    expect({ unsealed, saw503 }).toEqual({ unsealed: false, saw503: true });

    // Switch to the reissued certificate: nothing of the old one is needed.
    expectSuccess(
      await sshExec(staging.host, kmsUseCommand(STAGING_SEAL_CERT), {
        sudo: true,
        secretOutput: true,
      }),
      `kms-use ${STAGING_SEAL_CERT}`,
    );
    expectSuccess(
      await sshExec(staging.host, `docker restart ${CONTAINER}`, {
        sudo: true,
        timeoutMs: 120_000,
      }),
      "docker restart",
    );
    const ms = await waitUnsealedAndReadable(180);
    expectSuccess(
      await sshExec(staging.host, kmsRemoveCommand(STAGING_SEAL_CERT_PREVIOUS), {
        sudo: true,
        secretOutput: true,
      }),
      "shredding the old key",
    );
    record(
      `reissued certificate ${STAGING_SEAL_CERT}: unsealed and readable ${ms} ms after the restart; ${STAGING_SEAL_CERT_PREVIOUS} key shredded`,
    );
  }, 900_000);
});
