// Run 8.2 (P-151): hidden and absent take the same time. Over 100 interleaved
// pairs the medians differ by less than 20 ms: wide enough for a laptop, and
// enough to find a missing password hash or a skipped query, not a
// microsecond. The limits are lifted for this file: the test API's rate
// limits never refuse, and the sign-in throttle's counters are cleared before
// every pair. The medians are printed for the run note.
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolationFixture, type IsolationFixture } from "./fixture.ts";

let fx: IsolationFixture;

beforeAll(async () => {
  fx = await createIsolationFixture();
}, 900_000);

afterAll(async () => {
  await (fx as IsolationFixture | undefined)?.close();
});

const PAIRS = 100;
const BOUND_MS = 20;

const median = (values: number[]): number => {
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

/** Interleaved pairs in a random order each; answers the two medians and the statuses seen. */
async function pairs(
  hidden: () => Promise<Response>,
  absent: () => Promise<Response>,
  before?: () => Promise<void>,
): Promise<{ hidden: number; absent: number; statuses: Set<string> }> {
  const times = { hidden: [] as number[], absent: [] as number[] };
  const statuses = new Set<string>();
  const once = async (kind: "hidden" | "absent") => {
    await before?.();
    const start = performance.now();
    const response = await (kind === "hidden" ? hidden() : absent());
    const text = await response.text();
    times[kind].push(performance.now() - start);
    statuses.add(`${kind} ${String(response.status)} ${text.replace(/"requestId":"[^"]+"/, "")}`);
  };
  for (let i = 0; i < PAIRS; i += 1) {
    const first = randomBytes(1)[0]! % 2 === 0 ? "hidden" : "absent";
    await once(first);
    await once(first === "hidden" ? "absent" : "hidden");
  }
  return { hidden: median(times.hidden), absent: median(times.absent), statuses };
}

const sameAnswer = (statuses: Set<string>): boolean =>
  new Set([...statuses].map((line) => line.replace(/^(hidden|absent) /, ""))).size === 1;

describe("hidden and absent take the same time", () => {
  it("hidden and absent take the same time: over 100 interleaved pairs the medians differ by less than 20 ms on a project read, a reveal and an operation status", async () => {
    const a = fx.a;
    const b = fx.b;
    const reads: [
      string,
      (
        org: string,
        project: string,
        env: string,
        name: string,
        op: string,
      ) => [string, string, unknown],
    ][] = [
      [
        "project read",
        (org, project) => [
          "GET",
          `/v1/organizations/${org}/projects/${project}/environments`,
          undefined,
        ],
      ],
      [
        "reveal",
        (org, project, env, name) => [
          "POST",
          `/v1/organizations/${org}/projects/${project}/environments/${env}/secrets/${name}/reveal`,
          {},
        ],
      ],
      [
        "operation status",
        (_org, _project, _env, _name, op) => ["GET", `/v1/operations/${op}`, undefined],
      ],
    ];
    const lines: string[] = [];
    for (const [label, shape] of reads) {
      const ask = (ids: [string, string, string, string, string]) => {
        const [method, path, body] = shape(...ids);
        return a.request(method, path, {
          cookie: b.owner,
          ...(body === undefined ? {} : { body }),
        });
      };
      const result = await pairs(
        () =>
          ask([
            a.organizationId,
            a.ids.projectId,
            a.ids.environmentId,
            a.ids.secretName,
            a.ids.operationId,
          ]),
        () =>
          ask([
            randomUUID(),
            randomUUID(),
            randomUUID(),
            `ISO_R_${randomBytes(5).toString("hex").toUpperCase()}`,
            randomUUID(),
          ]),
      );
      lines.push(
        `${label}: hidden ${result.hidden.toFixed(1)} ms, absent ${result.absent.toFixed(1)} ms`,
      );
      expect(sameAnswer(result.statuses), `${label}: ${[...result.statuses].join(" | ")}`).toBe(
        true,
      );
      expect(Math.abs(result.hidden - result.absent), label).toBeLessThan(BOUND_MS);
    }
    console.log(`timing medians (${String(PAIRS)} pairs): ${lines.join("; ")}`);
  }, 600_000);

  it("a sign-in with an unknown address and with a known address and a wrong password: the same body, and medians within 20 ms", async () => {
    const known = fx.f.tenants.credentials("readerA").email;
    const clear = async () => {
      await fx.f.api.superuser.query("DELETE FROM app.rate_limit");
    };
    const signIn = (email: string) =>
      fx.a.request("POST", "/v1/auth/sign-in/email", {
        body: { email, password: `wrong-${randomBytes(8).toString("hex")}` },
      });
    const result = await pairs(
      () => signIn(known),
      () => signIn(`nobody-${randomBytes(6).toString("hex")}@mykey-test.invalid`),
      clear,
    );
    console.log(
      `sign-in medians (${String(PAIRS)} pairs): known ${result.hidden.toFixed(1)} ms, unknown ${result.absent.toFixed(1)} ms`,
    );
    expect(sameAnswer(result.statuses), [...result.statuses].join(" | ")).toBe(true);
    expect(Math.abs(result.hidden - result.absent)).toBeLessThan(BOUND_MS);
    await clear();
  }, 600_000);
});
