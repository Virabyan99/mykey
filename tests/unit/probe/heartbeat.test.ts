// Run 6.4 Task A (P-116): the Worker accepts the three heartbeat shapes of
// Sessions 2–4 and version 2, strictly, so hosts and Worker can be deployed
// minutes apart without a host going heartbeat_missing.
import { describe, expect, it } from "vitest";
import { handleRequest, type ProbeEnv } from "@mykey/probe";
import { readHeartbeat } from "@mykey/probe/evaluate";
import { MemoryStore } from "@mykey/probe/store";

const NOW = 1_800_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

export const goodChecks = (): Record<string, unknown> => ({
  sealed: false,
  kmsReachable: true,
  reviewOpen: 0,
  operationsUnresolved: 0,
  firewallLoaded: true,
  diskLow: false,
  auditFailing: false,
  captureSince: null,
  backup: { expected: false, newestEligibleCaptureAt: null },
  certificates: [{ name: "public", notBefore: iso(NOW - 10 * DAY), notAfter: iso(NOW + 80 * DAY) }],
  credentialExpiring: 0,
  unitsFailed: [],
});
const v2 = (
  checks: Record<string, unknown> = goodChecks(),
  extra: Record<string, unknown> = {},
) => ({
  v: 2,
  bootId: "boot-1",
  observedAt: iso(NOW),
  checks,
  ...extra,
});
const without = (key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(goodChecks()).filter(([name]) => name !== key));

describe("readHeartbeat (P-116)", () => {
  it("accepts the three old key sets unchanged", () => {
    for (const beat of [
      { bootId: "b", sealed: null, kmsReachable: true },
      { bootId: "b", sealed: false, kmsReachable: null, reviewOpen: 2 },
      { bootId: "b", sealed: true, kmsReachable: false, reviewOpen: 0, operationsUnresolved: 1 },
    ]) {
      expect(readHeartbeat(beat)).toEqual(beat);
    }
  });

  it("accepts version 2, with every check known, null, or captureSince absent", () => {
    expect(readHeartbeat(v2())).toEqual(v2());
    const nulls = Object.fromEntries(Object.keys(goodChecks()).map((key) => [key, null]));
    expect(readHeartbeat(v2(nulls))).toEqual(v2(nulls));
    expect(readHeartbeat(v2(without("captureSince")))).toEqual(v2(without("captureSince")));
    const busy = {
      ...goodChecks(),
      captureSince: iso(NOW - 60_000),
      unitsFailed: ["mykey-backup.service"],
    };
    expect(readHeartbeat(v2(busy))).toEqual(v2(busy));
  });

  it("refuses version 2 with an unknown key, a missing check or a wrong type", () => {
    const refused: unknown[] = [
      v2(goodChecks(), { extra: 1 }),
      { ...v2(), v: 3 },
      { ...v2(), observedAt: "yesterday" },
      { ...v2(), bootId: "x".repeat(65) },
      v2({ ...goodChecks(), extra: true }),
      v2(without("diskLow")),
      v2(without("backup")),
      v2(without("unitsFailed")),
      v2({ ...goodChecks(), diskLow: "no" }),
      v2({ ...goodChecks(), reviewOpen: -1 }),
      v2({ ...goodChecks(), credentialExpiring: 1.5 }),
      v2({ ...goodChecks(), captureSince: 5 }),
      v2({ ...goodChecks(), backup: { expected: true } }),
      v2({ ...goodChecks(), backup: { expected: "yes", newestEligibleCaptureAt: null } }),
      v2({ ...goodChecks(), certificates: [{ name: "public", notAfter: iso(NOW) }] }),
      v2({
        ...goodChecks(),
        certificates: [{ name: "public", notBefore: iso(NOW), notAfter: iso(NOW), path: "/etc" }],
      }),
      v2({ ...goodChecks(), unitsFailed: "mykey-backup.service" }),
      v2({ ...goodChecks(), unitsFailed: ["has a space"] }),
      v2("checks" as never),
      null,
      [],
    ];
    for (const body of refused) expect(readHeartbeat(body), JSON.stringify(body)).toBeNull();
  });
});

describe("heartbeat route, version 2", () => {
  const env = {
    HOSTS: JSON.stringify([{ name: "staging", hostname: "mykey-staging.example.test" }]),
    HEARTBEAT_TOKEN_STAGING: "staging-token-synthetic-0123456789",
    READ_TOKEN: "read-token-synthetic-0123456789",
  } as unknown as ProbeEnv;

  it("stores a version 2 heartbeat with the Worker's clock; refuses a broken one", async () => {
    const store = new MemoryStore();
    const send = (body: unknown) =>
      handleRequest(
        new Request("https://probe.example.test/v1/heartbeat/staging", {
          method: "POST",
          headers: { authorization: "Bearer staging-token-synthetic-0123456789" },
          body: JSON.stringify(body),
        }),
        env,
        store,
        NOW,
      );
    expect((await send(v2())).status).toBe(204);
    const state = await store.load("staging", NOW);
    expect(state.lastHeartbeatAt).toBe(NOW);
    expect(state.lastHeartbeat).toEqual(v2());
    expect((await send(v2(without("diskLow")))).status).toBe(400);
  });
});

describe("state route's evaluatedAt and the test alert (P-117)", () => {
  const env = {
    HOSTS: JSON.stringify([{ name: "staging", hostname: "mykey-staging.example.test" }]),
    HEARTBEAT_TOKEN_STAGING: "staging-token-synthetic-0123456789",
    READ_TOKEN: "read-token-synthetic-0123456789",
    SINK: "webhook",
    WEBHOOK_URL: "https://sink.example.test/hook",
  } as unknown as ProbeEnv;
  const call = (
    method: string,
    path: string,
    token: string,
    store: MemoryStore,
    fetcher?: typeof fetch,
  ) =>
    handleRequest(
      new Request(`https://probe.example.test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
      store,
      NOW,
      fetcher,
    );

  it("evaluatedAt is null before the first evaluation and the evaluation's time afterwards", async () => {
    const store = new MemoryStore();
    const before = await call("GET", "/v1/state/staging", "read-token-synthetic-0123456789", store);
    expect(((await before.json()) as { evaluatedAt: unknown }).evaluatedAt).toBeNull();
    await store.saveEvaluation(await store.load("staging", NOW), NOW - 30_000);
    const after = await call("GET", "/v1/state/staging", "read-token-synthetic-0123456789", store);
    expect(((await after.json()) as { evaluatedAt: unknown }).evaluatedAt).toBe(NOW - 30_000);
  });

  it("the test alert is sent with the read token and logged; any other token is 404 and sends nothing", async () => {
    const store = new MemoryStore();
    const sent: string[] = [];
    const fetcher = ((_url: string, init: RequestInit) => {
      sent.push(init.body as string);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const wrong = await call(
      "POST",
      "/v1/test-alert/staging",
      "staging-token-synthetic-0123456789",
      store,
      fetcher,
    );
    expect(wrong.status).toBe(404);
    expect(sent).toEqual([]);
    const right = await call(
      "POST",
      "/v1/test-alert/staging",
      "read-token-synthetic-0123456789",
      store,
      fetcher,
    );
    expect(right.status).toBe(204);
    expect(sent).toEqual([JSON.stringify({ text: "MyKey staging: test_alert" })]);
    expect(store.alerts).toEqual([
      { host: "staging", condition: "test_alert", kind: "test", since: NOW, at: NOW, delivered: 1 },
    ]);
    const failing = (() =>
      Promise.resolve(new Response(null, { status: 500 }))) as unknown as typeof fetch;
    expect(
      (
        await call(
          "POST",
          "/v1/test-alert/staging",
          "read-token-synthetic-0123456789",
          store,
          failing,
        )
      ).status,
    ).toBe(502);
    expect(store.alerts.at(-1)?.delivered).toBe(0);
  });
});
