// Run 7.8 (P-139, FR-1.94, AC-1.55): metrics.get. What happened in the
// organization by UTC day, counted from the rows its listings serve: the
// outcomes of the product's actions (activity.list) and the denials
// (audit.list). Every number can be listed. A day before the organization's
// first row was not measured (null), a later day without events is zero.
// Rows of earlier days are written directly with their time; an audit row
// cannot be changed afterwards.
import { randomBytes, randomUUID } from "node:crypto";
import type { AuditAction } from "@mykey/audit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DETAILS_OF } from "../../harness/audit-fixture.ts";
import { createSecretsFixture, type SecretsFixture } from "../../harness/secrets-fixture.ts";
import type { FixtureUser } from "../../harness/tenants.ts";

let f: SecretsFixture;
const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");

const DAY_MS = 86_400_000;
const today = (): number => Math.floor(Date.now() / DAY_MS) * DAY_MS;
/** Noon UTC, `daysAgo` days before today. */
const noon = (daysAgo: number): Date => new Date(today() - daysAgo * DAY_MS + DAY_MS / 2);
const dayOf = (daysAgo: number): string =>
  new Date(today() - daysAgo * DAY_MS).toISOString().slice(0, 10);

interface Counts {
  success: number;
  failure: number;
  unknown: number;
  denied: number;
}
interface Metrics {
  observedAt: string;
  source: string;
  window: { from: string; to: string };
  measuredFrom: string | null;
  days: { day: string; counts: Counts | null }[];
  operations: { unresolved: number; uncertain: number };
}

const org = (): string => f.tenants.a.organizationId;

async function metrics(
  query = "",
  user: FixtureUser = "ownerA",
  organizationId = org(),
): Promise<{ status: number; code: string | undefined; text: string; body: Metrics }> {
  const answer = await f.send("GET", `/v1/organizations/${organizationId}/metrics${query}`, {
    user,
    key: null,
  });
  return { ...answer, body: answer.body as unknown as Metrics };
}

/** One audit row at `at`. A tenant row names its organization; an account row names none. */
async function row(
  action: AuditAction,
  outcome: string,
  at: Date,
  place: { organizationId: string | null; user: FixtureUser },
): Promise<void> {
  await f.api.superuser.query(
    `INSERT INTO audit.event (id, occurred_at, actor_kind, actor_id, source_category,
                              organization_id, action, target_kind, target_id, outcome,
                              request_id, details)
     VALUES ($1, $2, 'user', $3, 'api', $4::uuid, $5, $6, $4::text, $7, $8, $9::jsonb)`,
    [
      randomUUID(),
      at,
      f.tenants.userId(place.user),
      place.organizationId,
      action,
      place.organizationId === null ? null : "organization",
      outcome,
      randomUUID(),
      JSON.stringify(DETAILS_OF[action]),
    ],
  );
}

interface Listed {
  occurredAt: string;
  outcome: string;
}

/** Every item a listing serves for the last 30 days, page by page. */
async function listed(
  route: "activity" | "audit",
  query: Record<string, string>,
): Promise<Listed[]> {
  const items: Listed[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 200; pages += 1) {
    const qs = new URLSearchParams({
      ...query,
      limit: "100",
      ...(cursor === null ? {} : { cursor }),
    }).toString();
    const answer = await f.send("GET", `/v1/organizations/${org()}/${route}?${qs}`, { key: null });
    expect(answer.status, answer.text).toBe(200);
    items.push(...(answer.body.items as Listed[]));
    cursor = answer.body.nextCursor as string | null;
    if (cursor === null) return items;
  }
  throw new Error("the listing did not end");
}

beforeAll(async () => {
  f = await createSecretsFixture();
  const a = { organizationId: f.tenants.a.organizationId, user: "ownerA" as const };
  // Three days ago: two successes, one failure, and two rows that are no outcome of the product.
  await row("secret.create", "success", noon(3), a);
  await row("secret.create", "success", noon(3), a);
  await row("secret.update", "failure", noon(3), a);
  await row("secret.create", "intent", noon(3), a);
  await row("auth.sign_in", "success", noon(3), { organizationId: null, user: "ownerA" });
  // Two days ago: nothing.
  // Yesterday: one unknown outcome and two denials (one of the organization, one of a member's
  // account); a denial of somebody who is no member is not this organization's.
  await row("credential.issue", "unknown", noon(1), a);
  await row("access.denied", "denied", noon(1), { ...a, user: "editorA" });
  await row("access.denied", "denied", noon(1), { organizationId: null, user: "ownerA" });
  await row("access.denied", "denied", noon(1), { organizationId: null, user: "ownerB" });
  for (let i = 0; i < 5; i += 1) {
    await row("secret.create", "success", noon(1), {
      organizationId: f.tenants.b.organizationId,
      user: "ownerB",
    });
  }
}, 600_000);

afterAll(async () => {
  await f.close();
});

describe("metrics.get", () => {
  it("counts per day equal a direct query over the rows activity.list serves", async () => {
    // Something of today, through the product.
    const created = await f.create(
      "env1a",
      `MET_${randomBytes(5).toString("hex").toUpperCase()}`,
      `${mark}-${randomUUID()}`,
    );
    expect(created.status, created.text).toBe(201);

    const before = Date.now();
    const answer = await metrics();
    expect(answer.status, answer.text).toBe(200);
    const { body } = answer;
    expect(body.source).toBe("audit.event");
    expect(Date.parse(body.observedAt)).toBeGreaterThan(before - 5000);
    // The default: seven UTC days that end with today, counted up to the observation.
    expect(body.days.map((entry) => entry.day)).toEqual([6, 5, 4, 3, 2, 1, 0].map(dayOf));
    expect(body.window).toEqual({
      from: new Date(today() - 6 * DAY_MS).toISOString(),
      to: body.observedAt,
    });

    // What the two listings serve, counted here.
    const expected = new Map<string, Counts>();
    const at = (day: string): Counts => {
      let counts = expected.get(day);
      if (counts === undefined) {
        counts = { success: 0, failure: 0, unknown: 0, denied: 0 };
        expected.set(day, counts);
      }
      return counts;
    };
    for (const item of await listed("activity", {})) {
      const counts = at(item.occurredAt.slice(0, 10));
      if (item.outcome === "success") counts.success += 1;
      if (item.outcome === "failure") counts.failure += 1;
      if (item.outcome === "unknown") counts.unknown += 1;
    }
    for (const item of await listed("audit", { action: "access.denied" })) {
      at(item.occurredAt.slice(0, 10)).denied += 1;
    }
    for (const entry of body.days.slice(3)) {
      expect(entry.counts, entry.day).toEqual(
        expected.get(entry.day) ?? { success: 0, failure: 0, unknown: 0, denied: 0 },
      );
    }
    // And the rows this file wrote, by number.
    expect(body.days[3]?.counts).toEqual({ success: 2, failure: 1, unknown: 0, denied: 0 });
    expect(body.days[5]?.counts).toEqual({ success: 0, failure: 0, unknown: 1, denied: 2 });
    expect(body.days[6]?.counts?.success).toBeGreaterThanOrEqual(1);
  });

  it("days before the organization's first row have counts null, a later day without events has zeros", async () => {
    const { body } = await metrics("?days=7");
    expect(body.measuredFrom).toBe(noon(3).toISOString());
    expect(body.days.slice(0, 3).map((entry) => entry.counts)).toEqual([null, null, null]);
    expect(body.days[4]).toEqual({
      day: dayOf(2),
      counts: { success: 0, failure: 0, unknown: 0, denied: 0 },
    });
    // One day: today alone. Thirty: the most.
    expect((await metrics("?days=1")).body.days.map((entry) => entry.day)).toEqual([dayOf(0)]);
    const month = (await metrics("?days=30")).body;
    expect(month.days).toHaveLength(30);
    expect(month.days.filter((entry) => entry.counts === null)).toHaveLength(26);
  });

  it("days 31 → 422; a member → 403; organization B's events are counted nowhere", async () => {
    for (const query of ["?days=31", "?days=0", "?days=-1"]) {
      const refused = await metrics(query);
      expect(refused.status, query).toBe(422);
      expect(refused.code, query).toBe("validation_failed");
    }
    for (const member of ["editorA", "readerA", "envEditorA", "ungrantedA"] as const) {
      const denied = await metrics("", member);
      expect(denied.status, member).toBe(403);
      expect(denied.code, member).toBe("action_denied");
      expect(denied.text, member).not.toContain("days");
    }
    expect((await metrics("", "adminA")).status).toBe(200);

    // B's five successes of yesterday are in B's answer and nowhere in A's.
    const ofA = (await metrics()).body;
    expect(ofA.days[5]?.counts?.success).toBe(0);
    const ofB = await metrics("", "ownerB", f.tenants.b.organizationId);
    expect(ofB.status, ofB.text).toBe(200);
    expect(ofB.body.days[5]?.counts).toEqual({ success: 5, failure: 0, unknown: 0, denied: 1 });
    expect(ofB.body.measuredFrom).toBe(noon(1).toISOString());
    const foreign = await metrics("", "ownerB");
    expect(foreign.status).toBe(404);
    expect(foreign.code).toBe("not_found");
    const unknown = await metrics("", "ownerA", randomUUID());
    expect(unknown.text.replace(/"requestId":"[^"]*"/, "")).toBe(
      foreign.text.replace(/"requestId":"[^"]*"/, ""),
    );
  });

  it("operations.unresolved equals the direct count", async () => {
    const made: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const created = await f.create(
        "env1a",
        `MET_${randomBytes(5).toString("hex").toUpperCase()}`,
        `${mark}-${randomUUID()}`,
      );
      expect(created.status, created.text).toBe(201);
      made.push(created.operationId ?? "");
    }
    const before = (await metrics()).body.operations;
    const set = (id: string | undefined, state: string, ended: boolean) =>
      f.api.superuser.query(
        `UPDATE app.operation SET state = $2, completed_at = CASE WHEN $3 THEN now() END
          WHERE id = $1`,
        [id, state, ended],
      );
    try {
      await set(made[0], "uncertain", false);
      // Settled by an operator as unknown: uncertain for ever, no longer unresolved.
      await set(made[1], "uncertain", true);
      await set(made[2], "awaiting_input", false);
      await set(made[3], "executing", false);
      const { operations } = (await metrics()).body;
      expect(operations).toEqual({
        unresolved: before.unresolved + 3,
        uncertain: before.uncertain + 2,
      });
      const direct = await f.api.superuser.query<{ unresolved: string; uncertain: string }>(
        `SELECT count(*) FILTER (WHERE state IN ('accepted', 'executing', 'awaiting_input')
                                    OR (state = 'uncertain' AND completed_at IS NULL)) AS unresolved,
                count(*) FILTER (WHERE state = 'uncertain') AS uncertain
           FROM app.operation WHERE organization_id = $1 AND parent_operation_id IS NULL`,
        [org()],
      );
      expect(operations).toEqual({
        unresolved: Number(direct.rows[0]?.unresolved),
        uncertain: Number(direct.rows[0]?.uncertain),
      });
      // Nothing of B.
      const ofB = (await metrics("", "ownerB", f.tenants.b.organizationId)).body.operations;
      expect(ofB.uncertain).toBe(0);
    } finally {
      for (const id of made) await set(id, "succeeded", true);
    }
  });
});
