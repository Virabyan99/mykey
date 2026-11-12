// Run 2.7 dated checkpoint `kms-cert-expiry` (AC-1.26, expired half): the
// instance prepared by key-loss.staging.test.ts on key L-B with certificate
// losstest-1day. Left out of the default staging run until the checkpoint is
// due (vitest.config.ts reads docs/evidence/session-2/kms-checkpoints.json);
// called directly before then it fails with "checkpoint not due".
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readDrillSecret,
  spikeCompose,
  start,
  staysSealed,
  waitUnsealed,
  onHost,
  type SpikeInstance,
} from "../harness/kms-spike.ts";
import { connectStaging, type StagingStack } from "../harness/staging.ts";

interface Checkpoint {
  id: string;
  notBefore: string;
  instance: { name: string; address: string; keyB: string };
  secretSha256: string;
}

const checkpoint = (
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../docs/evidence/session-2/kms-checkpoints.json"),
      "utf8",
    ),
  ) as Checkpoint[]
).find((entry) => entry.id === "kms-cert-expiry");
/** The losstest certificate valid at the checkpoint (see the checkpoint's `needs`). */
const VALID_CERT = process.env.MYKEY_LOSSTEST_CERT ?? "losstest-ops-2";

let staging: StagingStack;

beforeAll(async () => {
  if (checkpoint === undefined) throw new Error("no kms-cert-expiry checkpoint");
  if (Date.now() < Date.parse(checkpoint.notBefore)) {
    throw new Error(`checkpoint not due: kms-cert-expiry runs from ${checkpoint.notBefore}`);
  }
  staging = await connectStaging();
}, 300_000);

afterAll(async () => {
  await (staging as StagingStack | undefined)?.close();
});

describe("kms-cert-expiry checkpoint", () => {
  it("an expired certificate cannot unseal; a valid one can, and the secret reads back", async () => {
    if (checkpoint === undefined) throw new Error("no checkpoint");
    const { name, address, keyB } = checkpoint.instance;
    const expired: SpikeInstance = { name, address, cert: "losstest-1day" };
    const stack = await start(staging, expired, keyB);
    expect(await staysSealed(stack, 60)).toBe(true);
    await onHost(staging, `${spikeCompose(expired)} stop bao`, "stop expiry");

    // Same instance, tunnel and volume; only the certificate changes.
    await start(staging, { ...expired, cert: VALID_CERT }, keyB);
    await waitUnsealed(stack, 120);
    const value = await readDrillSecret(stack);
    expect(
      createHash("sha256")
        .update(value ?? "")
        .digest("hex"),
    ).toBe(checkpoint.secretSha256);
  }, 900_000);
});
