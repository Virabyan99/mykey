// Run 6.3 Task B (P-114, D-49): the in-flight gate of a process, the large
// slots taken before a body is read, and the request timeout. Routes answer
// through the stub, which holds a request until the test releases it.
import { readFileSync } from "node:fs";
import tls from "node:tls";
import { LIMITS } from "@mykey/contracts";
import type { LogEntry } from "@mykey/api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestApi, type TestApi } from "../../harness/api.ts";
import { createTenants, type Tenants } from "../../harness/tenants.ts";

let api: TestApi;
let tenants: Tenants;
/** Requests held in the stub, by route id; each resolves when released. */
const held: { routeId: string; release: () => void }[] = [];
let entered: (() => void) | null = null;

beforeAll(async () => {
  api = await startTestApi({
    stubs: true,
    stubRoutes: ["secrets.list", "import.preview"],
    stubHook: async (routeId) => {
      await new Promise<void>((release) => {
        held.push({ routeId, release });
        entered?.();
      });
    },
  });
  tenants = await createTenants(api);
}, 300_000);

afterEach(() => {
  for (const request of held.splice(0)) request.release();
});

afterAll(async () => {
  await api.close();
});

const envPath = () =>
  `/v1/organizations/${tenants.a.organizationId}/projects/${tenants.a.project1}/environments/${tenants.a.env1a}`;

/** Resolves when `n` requests are held in the stub. */
async function heldCount(n: number): Promise<void> {
  while (held.length < n) {
    await new Promise<void>((resolve) => {
      entered = resolve;
      setTimeout(resolve, 50);
    });
  }
}

const list = async (): Promise<Response> =>
  api.request("GET", `${envPath()}/secrets`, { cookie: await tenants.cookie("ownerA") });

const preview = async (bytes: number, cookie?: string | null): Promise<Response> =>
  api.request("POST", `${envPath()}/import/preview`, {
    rawBody: "A=".concat("x".repeat(Math.max(0, bytes - 3)), "\n"),
    headers: { "content-type": "text/plain; charset=utf-8" },
    ...(cookie === null ? {} : { cookie: cookie ?? (await tenants.cookie("ownerA")) }),
  });

const codeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

/** The request log line of the answer with this request id. */
const lineOf = (response: Response) =>
  api.logs.find(
    (entry): entry is Extract<LogEntry, { event: "request" }> =>
      entry.event === "request" && entry.requestId === response.headers.get("x-request-id"),
  );

/**
 * A TLS connection that sends the headers of a request with a body and then
 * nothing; resolves with the seconds until the server closed it.
 */
function silentRequest(path: string, cookie: string, contentLength: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = tls.connect({
      host: "127.0.0.1",
      port: api.port,
      ca: readFileSync(api.database.stack.api.certAuthorityPath),
      servername: "localhost",
    });
    socket.on("secureConnect", () => {
      socket.write(
        [
          `POST ${path} HTTP/1.1`,
          "host: localhost",
          `origin: ${api.origin}`,
          "sec-fetch-site: same-origin",
          `cookie: ${cookie}`,
          "content-type: text/plain; charset=utf-8",
          `content-length: ${String(contentLength)}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", () => undefined);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      resolve((Date.now() - started) / 1000);
    });
    setTimeout(() => {
      socket.destroy();
      reject(new Error("the server kept a silent request for 90 s"));
    }, 90_000);
  });
}

describe("the in-flight gate (64 per process)", () => {
  it("64 requests held; the 65th is 503 busy with connection: close; after one finishes the next is served", async () => {
    const max = LIMITS.concurrency.httpPerProcess;
    const answers = Array.from({ length: max }, () => list());
    await heldCount(max);
    const refused = await list();
    expect(refused.status).toBe(503);
    expect(refused.headers.get("connection")).toBe("close");
    expect(await codeOf(refused)).toBe("busy");
    // The one released is the first that reached the stub, which need not be the first sent.
    held.shift()?.release();
    expect((await Promise.race(answers)).status).toBe(204);
    const next = list();
    await heldCount(max);
    for (const request of held.splice(0)) request.release();
    expect((await next).status).toBe(204);
    expect((await Promise.all(answers)).every((answer) => answer.status === 204)).toBe(true);
  }, 120_000);
});

describe("the large slots (2 per process), before the body", () => {
  it("a third import while two are running is refused before its body is read", async () => {
    const first = preview(1000);
    const second = preview(1000);
    await heldCount(2);
    const third = await preview(LIMITS.body.dotenvMaxBytes);
    expect(third.status).toBe(503);
    expect(await codeOf(third)).toBe("busy");
    expect(lineOf(third)?.bodyBytesRead).toBe(0);
    for (const request of held.splice(0)) request.release();
    expect((await first).status).toBe(204);
    expect((await second).status).toBe(204);
  }, 120_000);

  it("an unauthenticated large request never takes a slot: 401 while both are taken, and both free after", async () => {
    const first = preview(1000);
    const second = preview(1000);
    await heldCount(2);
    const anonymous = await preview(LIMITS.body.dotenvMaxBytes, null);
    expect(anonymous.status).toBe(401);
    expect(lineOf(anonymous)?.bodyBytesRead).toBe(0);
    for (const request of held.splice(0)) request.release();
    await Promise.all([first, second]);
    const again = [preview(1000), preview(1000)];
    await heldCount(2);
    for (const request of held.splice(0)) request.release();
    expect((await Promise.all(again)).map((answer) => answer.status)).toEqual([204, 204]);
  }, 120_000);
});

describe("the request timeout", () => {
  it("a request that sends its headers and then nothing is closed after 30 s, and its slots are free", async () => {
    const cookie = await tenants.cookie("ownerA");
    const silent = silentRequest(`${envPath()}/import/preview`, cookie, 1000);
    // The silent request holds one large slot; one more import fits, the next does not.
    const other = preview(1000);
    await heldCount(1);
    let busy = await preview(1000);
    for (let tries = 0; busy.status !== 503 && tries < 20; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      busy = await preview(1000);
    }
    expect(busy.status).toBe(503);
    const seconds = await silent;
    expect(seconds).toBeGreaterThanOrEqual(LIMITS.deadlines.requestMs / 1000 - 1);
    expect(seconds).toBeLessThan(LIMITS.deadlines.requestMs / 1000 + 10);
    const now = preview(1000);
    await heldCount(2);
    for (const request of held.splice(0)) request.release();
    expect((await now).status).toBe(204);
    expect((await other).status).toBe(204);
  }, 120_000);
});
