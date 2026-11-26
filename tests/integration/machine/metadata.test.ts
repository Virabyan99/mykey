// Run 11.3 Task C (spec §1.2, §2.2; plan fact 10): machine.metadata answers
// every live name of one generation with its version and its two times, in
// bytewise order, and never a value. It is PostgreSQL's answer alone: the
// token's own lookup is the only request OpenBao gets, and no audit row is
// written (AUDIT_COVERAGE: a read of names' metadata, as a person's list).
// Tokens and values are locals; values are searched, never printed.
import { randomBytes } from "node:crypto";
import { machineName } from "@mykey/openbao";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  issueFor,
  issueRuntimeFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { exchangeCall, machineCall } from "../../harness/machine.ts";
import { readAuditLog } from "../../harness/stack.ts";

const bytewise = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const unique = (prefix: string): string =>
  `${prefix}_${randomBytes(4).toString("hex").toUpperCase()}`;

interface Entry {
  name: string;
  version: number | null;
  createdAt: string | null;
  updatedAt: string;
}

const entriesOf = (body: Record<string, unknown>): Entry[] => body.entries as Entry[];

describe("machine.metadata", () => {
  let f: CredentialsFixture;

  /** What PostgreSQL holds for the live names of env1a: the index row and the first create event. */
  async function stored(): Promise<Entry[]> {
    const environmentId = f.env("env1a").environmentId;
    const index = await f.api.superuser.query<{
      name: string;
      current_version: number | null;
      last_changed_at: Date;
    }>(
      `SELECT name, current_version, last_changed_at FROM app.secret_index
        WHERE environment_id = $1 AND state = 'live'`,
      [environmentId],
    );
    const created = await f.api.superuser.query<{ name: string; occurred_at: Date }>(
      `SELECT name, occurred_at FROM app.secret_version_event
        WHERE environment_id = $1 AND action = 'secret.create'
        ORDER BY occurred_at DESC`,
      [environmentId],
    );
    // The earliest wins: the rows come newest first.
    const first = new Map(created.rows.map((row) => [row.name, row.occurred_at]));
    return index.rows
      .map((row) => ({
        name: row.name,
        version: row.current_version,
        createdAt: first.get(row.name)?.toISOString() ?? null,
        updatedAt: row.last_changed_at.toISOString(),
      }))
      .sort((left, right) => bytewise(left.name, right.name));
  }

  const generationOf = async (): Promise<string | undefined> =>
    (
      await f.api.superuser.query<{ generation: string }>(
        "SELECT metadata_generation::text AS generation FROM app.environment WHERE id = $1",
        [f.env("env1a").environmentId],
      )
    ).rows[0]?.generation;

  beforeAll(async () => {
    f = await createCredentialsFixture();
  }, 600_000);

  afterAll(async () => {
    await f.close();
  });

  it("metadata returns every live name with its version, createdAt and updatedAt, in bytewise order, with count, generation and complete: true, for a 30-day token and for an exchanged one", async () => {
    const names = [unique("M_B"), unique("M_A"), unique("M_C"), unique("M_A1")];
    const made = new Map<string, { version: number; stateTag: string }>();
    for (const name of names) {
      const answer = await f.create("env1a", name, `synthetic-${name.toLowerCase()}`);
      expect(answer.status).toBe(201);
      made.set(name, answer.body.result as { version: number; stateTag: string });
    }
    const gone = names[2]!;
    expect((await f.act("env1a", gone, "delete", made.get(gone)!)).status).toBe(200);

    const { token } = await issueFor(f, "env1a");
    const runtime = await issueRuntimeFor(f, "env1a");
    const exchange = await exchangeCall(f, { secret: runtime.clientSecret });
    expect(exchange.status, exchange.code ?? "").toBe(200);

    const expected = await stored();
    expect(expected.map((entry) => entry.name)).toEqual(
      names.filter((name) => name !== gone).sort(bytewise),
    );
    for (const entry of expected) {
      expect(entry.version).toBe(1);
      expect(entry.createdAt).not.toBeNull();
      // Written once: the name's two times are one time.
      expect(entry.updatedAt).toBe(entry.createdAt);
    }
    for (const bearer of [token, exchange.body.token as string]) {
      const answer = await machineCall(f, "metadata", { token: bearer });
      expect(answer.status, answer.code ?? "").toBe(200);
      expect(Object.keys(answer.body).sort()).toEqual(
        ["apiMajor", "complete", "count", "entries", "environmentId", "generation"].sort(),
      );
      expect(entriesOf(answer.body)).toEqual(expected);
      expect(answer.body.count).toBe(expected.length);
      expect(answer.body.complete).toBe(true);
      expect(answer.body.apiMajor).toBe(1);
      expect(answer.body.environmentId).toBe(f.env("env1a").environmentId);
      expect(answer.body.generation).toBe(await generationOf());
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(Number(answer.headers.get("content-length"))).toBe(answer.bytes.length);
    }
  });

  it("a name written twice has version 2, createdAt of the first write and updatedAt of the second", async () => {
    const name = unique("M_TWICE");
    const first = await f.create("env1a", name, "synthetic-first");
    expect(first.status).toBe(201);
    const { token } = await issueFor(f, "env1a");
    const before = entriesOf((await machineCall(f, "metadata", { token })).body).find(
      (entry) => entry.name === name,
    );
    expect(before).toMatchObject({ version: 1 });
    const second = await f.update(
      "env1a",
      name,
      "synthetic-second",
      first.body.result as { version: number; stateTag: string },
    );
    expect(second.status, second.code ?? "").toBe(200);

    const after = entriesOf((await machineCall(f, "metadata", { token })).body).find(
      (entry) => entry.name === name,
    );
    expect(after?.version).toBe(2);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(after!.createdAt!));
    expect(after).toEqual((await stored()).find((entry) => entry.name === name));
  });

  it("a name whose create event is gone has createdAt null", async () => {
    const [kept, lost] = [unique("M_KEPT"), unique("M_LOST")];
    for (const name of [kept, lost]) {
      expect((await f.create("env1a", name, "synthetic")).status).toBe(201);
    }
    const removed = await f.api.superuser.query(
      `DELETE FROM app.secret_version_event
        WHERE environment_id = $1 AND name = $2 AND action = 'secret.create'`,
      [f.env("env1a").environmentId, lost],
    );
    expect(removed.rowCount).toBe(1);
    const { token } = await issueFor(f, "env1a");
    const answer = await machineCall(f, "metadata", { token });
    expect(answer.status, answer.code ?? "").toBe(200);
    const byName = new Map(entriesOf(answer.body).map((entry) => [entry.name, entry]));
    // Unknown is said as unknown: no guess from the index's own time.
    expect(byName.get(lost)).toMatchObject({ version: 1, createdAt: null });
    expect(byName.get(lost)?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(byName.get(kept)?.createdAt).not.toBeNull();
  });

  it("no value of the environment appears in the body", async () => {
    await f.seedEnvironment("env1b", 25, 64);
    const { token } = await issueFor(f, "env1b");
    const resolved = await machineCall(f, "resolve", { token, env: "env1b" });
    expect(resolved.status, resolved.code ?? "").toBe(200);
    const values = (resolved.body.entries as { name: string; value: string }[]).map(
      (entry) => entry.value,
    );
    expect(values).toHaveLength(25);
    expect(new Set(values).size).toBe(25);

    const answer = await machineCall(f, "metadata", { token, env: "env1b" });
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(answer.body.count).toBe(25);
    const metadata = answer.bytes.toString("utf8");
    const control = resolved.bytes.toString("utf8");
    // The control: the same search finds every value in the complete read.
    expect(values.filter((value) => control.includes(value))).toHaveLength(25);
    expect(values.filter((value) => metadata.includes(value))).toEqual([]);
    // Nor a part of one, nor its encoded form.
    for (const value of values) {
      expect(metadata.includes(value.slice(0, 24))).toBe(false);
      expect(metadata.includes(Buffer.from(value).toString("base64").slice(0, 24))).toBe(false);
    }
    // A seeded name has no create event: every createdAt is null, every version 1.
    for (const entry of entriesOf(answer.body)) {
      expect(Object.keys(entry).sort()).toEqual(["createdAt", "name", "updatedAt", "version"]);
      expect(entry).toMatchObject({ version: 1, createdAt: null });
    }
  });

  it("a name under review stops the whole answer (key_under_review), and the answer is back when the review ends", async () => {
    const name = unique("M_REVIEW");
    expect((await f.create("env1a", name, "synthetic")).status).toBe(201);
    const { token } = await issueFor(f, "env1a");
    const mark = (state: string) =>
      f.api.superuser.query(
        "UPDATE app.secret_index SET state = $3 WHERE environment_id = $1 AND name = $2",
        [f.env("env1a").environmentId, name, state],
      );
    await mark("needs_review");
    try {
      const refused = await machineCall(f, "metadata", { token });
      expect(refused.code).toBe("key_under_review");
      expect(refused.body.entries).toBeUndefined();
    } finally {
      await mark("live");
    }
    expect((await machineCall(f, "metadata", { token })).status).toBe(200);
  });
});

describe("metadata is PostgreSQL's answer alone", () => {
  let f: CredentialsFixture;

  beforeAll(async () => {
    // The API's runtime secret id is one OpenBao refuses.
    f = await createCredentialsFixture({ runtime: "broken" });
    await f.seedEnvironment("env1a", 3, 32);
  }, 600_000);

  afterAll(async () => {
    await f.close();
  });

  it("metadata writes no audit row and reads nothing from OpenBao but the token's lookup", async () => {
    const { token } = await issueFor(f, "env1a");
    const policy = machineName(f.env("env1a").environmentId);
    /** The requests made with a token of the environment's machine policy since `start`. */
    const byMachine = async (start: number): Promise<string[]> =>
      (await readAuditLog(f.stack))
        .slice(start)
        .filter(
          (entry) =>
            entry.type === "request" &&
            entry.namespacePath.startsWith(f.fx.namespace) &&
            (
              (JSON.parse(entry.raw) as { auth?: { policies?: string[] } }).auth?.policies ?? []
            ).includes(policy),
        )
        .map((entry) => entry.path);

    const start = (await readAuditLog(f.stack)).length;
    const answer = await machineCall(f, "metadata", { token });
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(answer.body.count).toBe(3);
    expect(await byMachine(start)).toEqual(["auth/token/lookup-self"]);
    const kv = (await readAuditLog(f.stack))
      .slice(start)
      .filter((entry) => entry.namespacePath.startsWith(f.fx.namespace))
      .filter((entry) => entry.path.startsWith("kv/"));
    expect(kv).toEqual([]);
    const audit = await f.api.superuser.query(
      "SELECT action FROM audit.event WHERE request_id = $1",
      [answer.headers.get("x-request-id")],
    );
    expect(audit.rows).toEqual([]);

    // The control: the names' read by the same token asks OpenBao for its list, and is audited.
    const from = (await readAuditLog(f.stack)).length;
    const keys = await machineCall(f, "keys", { token });
    expect(keys.status, keys.code ?? "").toBe(200);
    expect((await byMachine(from)).some((path) => path.startsWith("kv/"))).toBe(true);
    const audited = await f.api.superuser.query<{ action: string }>(
      "SELECT action FROM audit.event WHERE request_id = $1",
      [keys.headers.get("x-request-id")],
    );
    expect(audited.rows.map((row) => row.action)).toEqual(["machine.keys"]);
  });

  it("an exchange, and the exchanged token's metadata, answer 200 while the runtime identity is refused", async () => {
    const runtime = await issueRuntimeFor(f, "env1a");
    const exchange = await exchangeCall(f, { secret: runtime.clientSecret });
    expect(exchange.status, exchange.code ?? "").toBe(200);
    const answer = await machineCall(f, "metadata", { token: exchange.body.token as string });
    expect(answer.status, answer.code ?? "").toBe(200);
    expect(answer.body.count).toBe(3);
    // Control: the runtime identity is refused, so a person's reveal cannot read.
    const reveal = await f.send("POST", `${f.env("env1a").path}/secrets/SEED_0000/reveal`, {
      body: {},
      key: null,
    });
    expect(reveal.status).toBe(503);
  });
});
