// Run 2.7 Step 7 (KMS-L1): what is lost with the seal key, on disposable
// OpenBao instances in the losstest KMS domain (tests/harness/kms-spike.ts).
// Needs `host.ts staging kms-import losstest-ops …` and `… losstest-1day …`
// first. Nothing here touches the staging seal key or the staging OpenBao.
// The expiry instance and its checkpoint are kept for the dated check
// (tests/staging/kms-expiry.staging.test.ts, docs/evidence/session-2/kms-checkpoints.json).
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createKey,
  destroy,
  init,
  okms,
  onHost,
  readDrillSecret,
  sealStatus,
  spikeCompose,
  start,
  staysSealed,
  writeDrillSecret,
  type SpikeInstance,
} from "../harness/kms-spike.ts";
import { baoFetch } from "../harness/stack.ts";
import { connectStaging, type StagingStack } from "../harness/staging.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const EVIDENCE = join(ROOT, "docs/evidence/session-2/key-loss-staging.txt");
const CHECKPOINTS = join(ROOT, "docs/evidence/session-2/kms-checkpoints.json");
/** losstest-1day as issued by the console (30 days, the only choice; ruling R66). */
const EXPIRY_CERT_NOT_AFTER = "2026-12-12T09:47:34Z";
const EXPIRY_CUSTODY = join(homedir(), ".mykey", "custody", "staging", "spike-expiry-init.json");

let staging: StagingStack;
const disposable: SpikeInstance[] = [];

function record(line: string): void {
  appendFileSync(EVIDENCE, `${new Date().toISOString()} ${line}\n`);
}

beforeAll(async () => {
  staging = await connectStaging();
  if (!existsSync(EVIDENCE)) {
    writeFileSync(EVIDENCE, "# Run 2.7 key-loss drill on staging (appended)\n");
  }
  // Precondition: both losstest certificates are on the host and their rights work.
  await okms(staging, "losstest-ops", ["kmip", "locate"]);
  await okms(staging, "losstest-1day", ["kmip", "locate"]);
}, 300_000);

afterAll(async () => {
  for (const instance of disposable) await destroy(staging, instance);
  await (staging as StagingStack | undefined)?.close();
}, 600_000);

describe("seal key lost (KMS-L1)", () => {
  it("is unrecoverable: no restart, no other key, no recovery key and no snapshot brings the data back", async () => {
    const stamp = Date.now();
    const keyA = await createKey(staging, "losstest-ops", `mykey-losstest-A-${stamp}`);
    const keyC = await createKey(staging, "losstest-ops", `mykey-losstest-C-${stamp}`);
    record(`keys created and activated: L-A ${keyA}, L-C ${keyC}`);

    // An instance on L-A with one synthetic secret and a Raft snapshot.
    const losstest: SpikeInstance = {
      name: "losstest",
      address: "10.78.4.5",
      cert: "losstest-ops",
    };
    disposable.push(losstest);
    const stack = await start(staging, losstest, keyA);
    const answer = await init(stack);
    const value = `synthetic-${stamp}`;
    await writeDrillSecret(stack, value);
    const snapshotResponse = await baoFetch(stack, "/v1/sys/storage/raft/snapshot");
    expect(snapshotResponse.status).toBe(200);
    const snapshot = new Uint8Array(await snapshotResponse.arrayBuffer());
    record(`losstest: initialised on L-A, secret written, snapshot ${snapshot.length} bytes`);

    // The seal key goes away for good.
    await onHost(staging, `${spikeCompose(losstest)} stop bao`, "stop losstest");
    await okms(staging, "losstest-ops", [
      "kmip",
      "revoke",
      keyA,
      "--reason",
      "CessationOfOperation",
      "--force",
    ]);
    await okms(staging, "losstest-ops", ["kmip", "destroy", keyA, "--force"]);
    record(`L-A ${keyA} revoked and destroyed`);

    await onHost(staging, `${spikeCompose(losstest)} start bao`, "start losstest");
    expect(await staysSealed(stack, 60)).toBe(true);
    record("losstest restarted with L-A destroyed: never unsealed in 60 s");

    // A healthy key that is not the one used does not help.
    await start(staging, losstest, keyC);
    expect(await staysSealed(stack, 60)).toBe(true);
    record("losstest reconfigured to L-C: never unsealed in 60 s");

    // The recovery key authorises operations; it decrypts nothing.
    const unseal = await baoFetch(stack, "/v1/sys/unseal", {
      method: "POST",
      token: "",
      body: { key: answer.recovery_keys_base64[0] },
    }).catch(() => undefined);
    const unsealed =
      unseal?.status === 200 && ((await unseal.json()) as { sealed?: boolean }).sealed === false;
    expect(unsealed).toBe(false);
    record(`recovery key on sys/unseal: HTTP ${unseal?.status ?? "no answer"}, not unsealed`);
    await onHost(staging, `${spikeCompose(losstest)} stop bao`, "stop losstest");

    // A fresh instance on L-C given the snapshot: refused, or the data stays unreadable.
    const restore: SpikeInstance = { name: "restore", address: "10.78.4.6", cert: "losstest-ops" };
    disposable.push(restore);
    const fresh = await start(staging, restore, keyC);
    await init(fresh);
    const plain = await baoFetch(fresh, "/v1/sys/storage/raft/snapshot", {
      method: "POST",
      body: snapshot,
    });
    const forced = await baoFetch(fresh, "/v1/sys/storage/raft/snapshot-force", {
      method: "POST",
      body: snapshot,
    }).catch(() => undefined);
    let readable = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !readable) {
      readable = (await readDrillSecret(fresh)) === value;
      if (!readable) await new Promise((wait) => setTimeout(wait, 3_000));
    }
    const after = await sealStatus(fresh);
    record(
      `restore on L-C: snapshot HTTP ${plain.status}, snapshot-force HTTP ${forced?.status ?? "no answer"}, afterwards sealed=${String(after?.sealed)}, secret readable=${readable}`,
    );
    expect(readable).toBe(false);
    record(
      "KMS-L1 SPIKE_PASS — seal key lost: UNRECOVERABLE, as Doc 04 says; a backup pair is only as recoverable as its seal key",
    );
  }, 1_800_000);
});

describe("certificate expiry (dated checkpoint)", () => {
  it("prepares an instance on L-B with the short certificate and records the checkpoint", async () => {
    if (existsSync(EXPIRY_CUSTODY)) {
      // Prepared by an earlier run: the checkpoint and the kept volume must still be there.
      expect(existsSync(CHECKPOINTS)).toBe(true);
      await onHost(staging, "docker volume inspect mykey-spike-expiry-data", "expiry volume");
      return;
    }
    const keyB = await createKey(staging, "losstest-ops", `mykey-losstest-B-${Date.now()}`);
    // Not in `disposable`: the instance and its volume stay for the checkpoint.
    const expiry: SpikeInstance = { name: "expiry", address: "10.78.4.7", cert: "losstest-1day" };
    const stack = await start(staging, expiry, keyB);
    const answer = await init(stack);
    mkdirSync(dirname(EXPIRY_CUSTODY), { recursive: true, mode: 0o700 });
    writeFileSync(EXPIRY_CUSTODY, JSON.stringify({ ...answer, keyB }), { mode: 0o600, flag: "wx" });
    const value = `synthetic-expiry-${Date.now()}`;
    await writeDrillSecret(stack, value);
    expect(await readDrillSecret(stack)).toBe(value);
    await onHost(staging, `${spikeCompose(expiry)} stop bao`, "stop expiry");
    await expiry.tunnel?.close();

    const notBefore = new Date(Date.parse(EXPIRY_CERT_NOT_AFTER) + 10 * 60_000).toISOString();
    writeFileSync(
      CHECKPOINTS,
      `${JSON.stringify(
        [
          {
            id: "kms-cert-expiry",
            notBefore,
            file: "tests/staging/kms-expiry.staging.test.ts",
            command:
              "MYKEY_CHECKPOINT=kms-cert-expiry pnpm run test:staging tests/staging/kms-expiry.staging.test.ts",
            expects:
              "start with the expired certificate stays sealed; start with a valid losstest certificate unseals and the secret reads back",
            needs:
              "a losstest-domain certificate valid at that time (losstest-ops also expires on 12 Dec 2026): issue losstest-ops-2 from a new CSR and kms-import it",
            instance: { name: "expiry", address: "10.78.4.7", keyB },
            secretSha256: await sha256(value),
          },
        ],
        null,
        2,
      )}\n`,
    );
    record(
      `expiry: instance on L-B ${keyB} with losstest-1day initialised, secret written, stopped; checkpoint not before ${notBefore}`,
    );
  }, 900_000);
});

async function sha256(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}
