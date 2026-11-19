// Run 7.1 Task A (P-134): the shell inside the real app. It answers where the
// terminal 404 would be, so it passes the gate and the request log like every
// request; a path outside the table keeps the JSON 404 that other suites rely
// on as a proof (status.staging.test.ts: the API has no diagnostic route).
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHELL_HEADERS } from "@mykey/api";
import { errorOf, startTestApi, type TestApi } from "../../harness/api.ts";
import { FIXTURE_DIST, writeFixtureDist } from "../../harness/web-dist.ts";

let directory: string;
let api: TestApi;

beforeAll(async () => {
  directory = writeFixtureDist();
  api = await startTestApi({ dispatcher: false, config: { webDirectory: directory } });
});

afterAll(async () => {
  await api.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the workspace's shell in the app", () => {
  it("GET / answers the index with the shell's headers, no-store and a request id", async () => {
    const response = await api.request("GET", "/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(FIXTURE_DIST["index.html"]!.text);
    for (const [name, value] of Object.entries(SHELL_HEADERS)) {
      expect(response.headers.get(name), name).toBe(value);
    }
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("an asset of the manifest answers; an unknown one is the JSON 404", async () => {
    const script = await api.request("GET", "/assets/app-BBBB2222.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toBe(FIXTURE_DIST["assets/app-BBBB2222.js"]!.text);
    const unknown = await api.request("GET", "/assets/unknown.js");
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe("not_found");
  });

  it.each(["/metrics", "/debug", "/status", "/dashboard/", "/v1/anything", "/index.html"])(
    "%s still answers the JSON 404",
    async (path) => {
      const response = await api.request("GET", path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
      expect((await errorOf(response)).code).toBe("not_found");
    },
  );

  it("a POST to a shell path answers 404", async () => {
    const response = await api.request("POST", "/", { body: {} });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("not_found");
  });

  it("a closed gate answers quarantined for the shell too", async () => {
    api.setGate("closed");
    try {
      for (const path of ["/", "/sign-in", "/assets/app-BBBB2222.js"]) {
        const response = await api.request("GET", path);
        expect(response.status, path).toBe(503);
        expect((await errorOf(response)).code, path).toBe("quarantined");
      }
    } finally {
      api.setGate("open");
    }
  });

  it("a shell answer is logged as a request with no route pattern", async () => {
    api.logs.length = 0;
    await api.request("GET", "/sign-in");
    const entry = api.logs.find((candidate) => candidate.event === "request");
    expect(entry).toMatchObject({ method: "GET", path: null, status: 200 });
  });

  it("without a dist the shell paths answer 503 and one web_shell_missing line is logged", async () => {
    const bare = await startTestApi({
      dispatcher: false,
      config: { webDirectory: join(tmpdir(), "mykey-web-dist-absent") },
    });
    try {
      expect(bare.logs.filter((entry) => entry.event === "web_shell_missing")).toHaveLength(1);
      for (const path of ["/", "/account", "/assets/app-BBBB2222.js"]) {
        const response = await bare.request("GET", path);
        expect(response.status, path).toBe(503);
        expect((await errorOf(response)).code, path).toBe("dependency_unavailable");
      }
      const other = await bare.request("GET", "/metrics");
      expect(other.status).toBe(404);
    } finally {
      await bare.close();
    }
    expect(api.logs.filter((entry) => entry.event === "web_shell_missing")).toHaveLength(0);
  });

  it("the harness's default has no workspace: / is the terminal 404 and nothing is logged", async () => {
    const plain = await startTestApi({ dispatcher: false });
    try {
      const response = await plain.request("GET", "/");
      expect(response.status).toBe(404);
      expect(plain.logs.filter((entry) => entry.event === "web_shell_missing")).toHaveLength(0);
    } finally {
      await plain.close();
    }
  });
});
