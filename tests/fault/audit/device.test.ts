// Run 6.1 Task C (P-110, FR-1.57, Doc 10 §4.1 rule 8): when OpenBao's audit
// device cannot write, no value leaves. The stack of this file puts the
// device's directory on a tmpfs (infra/compose/dev/audit-full.override.yml);
// the test fills it. A reveal, an export and a machine resolve then answer
// 503 with no value in their bodies, and no audit row claims a success for
// them. With space freed, the same requests succeed. Control first: with the
// device writable, all three succeed.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { machineCall } from "../../harness/machine.ts";
import { execInService } from "../../harness/stack.ts";

let f: CredentialsFixture;
let token: string;
const mark = ["MYKEY", "CANARY", randomBytes(16).toString("hex").toUpperCase()].join("_");
const name = `DEV_${randomBytes(5).toString("hex").toUpperCase()}`;

beforeAll(async () => {
  f = await createCredentialsFixture({ stackOverrides: ["audit-full.override.yml"] });
  const created = await f.create("env1a", name, `${mark}-${randomUUID()}`);
  expect(created.status).toBe(201);
  token = (await issueFor(f, "env1a")).token;
}, 900_000);

afterAll(async () => {
  await free().catch(() => undefined);
  await f.close();
});

async function fill(): Promise<void> {
  // dd stops at "No space left on device"; its exit status is that failure.
  await execInService(f.stack, "openbao", [
    "sh",
    "-c",
    "dd if=/dev/zero of=/openbao/audit/filler bs=65536 2>/dev/null; sync; true",
  ]);
  const left = await execInService(f.stack, "openbao", [
    "sh",
    "-c",
    "df -k /openbao/audit | tail -1",
  ]);
  expect(left.trim().split(/\s+/)[3]).toBe("0");
}

async function free(): Promise<void> {
  await execInService(f.stack, "openbao", ["rm", "-f", "/openbao/audit/filler"]);
}

interface Outcome {
  status: number;
  text: string;
  requestId: string | null;
}

async function reveal(): Promise<Outcome> {
  const answer = await f.send("POST", `${f.env("env1a").path}/secrets/${name}/reveal`, {
    body: {},
    key: null,
  });
  return {
    status: answer.status,
    text: answer.text,
    requestId: answer.headers.get("x-request-id"),
  };
}

async function exportAll(): Promise<Outcome> {
  await f.api.superuser.query("UPDATE auth.session SET totp_verified_at = now()");
  const response = await f.api.request("POST", `${f.env("env1a").path}/export`, {
    cookie: await f.tenants.cookie("ownerA"),
    body: { confirmed: true },
  });
  return {
    status: response.status,
    text: await response.text(),
    requestId: response.headers.get("x-request-id"),
  };
}

async function resolveAll(): Promise<Outcome> {
  const answer = await machineCall(f, "resolve", { token });
  return {
    status: answer.status,
    text: answer.text,
    requestId: answer.headers.get("x-request-id"),
  };
}

async function successRows(requestId: string | null): Promise<number> {
  const rows = await f.api.superuser.query(
    "SELECT 1 FROM audit.event WHERE request_id = $1 AND outcome = 'success'",
    [requestId],
  );
  return rows.rowCount ?? 0;
}

/** The three reads one after another (they share the environment's lock). */
const all = async (): Promise<Outcome[]> => [await reveal(), await exportAll(), await resolveAll()];

describe("a full audit device (P-110)", () => {
  it("control: with the device writable, reveal, export and resolve succeed and carry the value", async () => {
    for (const outcome of [await reveal(), await exportAll(), await resolveAll()]) {
      expect(outcome.status, outcome.text.slice(0, 200)).toBe(200);
      expect(outcome.text.includes(mark)).toBe(true);
    }
  });

  it("reveal, export and machine resolve answer 503 and their bodies hold no value; no audit row claims a success", async () => {
    await fill();
    try {
      for (const outcome of await all()) {
        expect(outcome.status, outcome.text.slice(0, 200)).toBe(503);
        expect(outcome.text.includes(mark)).toBe(false);
        expect(await successRows(outcome.requestId)).toBe(0);
      }
    } finally {
      await free();
    }
  });

  it("after space is freed the same requests succeed", async () => {
    await free();
    // The runtime identity may have to log in again after the failed calls.
    for (const outcome of [await reveal(), await exportAll(), await resolveAll()]) {
      expect(outcome.status, outcome.text.slice(0, 200)).toBe(200);
      expect(outcome.text.includes(mark)).toBe(true);
      expect(await successRows(outcome.requestId)).toBe(1);
    }
  });
});
