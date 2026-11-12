// Run 2.6: the Worker's routes. A wrong token, the token of the other host and
// an unknown host are all 404 and change nothing.
import { describe, expect, it } from "vitest";
import { handleRequest, type ProbeEnv } from "@mykey/probe";
import { MemoryStore } from "@mykey/probe/store";

const env = {
  HOSTS: JSON.stringify([
    { name: "staging", hostname: "mykey-staging.example.test" },
    { name: "prod", hostname: "mykey.example.test" },
  ]),
  HEARTBEAT_TOKEN_STAGING: "staging-token-synthetic-0123456789",
  HEARTBEAT_TOKEN_PROD: "prod-token-synthetic-0123456789",
  READ_TOKEN: "read-token-synthetic-0123456789",
} as unknown as ProbeEnv;

const NOW = 1_800_000_000_000;
const body = JSON.stringify({ bootId: "boot-1", sealed: null, kmsReachable: null });

const heartbeat = (host: string, token: string, payload = body): Request =>
  new Request(`https://probe.example.test/v1/heartbeat/${host}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: payload,
  });

describe("heartbeat route", () => {
  it("records a heartbeat with the host's own token, stamped with the Worker's clock (control)", async () => {
    const store = new MemoryStore();
    const response = await handleRequest(
      heartbeat("staging", "staging-token-synthetic-0123456789"),
      env,
      store,
      NOW,
    );
    expect(response.status).toBe(204);
    expect((await store.load("staging", NOW)).lastHeartbeatAt).toBe(NOW);
  });

  it("answers 404 and changes nothing for a wrong token, the other host's token and an unknown host", async () => {
    const store = new MemoryStore();
    const cases = [
      heartbeat("staging", "wrong-token-synthetic-0123456789"),
      heartbeat("staging", "prod-token-synthetic-0123456789"),
      heartbeat("nowhere", "staging-token-synthetic-0123456789"),
      heartbeat("staging", ""),
    ];
    for (const request of cases) {
      const response = await handleRequest(request, env, store, NOW);
      expect(response.status).toBe(404);
    }
    expect(store.writes).toBe(0);
  });

  it("refuses a body that is not exactly a heartbeat, with the right token", async () => {
    const store = new MemoryStore();
    for (const payload of [
      "not json",
      JSON.stringify({ bootId: "b", sealed: "yes", kmsReachable: null }),
      JSON.stringify({ bootId: "b", sealed: null, kmsReachable: null, at: 1 }),
    ]) {
      const response = await handleRequest(
        heartbeat("staging", "staging-token-synthetic-0123456789", payload),
        env,
        store,
        NOW,
      );
      expect(response.status, payload).toBe(400);
    }
    expect(store.writes).toBe(0);
  });
});

describe("state route and everything else", () => {
  it("shows a host's state only with the read token", async () => {
    const store = new MemoryStore();
    const read = (token: string, host = "staging") =>
      handleRequest(
        new Request(`https://probe.example.test/v1/state/${host}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        env,
        store,
        NOW,
      );
    expect((await read("read-token-synthetic-0123456789")).status).toBe(200);
    expect((await read("staging-token-synthetic-0123456789")).status).toBe(404);
    expect((await read("read-token-synthetic-0123456789", "nowhere")).status).toBe(404);
  });

  it("answers 404 for any other path or method", async () => {
    const store = new MemoryStore();
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/v1/heartbeat/staging"],
      ["POST", "/v1/state/staging"],
      ["GET", "/v1/nothing"],
    ] as const) {
      const response = await handleRequest(
        new Request(`https://probe.example.test${path}`, { method }),
        env,
        store,
        NOW,
      );
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});
