// Run 9.3 (P-164, FR-1.98, Doc 06 §19): the agent runner, with no container.
// The runner takes one request shape and nothing else; it refuses before it
// opens its token file; it fixes the command, its arguments and the scope
// itself; and its answer has three keys from fixed enums, never the child's
// or the server's text.
import { describe, expect, it } from "vitest";
import {
  ACTION,
  CATEGORIES,
  CHILD_ARGV,
  categoryOf,
  handle,
  parseRequest,
  type RunnerDeps,
} from "../../../tools/agent-runner/runner.ts";

const CONFIG = {
  apiUrl: "https://mykey.example",
  project: "0b3a3c1e-9f01-4f43-9a51-6f1c2a1e1d7b",
  environment: "agent",
};

function fakeDeps(
  exit: { code: number | null; signal: string | null } = { code: 0, signal: null },
) {
  const calls = {
    tokenReads: 0,
    spawned: [] as { argv: readonly string[]; env: Record<string, string> }[],
    log: [] as string[],
  };
  const deps: RunnerDeps = {
    config: CONFIG,
    readToken: () => {
      calls.tokenReads += 1;
      return Promise.resolve("synthetic-machine-token");
    },
    spawn: (argv, env) => {
      calls.spawned.push({ argv, env });
      return Promise.resolve({
        ...exit,
        output: "child text: SECRET_VALUE and the server's words",
      });
    },
    log: (line) => {
      calls.log.push(line);
    },
    uuid: () => "6f1c2a1e-1d7b-4f43-9a51-0b3a3c1e9f01",
  };
  return { deps, calls };
}

describe("the agent runner's request (P-164)", () => {
  it("an extra key, a wrong action, a path, an argv, an env, a scope id or a token in the request is refused with request_refused, and the token file is never opened", async () => {
    const good = { action: ACTION, requester: "session-1234" };
    expect(parseRequest(good)).toEqual({ ok: true, requester: "session-1234" });
    const bad: unknown[] = [
      null,
      "fixture-check",
      [good],
      {},
      { action: ACTION },
      { requester: "x" },
      { ...good, extra: 1 },
      { ...good, action: "fixture-check " },
      { ...good, action: "run" },
      { ...good, path: "/etc/passwd" },
      { ...good, argv: ["env"] },
      { ...good, env: { A: "1" } },
      { ...good, project: CONFIG.project },
      { ...good, environment: "prod" },
      { ...good, token: "s.abc" },
      { ...good, requester: "" },
      { ...good, requester: "a b" },
      { ...good, requester: "x".repeat(200) },
      { ...good, requester: 7 },
      { action: ACTION, requester: "s", __proto__: { argv: ["env"] } },
    ];
    for (const body of bad) {
      expect(parseRequest(body), JSON.stringify(body)).toEqual({
        ok: false,
        category: "request_refused",
      });
      const { deps, calls } = fakeDeps();
      const answer = await handle(body, deps);
      expect(answer).toEqual({
        status: "refused",
        category: "request_refused",
        correlationId: "6f1c2a1e-1d7b-4f43-9a51-0b3a3c1e9f01",
      });
      expect(calls.tokenReads, JSON.stringify(body)).toBe(0);
      expect(calls.spawned).toEqual([]);
    }
  });

  it("an accepted request reads the token once and runs the fixed argv with the runner's own scope; the token goes on the CLI's documented input", async () => {
    const { deps, calls } = fakeDeps();
    const answer = await handle({ action: ACTION, requester: "session-1" }, deps);
    expect(answer.status).toBe("succeeded");
    expect(calls.tokenReads).toBe(1);
    expect(calls.spawned).toHaveLength(1);
    const run = calls.spawned[0];
    expect(run?.argv).toEqual(CHILD_ARGV);
    expect(CHILD_ARGV).toEqual(["secrets", "run", "--", "node", "/fixture/fixture-check.mjs"]);
    expect(run?.env).toMatchObject({
      SECRETS_API_URL: CONFIG.apiUrl,
      SECRETS_PROJECT: CONFIG.project,
      SECRETS_ENVIRONMENT: CONFIG.environment,
      SECRETS_MACHINE_TOKEN: "synthetic-machine-token",
    });
    // The runner's log names the requester and the correlation id; never the token.
    expect(calls.log.join("\n")).toContain("session-1");
    expect(calls.log.join("\n")).toContain("6f1c2a1e-1d7b-4f43-9a51-0b3a3c1e9f01");
    expect(calls.log.join("\n")).not.toContain("synthetic-machine-token");
  });
});

describe("the agent runner's answer (P-164)", () => {
  it("each CLI exit code maps to its category; an unknown code is internal", () => {
    expect(categoryOf({ code: 0, signal: null })).toEqual({ status: "succeeded", category: "ok" });
    expect(categoryOf({ code: 77, signal: null })).toEqual({
      status: "refused",
      category: "credential_refused",
    });
    expect(categoryOf({ code: 69, signal: null })).toEqual({
      status: "failed",
      category: "service_unavailable",
    });
    expect(categoryOf({ code: 65, signal: null })).toEqual({
      status: "failed",
      category: "incomplete",
    });
    expect(categoryOf({ code: 1, signal: null })).toEqual({
      status: "failed",
      category: "child_failed",
    });
    for (const code of [2, 64, 73, 75, 76, 78, 126, 127, 255]) {
      expect(categoryOf({ code, signal: null }), String(code)).toEqual({
        status: "failed",
        category: "internal",
      });
    }
  });

  it("the answer has exactly three keys from the enums; no text of the child or the server reaches it", async () => {
    for (const code of [0, 1, 65, 69, 77, 99]) {
      const { deps, calls } = fakeDeps({ code, signal: null });
      const answer = await handle({ action: ACTION, requester: "r" }, deps);
      expect(Object.keys(answer).sort()).toEqual(["category", "correlationId", "status"]);
      expect(["succeeded", "refused", "failed"]).toContain(answer.status);
      expect(CATEGORIES).toContain(answer.category);
      const text = JSON.stringify(answer);
      expect(text).not.toContain("SECRET_VALUE");
      expect(text).not.toContain("server");
      // The child's output goes to the runner's private log only.
      expect(calls.log.join("\n")).toContain("child text");
    }
  });

  it("a child killed by a signal is child_lost", async () => {
    expect(categoryOf({ code: null, signal: "SIGKILL" })).toEqual({
      status: "failed",
      category: "child_lost",
    });
    const { deps } = fakeDeps({ code: null, signal: "SIGTERM" });
    expect((await handle({ action: ACTION, requester: "r" }, deps)).category).toBe("child_lost");
  });

  it("a token that cannot be read, or a spawn that throws, is internal and says nothing more", async () => {
    const { deps } = fakeDeps();
    const unreadable = await handle(
      { action: ACTION, requester: "r" },
      { ...deps, readToken: () => Promise.reject(new Error("EACCES /run/secrets/machine-token")) },
    );
    expect(unreadable).toMatchObject({ status: "failed", category: "internal" });
    expect(JSON.stringify(unreadable)).not.toContain("EACCES");
    const broken = await handle(
      { action: ACTION, requester: "r" },
      { ...deps, spawn: () => Promise.reject(new Error("ENOENT secrets")) },
    );
    expect(broken).toMatchObject({ status: "failed", category: "internal" });
  });
});
