// Run 3.3 Task C (FR-1.07, AC-1.05): the limits hold across two API processes
// on one database — as on a host with two API containers.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiConfig } from "@mykey/api";
import { createAuth, generateKeyFiles, loadAuthKeys } from "@mykey/auth";
import { bootstrapOwner } from "@mykey/auth/operator";
import { ensureQueues } from "@mykey/operations";
import { drizzle } from "drizzle-orm/node-postgres";
import { TEST_ORIGIN, requestTo } from "../../harness/api.ts";
import { startApiProcess, type ApiProcess } from "../../harness/api-worker.ts";
import { awaitFreshWindow } from "../../harness/windows.ts";
import { prepareDatabase, type TestDatabase } from "../database/setup.ts";
import { TEST_BUILD, gateText, setIncarnation } from "../../harness/gate.ts";

let db: TestDatabase;
let directory: string;
let processes: [ApiProcess, ApiProcess];
let ca: Buffer;
const owner = {
  email: `owner-${randomBytes(4).toString("hex")}@mykey.invalid`,
  password: randomBytes(18).toString("base64url"),
};

beforeAll(async () => {
  db = await prepareDatabase();
  await ensureQueues(db.pool("migration_owner"));
  directory = mkdtempSync(join(tmpdir(), "mykey-two-api-"));
  const keysDir = mkdtempSync(join(directory, "keys-"));
  generateKeyFiles(keysDir);
  const hostInstanceId = randomUUID();
  // Run 6.7 (P-122): the record, the processes and the database name one incarnation.
  const backendIncarnation = randomUUID();
  await setIncarnation(db.pool("superuser"), backendIncarnation);
  const gatePath = join(directory, "gate.json");
  writeFileSync(
    gatePath,
    gateText({ hostInstanceId, backendIncarnation, releaseBuild: TEST_BUILD }, "open", 1),
  );
  // Both processes trust the harness's own address as the edge, so the test
  // chooses the source of each attempt through X-Forwarded-For.
  const api: ApiConfig = {
    baseUrl: TEST_ORIGIN,
    build: TEST_BUILD,
    gatePath,
    hostInstanceId,
    backendIncarnation,
    trustedProxy: "127.0.0.1",
  };
  const tls = { certPath: db.stack.api.certPath, keyPath: db.stack.api.keyPath };
  ca = readFileSync(db.stack.api.certAuthorityPath);
  processes = [
    await startApiProcess(db.targets.api_runtime, { keysDirectory: keysDir, api, tls }),
    await startApiProcess(db.targets.api_runtime, { keysDirectory: keysDir, api, tls }),
  ];
  const auth = createAuth({
    db: drizzle(db.pool("maintenance")),
    keys: loadAuthKeys(keysDir),
    baseURL: TEST_ORIGIN,
  });
  const created = await bootstrapOwner({ auth, pool: db.pool("maintenance") }, owner);
  expect(created.outcome).toBe("created");
}, 300_000);

afterAll(async () => {
  for (const process of processes) await process.kill();
  await db.drop();
  rmSync(directory, { recursive: true, force: true });
});

let addresses = 0;
const source = (): string => {
  addresses += 1;
  return `192.0.2.${String(addresses)}`;
};
const unused = (): string => `nobody-${randomBytes(4).toString("hex")}@mykey.invalid`;

async function signIn(
  which: 0 | 1,
  email: string,
  password: string,
  address: string,
): Promise<number> {
  const response = await requestTo(
    { port: processes[which].port, ca },
    "POST",
    "/v1/auth/sign-in/email",
    {
      body: { email, password },
      headers: { "x-forwarded-for": address },
    },
  );
  await response.arrayBuffer();
  return response.status;
}

const tally = (statuses: number[]) => ({
  401: statuses.filter((status) => status === 401).length,
  429: statuses.filter((status) => status === 429).length,
  other: statuses.filter((status) => status !== 401 && status !== 429).length,
});

describe("throttling across two API processes", () => {
  it("ten attempts from one source, alternating between the processes: exactly five reach the check", async () => {
    // Inside one window: the count of a new window starts at zero.
    await awaitFreshWindow(db.pool("superuser"));
    const address = source();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      statuses.push(await signIn((i % 2) as 0 | 1, unused(), "wrong-password-0", address));
    }
    expect(tally(statuses)).toEqual({ 401: 5, 429: 5, other: 0 });
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
  });

  it("five wrong passwords split 3 + 2 across the processes lock the account on both", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(await signIn(0, owner.email, "wrong-password-1", source())).toBe(401);
    }
    for (let i = 0; i < 2; i += 1) {
      expect(await signIn(1, owner.email, "wrong-password-1", source())).toBe(401);
    }
    expect(await signIn(0, owner.email, owner.password, source())).toBe(429);
    expect(await signIn(1, owner.email, owner.password, source())).toBe(429);
  });

  it("ten parallel attempts, five to each process, released together: at most five 401", async () => {
    await awaitFreshWindow(db.pool("superuser"));
    const address = source();
    const statuses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        signIn((i % 2) as 0 | 1, unused(), "wrong-password-2", address),
      ),
    );
    const counted = tally(statuses);
    expect(counted.other).toBe(0);
    expect(counted[401]).toBeLessThanOrEqual(5);
    expect(counted[401] + counted[429]).toBe(10);
  });
});
