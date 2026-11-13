// Run 3.4 Task B: a TOTP step used once stays used across an API restart and
// a PostgreSQL restart, inside the same 30-second step (the test passes `now`).
// The suite owns its stack, because it restarts PostgreSQL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeAt, stepAt } from "@mykey/auth";
import {
  enrollOwner,
  seedOwner,
  sessionCookieOf,
  startTestApi,
  type EnrolledOwner,
  type TestApi,
} from "../../harness/api.ts";
import { restartService, startStack, type Stack } from "../../harness/stack.ts";

let stack: Stack;
let api: TestApi;
let owner: EnrolledOwner;
let sources = 0;
const from = (): Record<string, string> => {
  sources += 1;
  return { "x-forwarded-for": `198.51.100.${String(sources)}` };
};

beforeAll(async () => {
  stack = await startStack();
  api = await startTestApi({
    stack,
    relayDatabase: true,
    stubs: true,
    config: { trustedProxy: "127.0.0.1" },
  });
  owner = await enrollOwner(api, await seedOwner(api), { source: "198.51.100.250" });
}, 300_000);

afterAll(async () => {
  await api.close();
  await stack.stop();
});

async function passwordSession(target: TestApi): Promise<string> {
  const response = await target.request("POST", "/v1/auth/sign-in/email", {
    body: { email: owner.email, password: owner.password },
    headers: from(),
  });
  expect(response.status).toBe(200);
  return sessionCookieOf(response);
}

function verify(target: TestApi, cookie: string, code: string, now: Date): Promise<Response> {
  return target.request("POST", "/v1/auth/totp/verify", {
    body: { code },
    cookie,
    headers: { ...from(), "x-test-now": now.toISOString() },
  });
}

describe("a used step across restarts", () => {
  it("is refused after an API restart and after a PostgreSQL restart", async () => {
    const now = new Date(Date.now() + 3_600_000);
    const code = codeAt(owner.seed, stepAt(now));
    expect((await verify(api, await passwordSession(api), code, now)).status).toBe(200);

    // The same database behind a new API (process state gone).
    const restarted = await api.restart();
    expect((await verify(restarted, await passwordSession(restarted), code, now)).status).toBe(401);

    await restartService(stack, "postgres");
    let cookie: string | undefined;
    for (let attempt = 0; attempt < 30 && cookie === undefined; attempt += 1) {
      cookie = await passwordSession(restarted).catch(() => undefined);
      if (cookie === undefined) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(cookie).toBeDefined();
    expect((await verify(restarted, cookie!, code, now)).status).toBe(401);
    // Control: the next step works.
    const next = codeAt(owner.seed, stepAt(now) + 1);
    expect((await verify(restarted, await passwordSession(restarted), next, now)).status).toBe(200);
    api = restarted;
  });
});
