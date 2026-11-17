// The stale-work sweep (Run 4.5, P-69, Doc 06 §6.2 step 6): an executing
// secret operation whose heartbeat is older than 120 s becomes uncertain (its
// key to review, its slot kept); an accepted one becomes rejected — no
// dispatch marker was written, so nothing was sent (D-20). The executor that
// comes back late can neither finalize nor dispatch.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrganizationId } from "@mykey/contracts";
import { listUnresolved, type Queryable } from "@mykey/db";
import { sweepStaleOperations, type FaultPoint } from "@mykey/operations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  type Answer,
  type EnvName,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture();
}, 600_000);

afterAll(async () => {
  await f.close();
});

const unique = (): string => `SW_${randomBytes(5).toString("hex").toUpperCase()}`;
const synthetic = (): string => randomBytes(20).toString("hex");

interface Current {
  version: number;
  stateTag: string;
}
const currentOf = (answer: Answer): Current => answer.body.result as Current;

/**
 * Starts an update of a fresh key and holds it at `point` until released.
 * Answers the operation id (once the point is reached), the pending answer and
 * the release.
 */
async function hold(
  env: EnvName,
  point: FaultPoint,
): Promise<{
  name: string;
  operationId: string;
  answer: Promise<Answer>;
  release(): void;
  before: Current;
}> {
  const name = unique();
  const created = await f.create(env, name, synthetic());
  expect(created.status).toBe(201);
  const before = currentOf(created);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: (operationId: string) => void;
  const arrived = new Promise<string>((resolve) => {
    reached = resolve;
  });
  f.setFaults(async (at, operationId) => {
    if (at !== point) return;
    reached(operationId);
    await held;
  });
  const answer = f.update(env, name, synthetic(), before);
  const operationId = await arrived;
  f.setFaults(null);
  return { name, operationId, answer, release, before };
}

const age = async (operationId: string, seconds: number): Promise<void> => {
  await f.api.superuser.query(
    "UPDATE app.operation SET heartbeat_at = now() - make_interval(secs => $2) WHERE id = $1",
    [operationId, seconds],
  );
};

const operation = async (operationId: string) =>
  (
    await f.api.superuser.query<{
      state: string;
      error_code: string | null;
      executor_boot_id: string | null;
      completed_at: Date | null;
    }>(
      "SELECT state, error_code, executor_boot_id, completed_at FROM app.operation WHERE id = $1",
      [operationId],
    )
  ).rows[0];

const slotHeld = async (operationId: string): Promise<boolean> =>
  (
    await f.api.superuser.query("SELECT 1 FROM app.effect_slot WHERE operation_id = $1", [
      operationId,
    ])
  ).rowCount === 1;

const auditRows = async (operationId: string, action: string, outcome?: string) =>
  (
    await f.api.superuser.query(
      `SELECT 1 FROM audit.event WHERE operation_id = $1 AND action = $2
          AND ($3::text IS NULL OR outcome = $3)`,
      [operationId, action, outcome ?? null],
    )
  ).rowCount;

/** The environment free again after a case that leaves its slot held. */
const freeSlot = async (env: EnvName): Promise<void> => {
  await f.api.superuser.query("DELETE FROM app.effect_slot WHERE scope_key = $1", [
    `env:${f.env(env).environmentId}`,
  ]);
};

describe("sweepStaleOperations", () => {
  it("executing with a heartbeat 121 s old → uncertain, key needs_review, slot kept, one system.operation_stuck; 119 s old: untouched", async () => {
    const held = await hold("env1a", "after_dispatch_marker");
    try {
      await age(held.operationId, 119);
      expect((await sweepStaleOperations(f.api.pool)).uncertain).toEqual([]);
      expect((await operation(held.operationId))?.state).toBe("executing");

      await age(held.operationId, 121);
      const swept = await sweepStaleOperations(f.api.pool);
      expect(swept.uncertain).toEqual([held.operationId]);
      const row = await operation(held.operationId);
      expect(row?.state).toBe("uncertain");
      expect(row?.executor_boot_id).toBeNull();
      expect(row?.completed_at).toBeNull();
      expect((await f.indexRow("env1a", held.name))?.state).toBe("needs_review");
      expect(await slotHeld(held.operationId)).toBe(true);
      expect(await auditRows(held.operationId, "system.operation_stuck", "unknown")).toBe(1);
      expect((await sweepStaleOperations(f.api.pool)).uncertain).toEqual([]);
    } finally {
      held.release();
      await held.answer;
      await freeSlot("env1a");
    }
  });

  it("accepted and stale → rejected dependency_unavailable, slot released, key state unchanged, no audited change", async () => {
    const held = await hold("env1b", "after_admission");
    let released = false;
    try {
      await age(held.operationId, 121);
      const swept = await sweepStaleOperations(f.api.pool);
      expect(swept.rejected).toEqual([held.operationId]);
      const row = await operation(held.operationId);
      expect(row?.state).toBe("rejected");
      expect(row?.error_code).toBe("dependency_unavailable");
      expect(row?.completed_at).not.toBeNull();
      expect(await slotHeld(held.operationId)).toBe(false);
      const index = await f.indexRow("env1b", held.name);
      expect(index?.state).toBe("live");
      expect(index?.state_tag).toBe(held.before.stateTag);
      expect(await auditRows(held.operationId, "secret.update", "failure")).toBe(1);
      held.release();
      released = true;
      await held.answer;
      expect(await f.auditedChanges(held.operationId)).toBe(0);
      expect((await f.backend("env1b", held.name))?.currentVersion).toBe(1);
    } finally {
      if (!released) held.release();
      await held.answer;
    }
  });

  it("a swept executor cannot finalize: 503 outcome_unknown, the row stays uncertain, the index row needs_review", async () => {
    const held = await hold("env2a", "after_send");
    try {
      const swept = await sweepStaleOperations(f.api.pool, { staleSeconds: 0 });
      expect(swept.uncertain).toEqual([held.operationId]);
      held.release();
      const answer = await held.answer;
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("outcome_unknown");
      expect(answer.operationId).toBe(held.operationId);
      expect((await operation(held.operationId))?.state).toBe("uncertain");
      expect((await f.indexRow("env2a", held.name))?.state).toBe("needs_review");
      // The write landed (the late twin); only reconciliation may say so.
      expect((await f.backend("env2a", held.name))?.currentVersion).toBe(2);
    } finally {
      held.release();
      await freeSlot("env2a");
    }
  });

  it("a swept accepted operation is not dispatched: 503 dependency_unavailable with operationId, nothing sent", async () => {
    const held = await hold("env1a", "after_admission");
    try {
      const swept = await sweepStaleOperations(f.api.pool, { staleSeconds: 0 });
      expect(swept.rejected).toEqual([held.operationId]);
      held.release();
      const answer = await held.answer;
      expect(answer.status).toBe(503);
      expect(answer.code).toBe("dependency_unavailable");
      expect(answer.operationId).toBe(held.operationId);
      expect(await f.auditedChanges(held.operationId)).toBe(0);
      expect((await f.backend("env1a", held.name))?.currentVersion).toBe(1);
      // An update with the tag the key still has succeeds.
      const again = await f.update("env1a", held.name, synthetic(), held.before);
      expect(again.status).toBe(200);
    } finally {
      held.release();
    }
  });

  it("two sweepers at once: one audit row per operation", async () => {
    const names: EnvName[] = ["env1a", "env1b", "env2a"];
    const holds = [];
    for (const env of names) holds.push(await hold(env, "after_dispatch_marker"));
    try {
      const other = f.api.database.pool("api_runtime");
      const [a, b] = await Promise.all([
        sweepStaleOperations(f.api.pool, { staleSeconds: 0 }),
        sweepStaleOperations(other, { staleSeconds: 0 }),
      ]);
      const ids = holds.map((h) => h.operationId).sort();
      expect([...a.uncertain, ...b.uncertain].sort()).toEqual(ids);
      for (const id of ids) {
        expect(await auditRows(id, "system.operation_stuck")).toBe(1);
      }
    } finally {
      for (const h of holds) h.release();
      await Promise.all(holds.map((h) => h.answer));
      for (const env of names) await freeSlot(env);
    }
  });

  it("the sweep works while OpenBao is unreachable", async () => {
    const held = await hold("env1b", "after_dispatch_marker");
    f.setBao("closed");
    try {
      const swept = await sweepStaleOperations(f.api.pool, { staleSeconds: 0 });
      expect(swept.uncertain).toEqual([held.operationId]);
      expect((await operation(held.operationId))?.state).toBe("uncertain");
    } finally {
      f.setBao("relay");
      held.release();
      await held.answer;
      await freeSlot("env1b");
    }
  });
});

describe("the unresolved count (status.sh)", () => {
  it("status.sh's statement counts what listUnresolved lists", async () => {
    const script = readFileSync(
      join(import.meta.dirname, "../../../infra/hosts/checks/status.sh"),
      "utf8",
    );
    // Run 6.4 (M-3): status.sh runs the statement from a file of its own.
    expect(script, "status.sh reads the unresolved operations").toContain(
      "sql/operations-unresolved.sql",
    );
    const statement = readFileSync(
      join(import.meta.dirname, "../../../infra/hosts/checks/sql/operations-unresolved.sql"),
      "utf8",
    )
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .trim();
    const count = async (db: Queryable): Promise<number> => {
      const result = await db.query<Record<string, string>>(
        statement.replace(/^BEGIN READ ONLY;\s*/, "").replace(/;\s*COMMIT;\s*$/, ""),
      );
      return Number(Object.values(result.rows[0] ?? {})[0]);
    };
    const held = await hold("env1a", "after_dispatch_marker");
    try {
      // Executing with a fresh heartbeat: not yet unresolved. (Earlier cases left uncertain rows.)
      const earlier = await listUnresolved(
        f.api.superuser,
        f.tenants.a.organizationId as OrganizationId,
      );
      expect(earlier.map((row) => row.id)).not.toContain(held.operationId);
      expect(await count(f.api.superuser)).toBe(earlier.length);
      await sweepStaleOperations(f.api.pool, { staleSeconds: 0 });
      const listed = await listUnresolved(
        f.api.superuser,
        f.tenants.a.organizationId as OrganizationId,
      );
      expect(listed.map((row) => row.id)).toContain(held.operationId);
      expect(await count(f.api.superuser)).toBe(listed.length);
    } finally {
      held.release();
      await held.answer;
      await freeSlot("env1a");
    }
  });
});
