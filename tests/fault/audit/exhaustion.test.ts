// Run 6.3 Task C (P-115, FR-1.61, AC-1.24): real disk exhaustion needs no
// capacity record. PostgreSQL's data lives on a 300 MiB tmpfs
// (infra/compose/dev/pg-full.override.yml); the superuser fills it: an
// unlogged filler table until the disk refuses (53100), then rows into the
// tables every request writes (audit.event, app.rate_limit) until their last
// pages are full too. A reveal and a machine resolve then answer 503 and hold
// no value, and no audit row claims their success. With the filler dropped,
// both succeed again. Control first: both succeed and carry the value.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { machineCall } from "../../harness/machine.ts";

let f: CredentialsFixture;
let token: string;
const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
const name = `FULL_${randomBytes(5).toString("hex").toUpperCase()}`;

beforeAll(async () => {
  f = await createCredentialsFixture({ stackOverrides: ["pg-full.override.yml"] });
  const created = await f.create("env1a", name, `${mark}-${randomUUID()}`);
  expect(created.status).toBe(201);
  token = (await issueFor(f, "env1a")).token;
}, 900_000);

afterAll(async () => {
  await free().catch(() => undefined);
  await f.close();
});

const q = () => f.api.superuser;

/** Runs `sql` in a loop until the disk refuses (53100); returns the rows it got in. */
async function untilFull(sql: string): Promise<number> {
  const result = await q().query<{ n: number }>(
    `DO $$
     DECLARE n int := 0;
     BEGIN
       LOOP
         BEGIN
           ${sql};
           n := n + 1;
         EXCEPTION WHEN disk_full THEN
           RAISE NOTICE 'full after %', n;
           EXIT;
         END;
       END LOOP;
       PERFORM set_config('mykey.filled', n::text, false);
     END $$;
     SELECT current_setting('mykey.filled')::int AS n`,
  );
  return (result as unknown as { rows: { n: number }[] }[]).at(-1)?.rows[0]?.n ?? 0;
}

async function fill(): Promise<void> {
  await q().query("CREATE UNLOGGED TABLE IF NOT EXISTS public.filler (b bytea)");
  await untilFull(
    "INSERT INTO public.filler SELECT decode(repeat('00', 1048576), 'hex') FROM generate_series(1, 4)",
  );
  await untilFull("INSERT INTO public.filler VALUES (decode(repeat('00', 8192), 'hex'))");
  await untilFull(
    `INSERT INTO audit.event (id, occurred_at, actor_kind, source_category, action, outcome, details)
     VALUES (gen_random_uuid(), now(), 'system', 'system', 'operator.operations_expire', 'success',
             '{"expired": 0}'::jsonb)`,
  );
  await untilFull(
    `INSERT INTO app.rate_limit (scope, key_digest, window_start, count)
     VALUES ('rl:filler', decode(md5(random()::text) || md5(random()::text), 'hex'), now(), 1)`,
  );
}

async function free(): Promise<void> {
  await q().query("DROP TABLE IF EXISTS public.filler");
  await q().query("DELETE FROM app.rate_limit WHERE scope = 'rl:filler'");
  await q().query("CHECKPOINT");
}

interface Outcome {
  status: number;
  text: string;
  requestId: string | null;
}

async function reveal(): Promise<Outcome> {
  const response = await f.api.request("POST", `${f.env("env1a").path}/secrets/${name}/reveal`, {
    cookie: await f.tenants.cookie("ownerA"),
    body: {},
  });
  return {
    status: response.status,
    text: await response.text(),
    requestId: response.headers.get("x-request-id"),
  };
}

async function resolve(): Promise<Outcome> {
  const answer = await machineCall(f, "resolve", { token });
  return {
    status: answer.status,
    text: answer.text,
    requestId: answer.headers.get("x-request-id"),
  };
}

async function successRows(requestId: string | null): Promise<number> {
  const rows = await q().query(
    "SELECT 1 FROM audit.event WHERE request_id = $1 AND outcome = 'success'",
    [requestId],
  );
  return rows.rowCount ?? 0;
}

describe("PostgreSQL's disk is full (P-115)", () => {
  it("control: reveal and resolve succeed and carry the value", async () => {
    for (const outcome of [await reveal(), await resolve()]) {
      expect(outcome.status, outcome.text.slice(0, 200)).toBe(200);
      expect(outcome.text.includes(mark)).toBe(true);
    }
  });

  it("a reveal and a machine resolve answer 503 and hold no value; no response claims success", async () => {
    await fill();
    try {
      for (const outcome of [await reveal(), await resolve()]) {
        expect(outcome.status, outcome.text.slice(0, 200)).toBe(503);
        expect(outcome.text.includes(mark)).toBe(false);
        expect(await successRows(outcome.requestId)).toBe(0);
      }
    } finally {
      await free();
    }
  }, 600_000);

  it("after space is freed both succeed again", async () => {
    await free();
    for (const outcome of [await reveal(), await resolve()]) {
      expect(outcome.status, outcome.text.slice(0, 200)).toBe(200);
      expect(outcome.text.includes(mark)).toBe(true);
      expect(await successRows(outcome.requestId)).toBe(1);
    }
  });
});
