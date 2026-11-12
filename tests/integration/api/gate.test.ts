// Run 3.1 Task D (P-43): the service gate is the first step of every request
// and is read afresh each time — no restart between closed and open.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorOf, startTestApi, type TestApi } from "../../harness/api.ts";

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi({ gate: "missing" });
});

afterAll(async () => {
  await api.close();
});

async function quarantined(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect((await errorOf(response)).code).toBe("quarantined");
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("service gate", () => {
  it("missing: /v1/version is quarantined and /health is down, with cause gate in the log", async () => {
    api.setGate("missing");
    await quarantined(await api.request("GET", "/v1/version"));
    const health = await api.request("GET", "/health");
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: "down" });
    expect(api.logs).toContainEqual(
      expect.objectContaining({ event: "health_down", cause: "gate" }),
    );
    expect(api.logs).toContainEqual(
      expect.objectContaining({ event: "gate_closed", cause: "missing" }),
    );
  });

  it("opens for the next request without a restart, and closes again", async () => {
    api.setGate("open");
    const open = await api.request("GET", "/v1/version");
    expect(open.status).toBe(200);
    expect((await api.request("GET", "/health")).status).toBe(200);
    api.setGate("closed");
    await quarantined(await api.request("GET", "/v1/version"));
    api.setGate("open");
    expect((await api.request("GET", "/v1/version")).status).toBe(200);
  });

  it("is checked before the body: an invalid body is still quarantined while closed", async () => {
    api.setGate("closed");
    await quarantined(
      await api.request("POST", `/v1/organizations/${randomUUID()}/projects`, {
        rawBody: "{",
        headers: { "content-type": "application/json" },
      }),
    );
    api.setGate("open");
    // Control: open, the same request is refused by the body rules.
    const open = await api.request("POST", `/v1/organizations/${randomUUID()}/projects`, {
      rawBody: "{",
      headers: { "content-type": "application/json" },
    });
    expect(open.status).toBe(400);
  });

  it("answers a mounted and an unmounted route alike while closed", async () => {
    api.setGate("closed");
    const mounted = await api.request("GET", `/v1/organizations/${randomUUID()}/projects`);
    const unmounted = await api.request("GET", "/v1/no-such-route");
    expect(mounted.status).toBe(503);
    expect(unmounted.status).toBe(503);
    const a = await errorOf(mounted);
    const b = await errorOf(unmounted);
    expect({ ...a, requestId: "" }).toEqual({ ...b, requestId: "" });
    api.setGate("open");
  });

  it("a record for another host or with an unknown version is closed", async () => {
    api.setGate({
      raw: JSON.stringify({
        version: 1,
        state: "open",
        gateEpoch: 1,
        hostInstanceId: randomUUID(),
        writtenAt: new Date().toISOString(),
      }),
    });
    await quarantined(await api.request("GET", "/v1/version"));
    api.setGate("open");
    expect((await api.request("GET", "/v1/version")).status).toBe(200);
  });
});
