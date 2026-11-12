// Disposable OpenBao instances on staging for the KMS key-loss and expiry
// tests (Run 2.7 Step 7): infra/compose/host-kms-spike.compose.yml, one Compose
// project per instance, the same OpenBao image and configuration template as
// the real service, keys and certificates of the losstest KMS domain only.
import { setTimeout as sleep } from "node:timers/promises";
import { okmsCommand, renderOpenBaoConfig } from "../../scripts/host.ts";
import { baoFetch, type Stack } from "./stack.ts";
import {
  expectSuccess,
  openTunnel,
  registerSecret,
  sshExec,
  type StagingStack,
  type Tunnel,
} from "./staging.ts";

const KMS_HOST = "us-east-vin.okms.ovh.us";
const SPIKE_FILE = "/opt/mykey/compose/host-kms-spike.compose.yml";

export interface SpikeInstance {
  name: string;
  /** On the KMS bridge, 10.78.4.5 to 10.78.4.7. */
  address: string;
  /** Certificate name in /etc/mykey/secrets/kms. */
  cert: string;
  tunnel?: Tunnel;
  stack?: Stack;
}

export async function onHost(
  staging: StagingStack,
  command: string,
  what: string,
  timeoutMs = 180_000,
): Promise<string> {
  return expectSuccess(await sshExec(staging.host, command, { sudo: true, timeoutMs }), what)
    .stdout;
}

export function okms(staging: StagingStack, cert: string, args: string[]): Promise<string> {
  return onHost(staging, okmsCommand(cert, args), `okms ${args.slice(0, 2).join(" ")}`);
}

/** A new active AES-256 key (not extractable) in the certificate's domain; returns its id. */
export async function createKey(
  staging: StagingStack,
  cert: string,
  name: string,
): Promise<string> {
  const output = await okms(staging, cert, [
    "kmip",
    "create",
    "symmetric",
    "--alg",
    "AES",
    "--size",
    "256",
    "--usage",
    "Encrypt,Decrypt",
    "--name",
    name,
    "--extractable=false",
    "--sensitive",
  ]);
  const id = /Key created with ID ([0-9a-f-]{36})/.exec(output)?.[1];
  if (id === undefined) throw new Error(`okms create ${name}: no key id`);
  await okms(staging, cert, ["kmip", "activate", id]);
  return id;
}

export function spikeCompose(instance: SpikeInstance): string {
  return `SPIKE=${instance.name} SPIKE_CERT=${instance.cert} SPIKE_ADDRESS=${instance.address} docker compose -f ${SPIKE_FILE} -p mykey-spike-${instance.name}`;
}

/** Renders the instance's configuration with the given seal key. */
export async function configure(
  staging: StagingStack,
  instance: SpikeInstance,
  keyId: string,
): Promise<void> {
  const config = renderOpenBaoConfig({
    host: `spike-${instance.name}`,
    kmsHost: KMS_HOST,
    sealKeyId: keyId,
    maxRequestDuration: "15s",
  });
  expectSuccess(
    await sshExec(
      staging.host,
      `install -d -m 0755 /etc/mykey/openbao && install -m 0644 /dev/stdin /etc/mykey/openbao/spike-${instance.name}.hcl`,
      { sudo: true, stdin: config },
    ),
    "installing the spike configuration",
  );
}

/** Configures, starts (or restarts with the new settings) and tunnels to the instance. */
export async function start(
  staging: StagingStack,
  instance: SpikeInstance,
  keyId: string,
): Promise<Stack> {
  await configure(staging, instance, keyId);
  await onHost(
    staging,
    `${spikeCompose(instance)} up -d --force-recreate bao`,
    `up ${instance.name}`,
  );
  instance.tunnel ??= await openTunnel(staging.host, { address: instance.address, port: 8200 });
  instance.stack ??= {
    bao: {
      url: `https://127.0.0.1:${instance.tunnel.localPort}`,
      caCertPath: staging.bao.caCertPath,
      rootToken: "",
    },
  } as unknown as Stack;
  return instance.stack;
}

/** Stops and removes the instance with its volumes and configuration. */
export async function destroy(staging: StagingStack, instance: SpikeInstance): Promise<void> {
  await instance.tunnel?.close().catch(() => undefined);
  await sshExec(staging.host, `${spikeCompose(instance)} down -v`, {
    sudo: true,
    timeoutMs: 180_000,
  }).catch(() => undefined);
  await sshExec(staging.host, `rm -f /etc/mykey/openbao/spike-${instance.name}.hcl`, {
    sudo: true,
  }).catch(() => undefined);
}

export async function sealStatus(stack: Stack): Promise<Record<string, unknown> | undefined> {
  const response = await baoFetch(stack, "/v1/sys/seal-status", { token: "" }).catch(
    () => undefined,
  );
  return response?.status === 200
    ? ((await response.json()) as Record<string, unknown>)
    : undefined;
}

export async function waitFor<T>(
  seconds: number,
  what: string,
  check: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${seconds} s`);
    await sleep(2_000);
  }
}

/** True when, for the whole window, the instance never reported itself unsealed. */
export async function staysSealed(stack: Stack, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if ((await sealStatus(stack))?.sealed === false) return false;
    await sleep(3_000);
  }
  return true;
}

export interface InitAnswer {
  root_token: string;
  recovery_keys_base64: string[];
}

/** sys/init with one recovery share; waits until active. The answer's secrets are registered. */
export async function init(stack: Stack): Promise<InitAnswer> {
  await waitFor(120, "listener", async () =>
    (await sealStatus(stack)) === undefined ? undefined : true,
  );
  const response = await baoFetch(stack, "/v1/sys/init", {
    method: "PUT",
    token: "",
    body: { recovery_shares: 1, recovery_threshold: 1 },
  });
  if (response.status !== 200) throw new Error(`init: HTTP ${response.status}`);
  const answer = (await response.json()) as InitAnswer;
  registerSecret(answer.root_token);
  for (const key of answer.recovery_keys_base64) registerSecret(key);
  stack.bao.rootToken = answer.root_token;
  await waitUnsealed(stack, 120);
  return answer;
}

export async function waitUnsealed(stack: Stack, seconds: number): Promise<void> {
  await waitFor(seconds, "active", async () => {
    const health = await baoFetch(stack, "/v1/sys/health", { token: "" });
    return health.status === 200 ? true : undefined;
  });
}

/** KV v2 at `kv` in the root namespace, then one value at `kv/drill`. */
export async function writeDrillSecret(stack: Stack, value: string): Promise<void> {
  const mount = await baoFetch(stack, "/v1/sys/mounts/kv", {
    method: "POST",
    body: { type: "kv", options: { version: "2" } },
  });
  if (mount.status !== 204) throw new Error(`mount kv: HTTP ${mount.status}`);
  await waitFor(30, "kv write", async () => {
    const write = await baoFetch(stack, "/v1/kv/data/drill", {
      method: "POST",
      body: { data: { value } },
    });
    return write.status === 200 ? true : undefined;
  });
}

export async function readDrillSecret(stack: Stack): Promise<string | undefined> {
  const read = await baoFetch(stack, "/v1/kv/data/drill").catch(() => undefined);
  if (read?.status !== 200) return undefined;
  return ((await read.json()) as { data?: { data?: { value?: string } } }).data?.data?.value;
}
