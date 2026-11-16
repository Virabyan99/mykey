// Run 6.1 Task B Step 5 (P-107): the served query on 200,000 synthetic rows
// reads both indexes — the organization's for tenant rows, the subject's
// partial index for account rows — and never scans the table. The plan's text
// is written to the evidence directory for the run note (MYKEY_WRITE_EVIDENCE=1).
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVED_ACTIONS } from "@mykey/audit";
import type { OrganizationId } from "@mykey/contracts";
import { auditListStatement } from "@mykey/db";
import { prepareDatabase, type TestDatabase } from "../database/setup.ts";

let db: TestDatabase;
const org = randomUUID();
const member = randomUUID();

beforeAll(async () => {
  db = await prepareDatabase();
  const su = db.pool("superuser");
  await su.query("INSERT INTO app.organization (id, namespace, state) VALUES ($1, $2, 'active')", [
    org,
    `org-${org}`,
  ]);
  await su.query(
    `INSERT INTO auth."user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'm', $2, true, now(), now())`,
    [member, `m-${member}@mykey.invalid`],
  );
  await su.query(
    `INSERT INTO app.membership (id, organization_id, user_id, role, state)
     VALUES ($1, $2, $3, 'owner', 'active')`,
    [randomUUID(), org, member],
  );
  // 200,000 rows: tenant rows of 50 organizations, account rows of 1,000 users, global rows.
  await su.query(
    `INSERT INTO audit.event (id, occurred_at, actor_kind, actor_id, source_category,
                              organization_id, action, target_kind, target_id, outcome, details)
     SELECT gen_random_uuid(), now() - (g * interval '13 seconds'),
            'user', CASE WHEN g % 1000 = 0 THEN $2 ELSE gen_random_uuid()::text END, 'api',
            CASE WHEN g % 3 = 0 THEN NULL
                 WHEN g % 50 = 1 THEN $1::uuid ELSE gen_random_uuid() END,
            CASE WHEN g % 3 = 0 THEN 'auth.sign_in' ELSE 'project.rename' END,
            'project', gen_random_uuid()::text, 'success',
            CASE WHEN g % 3 = 0 THEN '{}'::jsonb ELSE '{"nameLength": 4}'::jsonb END
       FROM generate_series(1, 200000) AS g`,
    [org, member],
  );
  await su.query("ANALYZE audit.event");
}, 300_000);

afterAll(async () => {
  await db.drop();
});

describe("the served query's plan (P-107)", () => {
  it("uses event_organization_occurred_idx and event_subject_occurred_idx and no sequential scan of audit.event", async () => {
    const micros = (
      await db
        .pool("superuser")
        .query<{ m: string }>("SELECT (extract(epoch FROM now()) * 1000000)::bigint::text AS m")
    ).rows[0]?.m;
    const statement = auditListStatement({
      organizationId: org as OrganizationId,
      from: new Date(Date.now() - 30 * 86_400_000),
      to: new Date(Date.now() + 60_000),
      anchorMicros: micros ?? "0",
      actions: SERVED_ACTIONS,
      limit: 51,
    });
    const api = db.pool("api_runtime");
    const result = await api.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${statement.text}`,
      statement.values,
    );
    const plan = result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    // The run note's copy is written on request only: a suite run leaves the tree clean.
    if (process.env.MYKEY_WRITE_EVIDENCE === "1") {
      const dir = join(import.meta.dirname, "..", "..", "..", "docs", "evidence", "session-6");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "audit-explain.txt"), `${plan}\n`);
    }
    expect(plan).toContain("event_organization_occurred_idx");
    expect(plan).toContain("event_subject_occurred_idx");
    expect(plan).not.toMatch(/Seq Scan on event/);
  });
});
