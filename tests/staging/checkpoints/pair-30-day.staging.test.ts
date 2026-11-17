// Run 6.6 Task C, checkpoint `pair-30-day` (from 17 Dec 2026 19:00 UTC; P-121,
// FR-1.78, AC-1.36): the oldest staging pair, captured by the unit on 17 Nov
// 2026 16:38 UTC, leaves its 30 days and its bucket lock (capture + 30 d + 2 h).
//
//   MYKEY_CHECKPOINT=pair-30-day pnpm run test:staging -- tests/staging/checkpoints/pair-30-day.staging.test.ts
//
// - Run before the 05:00 retention timer of 18 Dec: the pair is restored on
//   the workstation (custody password, digests equal to its signed manifest);
//   then the retention unit, started by hand, deletes it — row expired with
//   deleted_at, both objects gone by HEAD — while a newer eligible pair stays.
// - Run after it: the timer has already done that; the row and the objects
//   say so, and the oldest remaining eligible pair is restored instead.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  artifactsMatch,
  bytesOf,
  digestOf,
  eligibilitySchema,
  loadR2Credentials,
  loadTrust,
  r2Store,
  verifyEligibility,
} from "@mykey/backup";
import { describe, expect, it } from "vitest";
import { restic, tarIn } from "../../harness/restic.ts";
import { expectSuccess, loadHosts, shQuote, sshExec } from "../../harness/staging.ts";

const host = loadHosts().staging;
const DUE = Date.parse("2026-12-17T19:00:00.000Z");
const FIRST = "1591f04a-82aa-4816-b0a7-35cbebd1a10e";
const store = r2Store(loadR2Credentials("mykey-staging-pairs-upload"), "mykey-staging-pairs");
const CUSTODY = join(homedir(), ".mykey", "custody", "staging", "backup");
const EVIDENCE = "docs/evidence/session-6/pair-30-day.json";

async function sql(query: string): Promise<string> {
  const command = `PGPASSWORD=$(cat /etc/mykey/secrets/postgres/superuser-password) docker exec -e PGPASSWORD -u postgres mykey-postgres-1 psql -U postgres -d postgres -Atq -c ${shQuote(query)}`;
  return expectSuccess(
    await sshExec(host, command, { sudo: true, secretOutput: true, timeoutMs: 60_000 }),
    "psql",
  ).stdout.trim();
}

interface Row {
  id: string;
  status: string;
  objectKey: string;
  deleted: boolean;
}

async function rowOf(where: string): Promise<Row | null> {
  const line = await sql(
    `SELECT id, validation_status, coalesce(object_key, ''), deleted_at IS NOT NULL
       FROM app.backup_pair WHERE host = 'staging' AND ${where}
      ORDER BY capture_started_at LIMIT 1`,
  );
  if (line === "") return null;
  const [id = "", status = "", objectKey = "", deleted = ""] = line.split("|");
  return { id, status, objectKey, deleted: deleted === "t" };
}

/** Downloads, verifies and restores a pair on the workstation; the digests of its three artifacts. */
async function restoreOnWorkstation(objectKey: string): Promise<Record<string, string>> {
  const signed = eligibilitySchema.parse(
    JSON.parse((await bytesOf(await store.get(`${objectKey}eligible.json`))).toString("utf8")),
  );
  expect(verifyEligibility(signed, loadTrust("infra/hosts/backup/trust", "staging"))).toEqual({
    ok: true,
  });
  const work = mkdtempSync(join(tmpdir(), "mykey-pair-30-"));
  try {
    const bundle = await bytesOf(await store.get(`${objectKey}bundle.tar`));
    writeFileSync(join(work, "bundle.tar"), bundle);
    expect((await digestOf(Readable.from([bundle]))).sha256).toBe(signed.verification.bundleSha256);
    await tarIn(work, ["-C", "/d", "-xf", "/d/bundle.tar"]);
    mkdirSync(join(work, "out"));
    const restored = await restic(
      { repo: join(work, "repo"), password: join(CUSTODY, "password"), out: join(work, "out") },
      ["restore", "latest", "--target", "/out"],
    );
    expect(restored.code).toBe(0);
    const listing: Record<string, { bytes: number; sha256: string }> = {};
    for (const artifact of signed.manifest.artifacts) {
      const bytes = readFileSync(join(work, "out", "artifacts", artifact.name));
      listing[artifact.name] = await digestOf(Readable.from([bytes]));
    }
    expect(artifactsMatch(signed.manifest, listing)).toEqual({ ok: true, problems: [] });
    return Object.fromEntries(
      Object.entries(listing).map(([name, d]) => [name, d.sha256.slice(0, 16)]),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("checkpoint pair-30-day", () => {
  it("the oldest staging pair is restored, then deleted by the retention unit; a newer eligible pair stays", async () => {
    if (Date.now() < DUE) throw new Error("checkpoint not due before 2026-12-17T19:00Z");
    const first = await rowOf(`id = '${FIRST}'`);
    expect(first, "the first pair's row").not.toBeNull();
    const observed: Record<string, unknown> = { at: new Date().toISOString() };

    if (first?.deleted === false) {
      observed.restored = { pair: FIRST, digests: await restoreOnWorkstation(first.objectKey) };
      const unit = expectSuccess(
        await sshExec(
          host,
          "systemctl start mykey-pair-retention.service && journalctl -u mykey-pair-retention.service --since -10min --no-pager -o cat | tail -5",
          { sudo: true, timeoutMs: 900_000 },
        ),
        "the retention unit",
      ).stdout;
      expect(unit).toContain(`expired ${FIRST}`);
      observed.deletedBy = "the unit, started by this test";
    } else {
      observed.deletedBy = "the 05:00 timer, before this test";
      const remaining = await rowOf("validation_status = 'eligible' AND deleted_at IS NULL");
      expect(remaining, "an eligible pair remains").not.toBeNull();
      observed.restored = {
        pair: remaining?.id,
        digests: await restoreOnWorkstation(remaining?.objectKey ?? ""),
      };
    }

    const after = await rowOf(`id = '${FIRST}'`);
    expect([after?.status, after?.deleted]).toEqual(["expired", true]);
    for (const name of ["bundle.tar", "eligible.json"]) {
      expect(await store.head(`${first?.objectKey ?? ""}${name}`), name).toBeNull();
    }
    const newest = await rowOf("validation_status = 'eligible' AND deleted_at IS NULL");
    expect(newest, "a newer eligible pair stays").not.toBeNull();
    observed.first = after;
    writeFileSync(EVIDENCE, `${JSON.stringify(observed, null, 2)}\n`);
  }, 1_800_000);
});
