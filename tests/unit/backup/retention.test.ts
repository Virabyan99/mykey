// Run 6.6 Task B (P-121, FR-1.78, AC-1.36): the retention plan is pure. It
// never deletes the host's newest eligible pair, deletes only what the bucket
// lock has released, and reports object prefixes without a row as orphans.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CANDIDATE_DEADLINE_MS,
  keyReadable,
  lockEndsAt,
  pairIdOf,
  planRetention,
  type RetainedPair,
} from "@mykey/backup";

const DAY = 86_400_000;
const NOW = new Date("2026-12-20T04:00:00.000Z");
const ago = (days: number, extraMs = 0): Date => new Date(NOW.getTime() - days * DAY - extraMs);

function pair(p: Partial<RetainedPair> & { capturedDaysAgo: number }): RetainedPair {
  const captureStartedAt = ago(p.capturedDaysAgo);
  return {
    id: p.id ?? randomUUID(),
    host: p.host ?? "staging",
    captureStartedAt,
    status: p.status ?? "eligible",
    eligibleUntil:
      p.eligibleUntil === undefined
        ? (p.status ?? "eligible") === "eligible"
          ? new Date(captureStartedAt.getTime() + 30 * DAY)
          : null
        : p.eligibleUntil,
    deletedAt: p.deletedAt ?? null,
  };
}

const prefixOf = (p: RetainedPair): string =>
  `pairs/${p.host}/${p.captureStartedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}-${p.id}/`;
const objectsOf = (...pairs: RetainedPair[]): { key: string }[] =>
  pairs.flatMap((p) => [
    { key: `${prefixOf(p)}bundle.tar` },
    { key: `${prefixOf(p)}eligible.json` },
  ]);

describe("planRetention (P-121)", () => {
  it("the newest eligible pair is kept when expired", () => {
    const only = pair({ capturedDaysAgo: 40 });
    const plan = planRetention([only], objectsOf(only), "staging", NOW);
    expect(plan.delete).toEqual([]);
    expect(plan.keep).toEqual([{ pair: only, why: "newest_eligible" }]);
  });

  it("with one pair nothing is deleted", () => {
    const only = pair({ capturedDaysAgo: 3 });
    const plan = planRetention([only], objectsOf(only), "staging", NOW);
    expect(plan.delete).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });

  it("an expired pair beside a newer eligible one is deleted, eligible.json first", () => {
    const old = pair({ capturedDaysAgo: 40 });
    const fresh = pair({ capturedDaysAgo: 1 });
    const plan = planRetention([old, fresh], objectsOf(old, fresh), "staging", NOW);
    expect(plan.delete).toEqual([
      { pair: old, keys: [`${prefixOf(old)}eligible.json`, `${prefixOf(old)}bundle.tar`] },
    ]);
    expect(plan.keep).toEqual([{ pair: fresh, why: "newest_eligible" }]);
  });

  it("an eligible pair inside its 30 days is kept as not expired", () => {
    const older = pair({ capturedDaysAgo: 10 });
    const fresh = pair({ capturedDaysAgo: 1 });
    const plan = planRetention([older, fresh], objectsOf(older, fresh), "staging", NOW);
    expect(plan.keep).toContainEqual({ pair: older, why: "not_expired" });
    expect(plan.delete).toEqual([]);
  });

  it("an ineligible pair is deleted only after its lock has ended", () => {
    const fresh = pair({ capturedDaysAgo: 1 });
    const lockedOne = pair({ capturedDaysAgo: 29, status: "ineligible" });
    const released = pair({ capturedDaysAgo: 31, status: "ineligible" });
    const plan = planRetention(
      [fresh, lockedOne, released],
      objectsOf(fresh, lockedOne, released),
      "staging",
      NOW,
    );
    expect(plan.keep).toContainEqual({ pair: lockedOne, why: "locked" });
    expect(plan.delete.map((d) => d.pair)).toEqual([released]);
  });

  it("an ineligible pair without objects is still deleted (its row is closed)", () => {
    const fresh = pair({ capturedDaysAgo: 1 });
    const aborted = pair({ capturedDaysAgo: 31, status: "ineligible" });
    const plan = planRetention([fresh, aborted], objectsOf(fresh), "staging", NOW);
    expect(plan.delete).toEqual([{ pair: aborted, keys: [] }]);
  });

  it("a candidate inside its two hours is kept, one outside is planned as ineligible first", () => {
    const fresh = pair({ capturedDaysAgo: 1 });
    const inside = pair({ capturedDaysAgo: 0, status: "candidate" });
    inside.captureStartedAt = new Date(NOW.getTime() - CANDIDATE_DEADLINE_MS + 60_000);
    const outside = pair({ capturedDaysAgo: 0, status: "candidate" });
    outside.captureStartedAt = new Date(NOW.getTime() - CANDIDATE_DEADLINE_MS - 60_000);
    const plan = planRetention([fresh, inside, outside], objectsOf(fresh), "staging", NOW);
    expect(plan.keep).toContainEqual({ pair: inside, why: "candidate_in_deadline" });
    expect(plan.expire).toEqual([outside]);
    expect(plan.delete).toEqual([]);
  });

  it("a deleted row whose bundle was refused is tried again for what is left", () => {
    const fresh = pair({ capturedDaysAgo: 1 });
    const half = pair({ capturedDaysAgo: 35, status: "expired", deletedAt: ago(1) });
    const plan = planRetention(
      [fresh, half],
      [...objectsOf(fresh), { key: `${prefixOf(half)}bundle.tar` }],
      "staging",
      NOW,
    );
    expect(plan.delete).toEqual([{ pair: half, keys: [`${prefixOf(half)}bundle.tar`] }]);
  });

  it("a deleted row with nothing left is neither kept nor deleted", () => {
    const fresh = pair({ capturedDaysAgo: 1 });
    const gone = pair({ capturedDaysAgo: 35, status: "expired", deletedAt: ago(1) });
    const plan = planRetention([fresh, gone], objectsOf(fresh), "staging", NOW);
    expect(plan.delete).toEqual([]);
    expect(plan.keep.map((k) => k.pair)).toEqual([fresh]);
  });

  it("pairs of another host are not in the plan", () => {
    const fresh = pair({ capturedDaysAgo: 1 });
    const other = pair({ capturedDaysAgo: 40, host: "prod" });
    const plan = planRetention([fresh, other], objectsOf(fresh, other), "staging", NOW);
    expect([...plan.delete.map((d) => d.pair), ...plan.keep.map((k) => k.pair)]).toEqual([fresh]);
    expect(plan.orphans).toEqual([]);
  });

  it("an object prefix without a row is an orphan, never a deletion", () => {
    const fresh = pair({ capturedDaysAgo: 1 });
    const stray = pair({ capturedDaysAgo: 50 });
    const plan = planRetention(
      [fresh],
      [...objectsOf(fresh, stray), { key: "pairs/staging/x/y" }],
      "staging",
      NOW,
    );
    expect(plan.orphans.sort()).toEqual([prefixOf(stray), "pairs/staging/x/"].sort());
    expect(plan.delete).toEqual([]);
  });
});

describe("lockEndsAt and pairIdOf", () => {
  it("the lock of a pair's objects ends at most 30 days after its verification deadline", () => {
    const p = pair({ capturedDaysAgo: 0 });
    expect(lockEndsAt(p).getTime()).toBe(
      p.captureStartedAt.getTime() + 30 * DAY + CANDIDATE_DEADLINE_MS,
    );
  });

  it("reads the pair id from an object prefix, or null", () => {
    const p = pair({ capturedDaysAgo: 0 });
    expect(pairIdOf(`${prefixOf(p)}bundle.tar`)).toBe(p.id);
    expect(pairIdOf("pairs/staging/x/y")).toBeNull();
  });
});

describe("keyReadable", () => {
  it("answers the probe, and false when the probe throws", async () => {
    expect(await keyReadable("k", () => Promise.resolve(true))).toBe(true);
    expect(await keyReadable("k", () => Promise.resolve(false))).toBe(false);
    expect(await keyReadable("k", () => Promise.reject(new Error("unreachable")))).toBe(false);
  });
});
