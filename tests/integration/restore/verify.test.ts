// Run 6.7 Task B (P-124, D-55): restoreVerify answers every required check of
// a restore; each store check, broken by the test alone, fails alone.
import { randomBytes, randomUUID } from "node:crypto";
import { REQUIRED_CHECKS, type VerificationReport } from "@mykey/contracts";
import { readIncarnation } from "@mykey/db";
import { environmentPrefix, namespaceFor } from "@mykey/openbao";
import type { EnvironmentId, OrganizationId, ProjectId } from "@mykey/contracts";
import { OpenBaoAdmin } from "@mykey/openbao/admin";
import { restoreInvalidate, restoreVerify, type VerifyDeps } from "@mykey/ops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RestoredPair } from "../../harness/pair-fixture.ts";
import { createLostWorld, type LostWorld } from "../../harness/restore-fixture.ts";
import { baoFetch } from "../../harness/stack.ts";

let world: LostWorld;
let restored: RestoredPair & { token: string };
let deps: VerifyDeps;

const okAnswer = { state: "ok", observed: "test" } as const;

beforeAll(async () => {
  world = await createLostWorld();
  restored = await world.restore();
  const admin = new OpenBaoAdmin(restored.bao.bao, restored.token);
  const restoreStartedAt = new Date();
  await restoreInvalidate({
    pool: restored.db,
    admin,
    pairId: world.pair.pairId,
    deliver: () => Promise.resolve(),
  });
  const incarnation = await readIncarnation(restored.db);
  const latest = await restored.db.query<{ name: string }>(
    "SELECT name FROM meta.schema_migration ORDER BY name DESC LIMIT 1",
  );
  const members = await restored.db.query<{ n: string }>(
    "SELECT count(*) AS n FROM app.membership",
  );
  deps = {
    pool: restored.db,
    admin,
    host: "local",
    expect: {
      hostInstanceId: randomUUID(),
      backendIncarnation: incarnation ?? "",
      releaseBuild: "abcdef123456",
    },
    origin: { kind: "restore", pairId: world.pair.pairId },
    schemaRevision: (latest.rows[0]?.name ?? "").replace(/\.sql$/, ""),
    restoreStartedAt,
    given: {
      pair_signature: okAnswer,
      pair_digests: okAnswer,
      old_credentials_refused: okAnswer,
    },
    confirmMembers: Number(members.rows[0]?.n ?? "0"),
    boundCidrs: { runtime: [], issuer: [], provisioner: [] },
  };
}, 900_000);

afterAll(async () => {
  await (world as LostWorld | undefined)?.close();
}, 300_000);

const journey = {
  checks: {
    journey_owner_enrolled: okAnswer,
    journey_reveal_digest: okAnswer,
    journey_mutation_refused: okAnswer,
  },
};

const failing = (report: VerificationReport): string[] =>
  report.checks.filter((c) => c.state !== "ok").map((c) => c.id);

describe("restoreVerify (P-124)", () => {
  it("answers every required check, all ok on a restored and invalidated world", async () => {
    const report = await restoreVerify(deps, journey);
    expect(report.checks.map((c) => c.id)).toEqual([...REQUIRED_CHECKS.restore]);
    expect(report.checks.filter((c) => c.state !== "ok")).toEqual([]);
    expect(report.members).toBe(deps.confirmMembers);
    const audit = await restored.db.query<{ details: { checks: number; failed: number } }>(
      "SELECT details FROM audit.event WHERE action = 'operator.restore_verify' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(audit.rows[0]?.details).toEqual({ checks: REQUIRED_CHECKS.restore.length, failed: 0 });
  }, 120_000);

  it("without a journey, the journey checks are unknown; unconfirmed members fail", async () => {
    const report = await restoreVerify({ ...deps, confirmMembers: -1 }, null);
    expect(failing(report)).toEqual([
      "members_confirmed",
      "journey_owner_enrolled",
      "journey_reveal_digest",
      "journey_mutation_refused",
    ]);
    expect(report.checks.find((c) => c.id === "journey_reveal_digest")?.state).toBe("unknown");
  }, 120_000);

  it("a session inserted → sessions_none fails, and only it", async () => {
    const id = randomUUID();
    await restored.db.query(
      `INSERT INTO auth.session (id, token, user_id, expires_at)
       SELECT $1, $2, user_id, now() + interval '1 hour' FROM auth.account_state LIMIT 1`,
      [id, `v1.test.${randomBytes(32).toString("base64url")}`],
    );
    try {
      expect(failing(await restoreVerify(deps, journey))).toEqual(["sessions_none"]);
    } finally {
      await restored.db.query("DELETE FROM auth.session WHERE id = $1", [id]);
    }
  }, 120_000);

  it("one credential set active → credentials_all_revoked fails, and only it", async () => {
    const one = world.old.tokens[0]?.credentialId ?? "";
    await restored.db.query("UPDATE app.machine_credential SET state = 'active' WHERE id = $1", [
      one,
    ]);
    try {
      expect(failing(await restoreVerify(deps, journey))).toEqual(["credentials_all_revoked"]);
    } finally {
      await restored.db.query("UPDATE app.machine_credential SET state = 'revoked' WHERE id = $1", [
        one,
      ]);
    }
  }, 120_000);

  // Session 11 (Run 11.5): the check counts both tables of credentials.
  it("one automation credential set active → credentials_all_revoked fails, and only it", async () => {
    const one = world.old.automation.credentialId;
    await restored.db.query(
      "UPDATE app.automation_credential SET state = 'active', revoked_at = NULL WHERE id = $1",
      [one],
    );
    try {
      expect(failing(await restoreVerify(deps, journey))).toEqual(["credentials_all_revoked"]);
    } finally {
      await restored.db.query(
        "UPDATE app.automation_credential SET state = 'revoked', revoked_at = now() WHERE id = $1",
        [one],
      );
    }
  }, 120_000);

  it("one accessor created → machine_accessors_none fails, and only it", async () => {
    const namespace = world.f.fx.namespace;
    const created = await baoFetch(restored.bao, "/v1/auth/token/create", {
      method: "POST",
      token: restored.token,
      namespace,
      body: { policies: ["default"], ttl: "1h" },
    });
    expect(created.status).toBe(200);
    const accessor = ((await created.json()) as { auth: { accessor: string } }).auth.accessor;
    try {
      expect(failing(await restoreVerify(deps, journey))).toEqual(["machine_accessors_none"]);
    } finally {
      await deps.admin.revokeAccessor(namespace, accessor);
    }
  }, 120_000);

  it("the incarnation changed in one of the three places → incarnation_three_places fails, and only it", async () => {
    await deps.admin.writeIncarnation("", randomUUID());
    try {
      expect(failing(await restoreVerify(deps, journey))).toEqual(["incarnation_three_places"]);
    } finally {
      await deps.admin.writeIncarnation("", deps.expect.backendIncarnation);
    }
  }, 120_000);

  it("an environment's name removed from OpenBao → catalog_matches_backend fails, and only it", async () => {
    const { organizationId, project1, env1a } = world.f.tenants.a;
    const path = `${environmentPrefix(project1 as ProjectId, env1a as EnvironmentId)}${world.old.secret.name}`;
    const removed = await baoFetch(restored.bao, `/v1/kv/metadata/${path}`, {
      method: "DELETE",
      token: restored.token,
      namespace: namespaceFor(organizationId as OrganizationId),
    });
    expect(removed.status).toBe(204);
    expect(failing(await restoreVerify(deps, journey))).toEqual(["catalog_matches_backend"]);
  }, 120_000);
});
