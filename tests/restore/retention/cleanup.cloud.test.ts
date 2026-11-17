// Run 6.5 Task C (P-119): a real pair bundle of the local stack — a pg_dump,
// the globals and a Raft snapshot packed into its own Restic repository —
// through the pair job's own token (`mykey-staging-pairs-upload`) and r2Store,
// under `probe/` of `mykey-staging-pairs` (no lock there until Run 6.5 Task D
// sets the 30-day rule on `pairs/`; the probe object is deleted afterwards).
// Its size and the upload time go into docs/evidence/cost-sheet.md. Run 6.6
// adds the retention clean-up to this file. Cloud tests describe provider
// behaviour: a failure is a finding to record, never something to fix by
// weakening the assertion.
import { randomBytes } from "node:crypto";
import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf, loadR2Credentials, r2Store } from "@mykey/backup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { restic, tarIn } from "../../harness/restic.ts";
import {
  baoFetch,
  freshDatabase,
  pgDumpToFile,
  pgGlobalsToFile,
  startStack,
  type Stack,
} from "../../harness/stack.ts";

const store = r2Store(loadR2Credentials("mykey-staging-pairs-upload"), "mykey-staging-pairs");
const key = `probe/${new Date().toISOString().slice(0, 10)}/${randomBytes(6).toString("hex")}/bundle.tar`;
let stack: Stack;
let work: string;

beforeAll(async () => {
  stack = await startStack();
  work = mkdtempSync(join(tmpdir(), "mykey-pair-cloud-"));
}, 600_000);

afterAll(async () => {
  rmSync(work, { recursive: true, force: true });
  await stack.stop();
}, 300_000);

describe("a real pair bundle in the pairs bucket (P-119)", () => {
  it("is put, read back and compared through the pair job's token; the probe object is then deleted", async () => {
    const database = await freshDatabase(stack);
    const artifacts = join(work, "artifacts");
    mkdirSync(artifacts);
    await pgDumpToFile(stack, database.database, join(artifacts, "postgres.dump"));
    await pgGlobalsToFile(stack, join(artifacts, "globals.sql"));
    const snapshot = await baoFetch(stack, "/v1/sys/storage/raft/snapshot");
    expect(snapshot.status).toBe(200);
    writeFileSync(join(artifacts, "openbao.snap"), new Uint8Array(await snapshot.arrayBuffer()));

    const password = join(work, "password");
    writeFileSync(password, randomBytes(24).toString("hex"));
    mkdirSync(join(work, "repo"));
    const paths = { repo: join(work, "repo"), password };
    expect((await restic(paths, ["init"])).code).toBe(0);
    expect(
      (await restic({ ...paths, artifacts }, ["backup", "--host", "mykey", "/artifacts"])).code,
    ).toBe(0);
    await tarIn(work, ["-C", "/d", "-cf", "/d/bundle.tar", "repo"]);
    const bundle = join(work, "bundle.tar");
    const sent = await digestOf(createReadStream(bundle));

    const started = Date.now();
    await store.put(key, createReadStream(bundle), sent);
    const uploadMs = Date.now() - started;
    const back = await digestOf(await store.get(key));
    expect(back).toEqual(sent);
    expect((await store.head(key))?.bytes).toBe(sent.bytes);

    const deleted = await store.deleteChecked([key]);
    expect(deleted).toEqual([{ key, deleted: true }]);
    expect(await store.head(key)).toBeNull();

    writeFileSync(
      join(import.meta.dirname, "../../../docs/evidence/session-6/run-6.5-pair-cloud.json"),
      `${JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          bucket: "mykey-staging-pairs",
          token: "mykey-staging-pairs-upload",
          bundleBytes: sent.bytes,
          uploadMs,
          readBackEqual: back.sha256 === sent.sha256,
          probeDeleted: true,
        },
        null,
        2,
      )}
`,
    );
    await database.drop();
  }, 600_000);
});
