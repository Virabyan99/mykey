// Run 11.5 Task D (Session 11, P-190, D-82; spec §4 and §6 item 11): what a
// restore leaves of the two new kinds, and what brings the consumers back.
//
// A restore revokes every credential row (D-55). This file applies that step
// (`revokeEveryCredential`, the function restoreInvalidate runs in its
// transaction) to a product with three provisioned tenants, and then recovers
// them the way the runbook says: the owner issues ONE automation credential
// that `replaces` the lost one, and the script re-issues a runtime credential
// for every environment, with no further person.
//
// The whole command on a really restored product (new cluster, new OpenBao,
// the owner's recovery, the gate) is tests/integration/restore: invalidate
// asserts both tables, full replays this recovery behind the reopened gate.
//
// Secrets and tokens are locals and never appear in an assertion message.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { AUTOMATION_RIGHTS } from "@mykey/contracts";
import { withTransaction } from "@mykey/db";
import { revokeEveryCredential } from "@mykey/ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  provision,
  reissue,
  type Provisioned,
  type ProvisionerApi,
} from "../../fixtures/automation/tenant-provisioner.ts";
import {
  automationCall,
  issueAutomationFor,
  type IssuedAutomation,
} from "../../harness/automation.ts";
import {
  createCredentialsFixture,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import {
  digestOf,
  exchangeCall,
  machineFetch,
  machinePath,
  resolveDigests,
} from "../../harness/machine.ts";
import { measure } from "../../harness/measure.ts";

const TENANTS = 3;
const COUNT = 25;
const ENVIRONMENT = "production";

interface Tenant {
  name: string;
  secrets: Record<string, string>;
  made: Provisioned;
}

let f: CredentialsFixture;
let provisioner: { stop(): Promise<void> };
let api: ProvisionerApi;
let lost: IssuedAutomation;
const tenants: Tenant[] = [];

const q = () => f.api.superuser;

const resolve = (projectId: string, envName: string, token: string) =>
  machineFetch(
    { port: f.api.port, ca: readFileSync(f.stack.api.certAuthorityPath) },
    "POST",
    machinePath(projectId, envName, "resolve"),
    { token },
  );

const notRevoked = async (): Promise<{ machine: string; automation: string }> =>
  (
    await q().query<{ machine: string; automation: string }>(
      `SELECT (SELECT count(*) FROM app.machine_credential WHERE state <> 'revoked')::text AS machine,
              (SELECT count(*) FROM app.automation_credential WHERE state <> 'revoked')::text AS automation`,
    )
  ).rows[0]!;

beforeAll(async () => {
  f = await createCredentialsFixture();
  provisioner = await f.fx.start();
  api = {
    baseUrl: `https://127.0.0.1:${String(f.api.port)}`,
    ca: readFileSync(f.stack.api.certAuthorityPath),
  };
  lost = await issueAutomationFor(f, { name: "before the restore", rights: AUTOMATION_RIGHTS });
  for (let index = 0; index < TENANTS; index += 1) {
    const name = `Tenant ${String(index)} ${randomUUID().slice(0, 8)}`;
    const secrets: Record<string, string> = {};
    for (let n = 0; n < COUNT; n += 1) {
      secrets[`T${String(index)}_${String(n).padStart(2, "0")}`] = `synthetic-${randomUUID()}`;
    }
    const made = await provision(api, lost.secret, { tenant: name, secrets });
    tenants.push({ name, secrets, made });
  }
}, 900_000);

afterAll(async () => {
  await (provisioner as { stop(): Promise<void> } | undefined)?.stop();
  await (f as CredentialsFixture | undefined)?.close();
});

describe("after a restore (spec §4)", () => {
  it("three provisioned tenants; the restore's revocation; every automation and runtime credential is revoked and every exchange answers 401; the owner issues one automation credential with replaces; the script's reissue lists the three projects and issues a runtime credential for every environment; each new one exchanges and resolves; the time is recorded", async () => {
    // Before: every tenant's server starts.
    const oldTokens: string[] = [];
    for (const tenant of tenants) {
      const exchanged = await exchangeCall(f, { secret: tenant.made.clientSecret });
      expect(exchanged.status, `before: ${exchanged.code ?? ""}`).toBe(200);
      oldTokens.push(exchanged.body.token as string);
    }
    expect(await notRevoked()).toEqual({ machine: String(TENANTS), automation: "1" });

    // The restore's step (D-55): both tables, in one transaction.
    const revoked = await withTransaction(
      f.api.database.pool("maintenance"),
      revokeEveryCredential,
    );
    expect(revoked).toBe(TENANTS + 1);
    expect(await notRevoked()).toEqual({ machine: "0", automation: "0" });

    // Everything issued before is refused: the client secrets, the tokens they
    // had exchanged, and the automation credential itself.
    for (const [index, tenant] of tenants.entries()) {
      const exchange = await exchangeCall(f, { secret: tenant.made.clientSecret });
      expect([exchange.status, exchange.code], tenant.name).toEqual([401, "unauthenticated"]);
      const read = await resolve(tenant.made.projectId, ENVIRONMENT, oldTokens[index]!);
      expect([read.status, read.code], tenant.name).toEqual([401, "unauthenticated"]);
    }
    const old = await automationCall(f, "automation.projects.list", { secret: lost.secret });
    expect([old.status, old.code]).toEqual([401, "unauthenticated"]);
    await expect(reissue(api, lost.secret)).rejects.toMatchObject({
      status: 401,
      code: "unauthenticated",
    });

    // The control: a new credential that replaces nothing is a new chain. It manages no project.
    const stranger = await issueAutomationFor(f, {
      name: "a new chain",
      rights: AUTOMATION_RIGHTS,
    });
    expect(stranger.ownerId).toBe(stranger.credentialId);
    const none = await reissue(api, stranger.secret);
    expect([none.projects, none.issued.length]).toEqual([0, 0]);

    // The recovery: one action of the owner, then the script alone.
    const startedAt = performance.now();
    const successor = await issueAutomationFor(f, {
      name: "after the restore",
      rights: AUTOMATION_RIGHTS,
      replaces: lost.credentialId,
    });
    expect(successor.ownerId).toBe(lost.ownerId);
    const again = await reissue(api, successor.secret);
    expect(again.projects).toBe(TENANTS);
    // Every environment of every project: `development`, made with the project, and the tenant's own.
    expect(again.issued).toHaveLength(TENANTS * 2);
    expect(new Set(again.issued.map((one) => one.projectId))).toEqual(
      new Set(tenants.map((tenant) => tenant.made.projectId)),
    );

    const names = await q().query<{ id: string; name: string }>(
      "SELECT id, name FROM app.environment WHERE id = ANY ($1::uuid[])",
      [again.issued.map((one) => one.environmentId)],
    );
    const nameOf = new Map(names.rows.map((row) => [row.id, row.name]));
    let resolved = 0;
    for (const one of again.issued) {
      const tenant = tenants.find((candidate) => candidate.made.projectId === one.projectId)!;
      const envName = nameOf.get(one.environmentId) ?? "";
      const exchanged = await exchangeCall(f, { secret: one.clientSecret });
      expect(exchanged.status, `${tenant.name} ${envName}: ${exchanged.code ?? ""}`).toBe(200);
      const read = await resolve(one.projectId, envName, exchanged.body.token as string);
      expect(read.status, `${tenant.name} ${envName}: ${read.code ?? ""}`).toBe(200);
      expect(read.body.complete).toBe(true);
      const expected =
        one.environmentId === tenant.made.environmentId
          ? Object.entries(tenant.secrets)
              .map(([name, value]): [string, string] => [name, digestOf(value)])
              .sort(([a], [b]) => (a < b ? -1 : 1))
          : [];
      expect(resolveDigests(read), `${tenant.name} ${envName}`).toEqual(expected);
      resolved += 1;
    }
    const seconds = (performance.now() - startedAt) / 1000;
    expect(resolved).toBe(TENANTS * 2);
    measure("automation_recovery_seconds", Math.round(seconds * 10) / 10);
    measure("automation_recovery_credentials", again.issued.length);
    // One issuance and a script: far inside the restore's own window.
    expect(seconds).toBeLessThan(120);

    // What the restore revoked stays revoked: the recovery made new rows.
    for (const tenant of tenants) {
      const exchange = await exchangeCall(f, { secret: tenant.made.clientSecret });
      expect(exchange.status, tenant.name).toBe(401);
    }
    const rows = await q().query<{ issued_by: string; issued_by_kind: string }>(
      "SELECT issued_by, issued_by_kind FROM app.machine_credential WHERE state = 'active'",
    );
    expect(rows.rows).toHaveLength(TENANTS * 2);
    for (const row of rows.rows) {
      expect(row).toEqual({ issued_by: successor.credentialId, issued_by_kind: "machine" });
    }
  }, 300_000);
});
