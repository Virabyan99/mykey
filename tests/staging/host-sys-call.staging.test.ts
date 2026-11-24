// Run 10.2 Task A (D-73, R4-2): generate-root's host path on staging, before
// the re-drill needs it inside its two-hour window. The root token and the
// recovery key come from staging's custody copy; both are registered for
// redaction, travel on stdin only and are never written. The new root token is
// checked (root policy) and revoked by its accessor at once; any attempt is
// cancelled in `finally`.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { hostSysCall } from "../../scripts/host.ts";
import { custodyCopyPath, generateRoot, recoveryKeyOf } from "../../scripts/host-custody.ts";
import { loadHosts, registerSecret } from "../harness/staging.ts";

const host = loadHosts().staging;
const answer = readFileSync(custodyCopyPath("staging"), "utf8");
const rootToken = (JSON.parse(answer) as { root_token: string }).root_token;
registerSecret(rootToken);
const recoveryKey = recoveryKeyOf(answer);
registerSecret(recoveryKey);
const call = hostSysCall(host, "vpn", rootToken);

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

let madeAccessor: string | null = null;

afterAll(async () => {
  if (madeAccessor !== null) {
    await call("POST", "auth/token/revoke-accessor", { accessor: madeAccessor }).catch(
      () => undefined,
    );
  }
  await call("DELETE", "sys/generate-root-token/attempt").catch(() => undefined);
});

describe("generate-root's host path on staging", () => {
  it("cancelling an attempt answers 2xx through the host path, with the custody root token", async () => {
    const cancelled = await call("DELETE", "sys/generate-root-token/attempt");
    expect([200, 204]).toContain(cancelled.status);
  }, 60_000);

  it("generateRoot(hostSysCall(…), recoveryKey) returns a token whose lookup holds the root policy; it is revoked by its accessor at once, and afterwards OpenBao refuses it", async () => {
    const made = await generateRoot(call, recoveryKey);
    registerSecret(made);
    const looked = await call("POST", "auth/token/lookup", { token: made });
    expect(looked.status).toBe(200);
    const data = fields(fields(looked.body).data);
    expect(data.policies).toContain("root");
    expect(typeof data.accessor).toBe("string");
    madeAccessor = data.accessor as string;
    const revoked = await call("POST", "auth/token/revoke-accessor", { accessor: madeAccessor });
    expect([200, 204]).toContain(revoked.status);
    madeAccessor = null;
    const after = await call("POST", "auth/token/lookup", { token: made });
    expect(after.status).not.toBe(200);
    // No attempt is left open: a cancel finds nothing to refuse.
    const cancelled = await call("DELETE", "sys/generate-root-token/attempt");
    expect([200, 204]).toContain(cancelled.status);
  }, 120_000);
});
