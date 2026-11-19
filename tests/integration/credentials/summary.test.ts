// Run 7.7 (P-139, FR-1.91, AC-1.47): credentials.summary. The organization's
// machine credentials counted by derived state at one database time, and the
// active ones within seven days of their expiry, soonest first. For owners and
// admins only; never a token, never an accessor. Rows are written directly:
// the summary reads the catalog and asks OpenBao nothing.
import { randomBytes, randomUUID } from "node:crypto";
import { CREDENTIAL_STATES } from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSecretsFixture, type SecretsFixture } from "../../harness/secrets-fixture.ts";
import type { FixtureUser } from "../../harness/tenants.ts";

let f: SecretsFixture;

const HOUR = 3600;
const DAY = 24 * HOUR;
const accessors: string[] = [];
const ids: Record<string, string> = {};

interface Place {
  organizationId: string;
  projectId: string;
  environmentId: string;
}

/** One row of the catalog, as the superuser. `expiresIn` is seconds from now, or null for none. */
async function seedRow(
  place: Place,
  name: string,
  state: string,
  expiresIn: number | null,
  withToken = true,
): Promise<string> {
  const id = randomUUID();
  const accessor = withToken ? `acc-${randomBytes(12).toString("hex")}` : null;
  if (accessor !== null) accessors.push(accessor);
  await f.api.superuser.query(
    `INSERT INTO app.machine_credential
       (id, organization_id, project_id, environment_id, name, issuance_operation_id, accessor,
        requested_expires_at, effective_expires_at, state, issued_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '30 days',
             now() + make_interval(secs => $8::double precision), $9, $10)`,
    [
      id,
      place.organizationId,
      place.projectId,
      place.environmentId,
      name,
      randomUUID(),
      accessor,
      expiresIn,
      state,
      f.tenants.userId(place.organizationId === f.tenants.a.organizationId ? "ownerA" : "ownerB"),
    ],
  );
  ids[name] = id;
  return id;
}

const summary = (user: FixtureUser = "ownerA", organizationId = f.tenants.a.organizationId) =>
  f.send("GET", `/v1/organizations/${organizationId}/credentials/summary`, { user, key: null });

interface Expiring {
  credentialId: string;
  name: string;
  projectId: string;
  environmentId: string;
  expiresAt: string;
}

beforeAll(async () => {
  f = await createSecretsFixture();
  const a = f.tenants.a;
  const env1a = { organizationId: a.organizationId, projectId: a.project1, environmentId: a.env1a };
  const env1b = { organizationId: a.organizationId, projectId: a.project1, environmentId: a.env1b };
  const env2a = { organizationId: a.organizationId, projectId: a.project2, environmentId: a.env2a };
  await seedRow(env1a, "soon-second", "active", 3 * DAY);
  await seedRow(env2a, "soon-first", "active", DAY);
  await seedRow(env1a, "far", "active", 20 * DAY);
  await seedRow(env1a, "just-outside", "active", 7 * DAY + HOUR);
  // Past its expiry and not yet swept: it reads expired.
  await seedRow(env1a, "lapsed", "active", -HOUR);
  await seedRow(env1a, "swept", "expired", -DAY);
  // Closed or closing rows inside the warning are not "expiring".
  await seedRow(env1a, "gone-soon", "revoked", DAY);
  await seedRow(env1b, "gone", "revoked", 10 * DAY);
  await seedRow(env1a, "going", "revoking", 2 * DAY);
  // One unresolved issuance per environment (the partial unique index).
  await seedRow(env1b, "being-issued", "issuing", null);
  await seedRow(env2a, "unknown-outcome", "needs_review", null);
  // An issuance that never made a token: the inventory does not list it, so it is not counted.
  await seedRow(env1a, "never-made", "revoked", null, false);
  const b = f.tenants.b;
  await seedRow(
    { organizationId: b.organizationId, projectId: b.project1, environmentId: b.env1a },
    "of-b",
    "active",
    DAY,
  );
}, 600_000);

afterAll(async () => {
  await f.close();
});

describe("credentials.summary", () => {
  it("byState equals a direct count per derived state; expiring holds only active credentials within 7 days, soonest first; a member gets 403; nothing of organization B", async () => {
    const before = Date.now();
    const answer = await summary();
    expect(answer.status, answer.text).toBe(200);
    const observedAt = Date.parse(answer.body.observedAt as string);
    expect(observedAt).toBeGreaterThan(before - 5000);
    expect(observedAt).toBeLessThan(Date.now() + 5000);

    const direct = await f.api.superuser.query<{ state: string; count: string }>(
      `SELECT CASE WHEN state = 'active' AND effective_expires_at <= now() THEN 'expired'
                   ELSE state END AS state, count(*) AS count
         FROM app.machine_credential
        WHERE organization_id = $1 AND NOT (state = 'revoked' AND accessor IS NULL)
        GROUP BY 1`,
      [f.tenants.a.organizationId],
    );
    const counted = Object.fromEntries(CREDENTIAL_STATES.map((state) => [state, 0]));
    for (const row of direct.rows) counted[row.state] = Number(row.count);
    expect(answer.body.byState).toEqual(counted);
    expect(answer.body.byState).toEqual({
      issuing: 1,
      active: 4,
      revoking: 1,
      revoked: 2,
      expired: 2,
      needs_review: 1,
    });

    const expiring = answer.body.expiring as Expiring[];
    expect(expiring.map((row) => row.name)).toEqual(["soon-first", "soon-second"]);
    expect(expiring[0]).toEqual({
      credentialId: ids["soon-first"],
      name: "soon-first",
      projectId: f.tenants.a.project2,
      environmentId: f.tenants.a.env2a,
      expiresAt: expect.any(String) as string,
    });
    const stored = await f.api.superuser.query<{ at: Date }>(
      "SELECT effective_expires_at AS at FROM app.machine_credential WHERE id = $1",
      [ids["soon-first"]],
    );
    expect(expiring[0]?.expiresAt).toBe(stored.rows[0]?.at.toISOString());
    expect(answer.body.expiringTruncated).toBe(false);

    const admin = await summary("adminA");
    expect(admin.status).toBe(200);
    expect(admin.body.byState).toEqual(answer.body.byState);
    expect(admin.body.expiring).toEqual(answer.body.expiring);
    for (const member of ["editorA", "readerA", "envEditorA", "ungrantedA"] as const) {
      const denied = await summary(member);
      expect(denied.status, member).toBe(403);
      expect(denied.code, member).toBe("action_denied");
      expect(denied.text, member).not.toContain("soon-first");
    }

    // Nothing of B in A's answer, nothing of A in B's, and A is hidden from B.
    expect(answer.text).not.toContain(ids["of-b"]);
    expect(answer.text).not.toContain(f.tenants.b.env1a);
    const ofB = await summary("ownerB", f.tenants.b.organizationId);
    expect(ofB.status, ofB.text).toBe(200);
    expect(ofB.body.byState).toEqual({ ...zeroes(), active: 1 });
    expect((ofB.body.expiring as Expiring[]).map((row) => row.credentialId)).toEqual([ids["of-b"]]);
    const foreign = await summary("ownerB");
    expect(foreign.status).toBe(404);
    expect(foreign.code).toBe("not_found");
    const unknown = await summary("ownerA", randomUUID());
    expect(unknown.text.replace(/"requestId":"[^"]*"/, "")).toBe(
      foreign.text.replace(/"requestId":"[^"]*"/, ""),
    );
  });

  it("no field of the answer is an accessor or a token", async () => {
    const answer = await summary();
    expect(answer.status, answer.text).toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual([
      "byState",
      "expiring",
      "expiringTruncated",
      "observedAt",
    ]);
    expect(Object.keys(answer.body.byState as object).sort()).toEqual(
      [...CREDENTIAL_STATES].sort(),
    );
    for (const row of answer.body.expiring as Expiring[]) {
      expect(Object.keys(row).sort()).toEqual([
        "credentialId",
        "environmentId",
        "expiresAt",
        "name",
        "projectId",
      ]);
    }
    // Every row has an accessor in the catalog; none of them is in the answer.
    expect(accessors.length).toBeGreaterThan(10);
    for (const accessor of accessors) expect(answer.text.includes(accessor)).toBe(false);
    expect(answer.text).not.toMatch(/accessor|token/i);
  });

  it("more than 50 expiring credentials: the 50 soonest and expiringTruncated true", async () => {
    const a = f.tenants.a;
    const place = {
      organizationId: a.organizationId,
      projectId: a.project1,
      environmentId: a.env1b,
    };
    const made: string[] = [];
    // 49 more, all later than the two of the first test and inside the warning.
    for (let i = 0; i < 49; i += 1) {
      made.push(await seedRow(place, `many-${String(i).padStart(2, "0")}`, "active", 4 * DAY + i));
    }
    try {
      const answer = await summary();
      expect(answer.status, answer.text).toBe(200);
      const expiring = answer.body.expiring as Expiring[];
      expect(expiring).toHaveLength(50);
      expect(expiring.slice(0, 3).map((row) => row.name)).toEqual([
        "soon-first",
        "soon-second",
        "many-00",
      ]);
      expect(expiring.at(-1)?.name).toBe("many-47");
      expect(answer.body.expiringTruncated).toBe(true);
      const times = expiring.map((row) => Date.parse(row.expiresAt));
      expect(times).toEqual([...times].sort((x, y) => x - y));
    } finally {
      await f.api.superuser.query("DELETE FROM app.machine_credential WHERE id = ANY($1)", [made]);
    }
  });
});

function zeroes(): Record<string, number> {
  return Object.fromEntries(CREDENTIAL_STATES.map((state) => [state, 0]));
}
