// Run 6.9 Task B (P-131): rolling back to 45b5c1f3cc3a (the release production
// and staging ran before Session 6) is safe for the data: that commit's API,
// started from its own checkout, works on a database migrated to the newest
// revision (0019 since Session 11: its new columns all have defaults) —
// sign-in, a secret write, a reveal, an issuance and a revocation. It reads a
// v1 gate record only (rollback across the gate's format: deploy.md). The
// first run makes the checkout (~/mykey-prev/<commit>, git worktree + pnpm
// install); later runs reuse it.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeAt, stepAt } from "@mykey/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_ORIGIN, requestTo, sessionCookieOf } from "../../harness/api.ts";
import { startApiProcess, type ApiProcess } from "../../harness/api-worker.ts";
import {
  createCredentialsFixture,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { previousCheckout } from "../../harness/previous-release.ts";

const PREVIOUS = "45b5c1f3cc3a";
let f: CredentialsFixture;
let old: ApiProcess;
let dir: string;
let ca: Buffer;

beforeAll(async () => {
  const checkout = previousCheckout(PREVIOUS);
  f = await createCredentialsFixture();
  dir = mkdtempSync(join(tmpdir(), "mykey-previous-release-"));
  const hostInstanceId = randomUUID();
  const gatePath = join(dir, "gate.json");
  // A v1 record: the only one that commit reads.
  writeFileSync(
    gatePath,
    JSON.stringify({
      version: 1,
      state: "open",
      gateEpoch: 1,
      hostInstanceId,
      writtenAt: new Date().toISOString(),
    }),
  );
  ca = readFileSync(f.stack.api.certAuthorityPath);
  old = await startApiProcess(f.api.database.targets.api_runtime, {
    keysDirectory: f.keysDirectory,
    api: {
      baseUrl: TEST_ORIGIN,
      build: PREVIOUS,
      gatePath,
      hostInstanceId,
      trustedProxy: null,
    } as unknown as Parameters<typeof startApiProcess>[1]["api"],
    tls: { certPath: f.stack.api.certPath, keyPath: f.stack.api.keyPath },
    openBao: f.stack.bao,
    secretsDirectory: f.secretsDirectory,
    entry: { path: join(checkout, "tests", "harness", "api-process.ts"), cwd: checkout },
  });
}, 1_800_000);

afterAll(async () => {
  await (old as ApiProcess | undefined)?.kill();
  await (f as CredentialsFixture | undefined)?.close();
  rmSync(dir, { recursive: true, force: true });
}, 300_000);

const call = (method: string, path: string, init: Parameters<typeof requestTo>[3] = {}) =>
  requestTo({ port: old.port, ca }, method, path, init);

describe(`the API of ${PREVIOUS} on a database at 0019 (P-131)`, () => {
  it("the schema is the new one", async () => {
    const last = await f.api.superuser.query<{ name: string }>(
      "SELECT name FROM meta.schema_migration ORDER BY name DESC LIMIT 1",
    );
    expect(last.rows[0]?.name.replace(/\.sql$/, "")).toBe("0019_automation_and_runtime");
  });

  it("sign-in, a secret write, a reveal, an issuance and a revocation succeed", async () => {
    const owner = f.tenants.credentials("ownerA");
    const signedIn = await call("POST", "/v1/auth/sign-in/email", {
      body: { email: owner.email, password: owner.password },
    });
    expect(signedIn.status).toBe(200);
    const now = new Date(Date.now() + 120_000);
    const verified = await call("POST", "/v1/auth/totp/verify", {
      body: { code: codeAt(owner.seed, stepAt(now)) },
      cookie: sessionCookieOf(signedIn),
      headers: { "x-test-now": now.toISOString() },
    });
    expect(verified.status).toBe(200);
    const cookie = sessionCookieOf(verified);

    const env = f.env("env1a").path;
    const name = `PREV_${randomBytes(5).toString("hex").toUpperCase()}`;
    const value = `previous-${randomUUID()}`;
    const written = await call("POST", `${env}/secrets`, {
      body: { name, value },
      cookie,
      headers: { "idempotency-key": randomUUID() },
    });
    expect(written.status).toBe(201);
    const revealed = await call("POST", `${env}/secrets/${name}/reveal`, { body: {}, cookie });
    expect(revealed.status).toBe(200);
    const shown = ((await revealed.json()) as { value: string }).value;
    expect(createHash("sha256").update(shown).digest("hex")).toBe(
      createHash("sha256").update(value).digest("hex"),
    );

    const issued = await call("POST", `${env}/credentials`, {
      body: { name: "previous-release", ttlSeconds: 600 },
      cookie,
      headers: { "idempotency-key": randomUUID() },
    });
    expect(issued.status).toBe(201);
    const { credentialId } = ((await issued.json()) as { credential: { credentialId: string } })
      .credential;
    const revoked = await call("POST", `${env}/credentials/${credentialId}/revoke`, {
      body: { confirmed: true },
      cookie,
      headers: { "idempotency-key": randomUUID() },
    });
    expect(revoked.status).toBe(200);
  });
});
