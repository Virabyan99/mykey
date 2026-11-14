// Where a value may appear (Run 4.9 Task B, Doc 10 §4.1 rule 2): one
// run-time canary per action — created, updated, restored, revealed, imported,
// exported — on a private stack with two API processes and a provisioner. The
// canaries are found in the responses that must carry them and nowhere else:
// not in any log line of the API processes or the provisioner, not in a dump
// of the whole database, not in PostgreSQL's log, not in OpenBao's audit
// device (where values are HMAC-ed). Positive controls prove each search sees
// real content.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSecretsFixture,
  expectIndexMatchesBackend,
  type SecretsFixture,
} from "../../harness/secrets-fixture.ts";
import { pgDump, postgresLog, readAuditLog } from "../../harness/stack.ts";

let f: SecretsFixture;

beforeAll(async () => {
  f = await createSecretsFixture({ private: true, processes: 2 });
}, 600_000);

afterAll(async () => {
  await f.close();
}, 300_000);

const canary = (): string =>
  ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
const unique = (label: string): string =>
  `SURF_${label}_${randomBytes(3).toString("hex").toUpperCase()}`;

describe("value surfaces", () => {
  it("each canary is in its response and in no log, dump or audit device", async () => {
    const since = new Date().toISOString();
    const provisioner = await f.fx.start();
    const canaries = {
      created: canary(),
      updated: canary(),
      restored: canary(),
      revealed: canary(),
      imported: canary(),
      exported: canary(),
    };
    const names = {
      created: unique("CREATED"),
      updated: unique("UPDATED"),
      restored: unique("RESTORED"),
      revealed: unique("REVEALED"),
      imported: unique("IMPORTED"),
      exported: unique("EXPORTED"),
    };
    const env = "env1a" as const;
    const responses: string[] = [];

    // Created, through the second process.
    expect(
      (await f.create(env, names.created, `${canaries.created}-v`, { to: "second" })).status,
    ).toBe(201);
    // Updated.
    const plain = await f.create(env, names.updated, `plain-${randomUUID()}`);
    expect(plain.status).toBe(201);
    const updated = await f.update(
      env,
      names.updated,
      `${canaries.updated}-v`,
      plain.body.result as { version: number; stateTag: string },
      { to: "second" },
    );
    expect(updated.status).toBe(200);
    // Restored: version 1 carries the canary, version 2 does not, the restore brings it back.
    const original = await f.create(env, names.restored, `${canaries.restored}-v`);
    const replaced = await f.update(
      env,
      names.restored,
      `plain-${randomUUID()}`,
      original.body.result as { version: number; stateTag: string },
    );
    const restored = await f.act(
      env,
      names.restored,
      "restore",
      replaced.body.result as { version: number; stateTag: string },
      { sourceVersion: 1 },
    );
    expect(restored.status).toBe(200);
    // Revealed.
    expect((await f.create(env, names.revealed, `${canaries.revealed}-v`)).status).toBe(201);
    const revealed = await f.send("POST", `${f.env(env).path}/secrets/${names.revealed}/reveal`, {
      body: {},
      key: null,
    });
    expect(revealed.status).toBe(200);
    responses.push(revealed.text);
    // Imported, applied by the second process.
    const text = `${names.imported}=${canaries.imported}-v\n`;
    const preview = await f.send("POST", `${f.env(env).path}/import/preview`, { text, key: null });
    expect(preview.status).toBe(200);
    const applied = await f.send(
      "POST",
      `${f.env(env).path}/import/${preview.body.previewId as string}/apply`,
      { text, to: "second" },
    );
    expect(applied.status).toBe(200);
    // Exported.
    expect((await f.create(env, names.exported, `${canaries.exported}-v`)).status).toBe(201);
    await f.api.superuser.query("UPDATE auth.session SET totp_verified_at = now()");
    const exported = await f.api.request("POST", `${f.env(env).path}/export`, {
      cookie: await f.tenants.cookie("ownerA"),
      body: { confirmed: true },
    });
    expect(exported.status).toBe(200);
    const exportText = await exported.text();
    responses.push(exportText);
    await provisioner.stop();

    // Controls: each canary is in the response that must carry it.
    expect(revealed.text.includes(canaries.revealed)).toBe(true);
    for (const kind of ["created", "updated", "restored", "imported", "exported"] as const) {
      expect(exportText.includes(canaries[kind]), `export carries ${kind}`).toBe(true);
    }

    // The surfaces.
    const dump = await pgDump(f.stack, f.api.database.database);
    const surfaces: Record<string, string> = {
      "API logs (in process)": JSON.stringify(f.api.logs),
      "API logs (second process)": f.second?.output() ?? "",
      "provisioner logs": JSON.stringify(provisioner.logs),
      "database dump": dump,
      "PostgreSQL log": await postgresLog(f.stack, since),
      "OpenBao audit device": JSON.stringify(await readAuditLog(f.stack)),
    };
    // Positive controls: the dump holds the names, the audit device the paths, the logs requests.
    expect(dump.includes(names.exported)).toBe(true);
    expect(surfaces["OpenBao audit device"]?.includes(names.exported)).toBe(true);
    expect(surfaces["API logs (in process)"]?.includes("/export")).toBe(true);
    expect((surfaces["API logs (second process)"] ?? "").length).toBeGreaterThan(0);
    for (const [surface, content] of Object.entries(surfaces)) {
      for (const [kind, value] of Object.entries(canaries)) {
        expect(content.includes(value), `${kind} canary in ${surface}`).toBe(false);
      }
    }
    await expectIndexMatchesBackend(f, env);
  }, 600_000);
});
