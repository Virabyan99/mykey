// Run 6.4 Task B (P-116, FR-1.62, AC-1.18): /health is down when an audit row
// cannot be written, or when OpenBao's audit device cannot write; up again
// when either is repaired. The audit probe inserts one row and rolls it back:
// it leaves no row. The body is exactly {"status":"up"} or {"status":"down"},
// and the down answer carries the same headers as the up answer. The stack of
// this file has OpenBao's audit device on a small tmpfs
// (infra/compose/dev/audit-full.override.yml), so the test can fill it.
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEEP_REUSE_MS, type LogEntry } from "@mykey/api";
import {
  createCredentialsFixture,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { execInService } from "../../harness/stack.ts";

let f: CredentialsFixture;
let upHeaders: string[] = [];

beforeAll(async () => {
  f = await createCredentialsFixture({ stackOverrides: ["audit-full.override.yml"] });
}, 900_000);

afterAll(async () => {
  await free().catch(() => undefined);
  await f.api.superuser.query("GRANT INSERT ON audit.event TO api_runtime").catch(() => undefined);
  await f.close();
});

interface Answer {
  status: number;
  text: string;
  headers: string[];
}

async function health(): Promise<Answer> {
  const response = await f.api.request("GET", "/health", {});
  const headers = [...response.headers.keys()].filter((name) => name !== "date").sort();
  return { status: response.status, text: await response.text(), headers };
}

/** Asks until the answer is `status`, for at most the deep checks' reuse and a margin. */
async function until(status: number): Promise<Answer> {
  const deadline = Date.now() + DEEP_REUSE_MS + 10_000;
  for (;;) {
    const answer = await health();
    if (answer.status === status || Date.now() > deadline) return answer;
    await sleep(1_000);
  }
}

const auditRows = async (): Promise<number> =>
  Number(
    (await f.api.superuser.query<{ n: string }>("SELECT count(*) AS n FROM audit.event")).rows[0]
      ?.n,
  );

function downCauses(from: number): string[] {
  return f.api.logs
    .slice(from)
    .filter(
      (entry): entry is Extract<LogEntry, { event: "health_down" }> =>
        entry.event === "health_down",
    )
    .map((entry) => entry.cause);
}

async function fill(): Promise<void> {
  await execInService(f.stack, "openbao", [
    "sh",
    "-c",
    "dd if=/dev/zero of=/openbao/audit/filler bs=65536 2>/dev/null; sync; true",
  ]);
}

async function free(): Promise<void> {
  await execInService(f.stack, "openbao", ["rm", "-f", "/openbao/audit/filler"]);
}

describe("readiness covers audit (P-116)", () => {
  it('control: up, exactly {"status":"up"}; the audit probe leaves no row', async () => {
    const before = await auditRows();
    const answer = await until(200);
    const logged = f.api.logs.filter((entry) => entry.event === "health_down");
    expect(answer.status, JSON.stringify(logged.slice(-1))).toBe(200);
    expect(answer.text).toBe('{"status":"up"}');
    upHeaders = answer.headers;
    expect(await auditRows()).toBe(before);
  });

  it('503 {"status":"down"} while api_runtime cannot insert into audit.event, 200 again afterwards', async () => {
    const from = f.api.logs.length;
    await f.api.superuser.query("REVOKE INSERT ON audit.event FROM api_runtime");
    try {
      const down = await until(503);
      expect(down.status).toBe(503);
      expect(down.text).toBe('{"status":"down"}');
      expect(down.headers).toEqual(upHeaders);
      expect(downCauses(from)).toContain("audit_unwritable");
    } finally {
      await f.api.superuser.query("GRANT INSERT ON audit.event TO api_runtime");
    }
    const up = await until(200);
    expect(up.status).toBe(200);
    expect(up.text).toBe('{"status":"up"}');
  }, 120_000);

  it("503 while OpenBao's audit device is full, 200 again once it has room", async () => {
    const from = f.api.logs.length;
    await fill();
    try {
      const down = await until(503);
      expect(down.status).toBe(503);
      expect(down.text).toBe('{"status":"down"}');
      expect(down.headers).toEqual(upHeaders);
      expect(downCauses(from)).toContain("openbao_audit");
    } finally {
      await free();
    }
    const up = await until(200);
    expect(up.status).toBe(200);
    expect(up.text).toBe('{"status":"up"}');
  }, 120_000);
});
