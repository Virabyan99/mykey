// Run 5.1 Task C (Doc 10 §4.1 rules 1 and 2): a machine token is stored
// nowhere and written nowhere. After three issuances the bytes of each token
// are searched in a dump of the database, in every line the API processes
// wrote, in audit.event, in schema jobs and in OpenBao's audit device; each
// search has a control that finds something it should.
import { credentialsIssueHandler, type Handler } from "@mykey/api";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearCredentials,
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { pgDump, readAuditLog } from "../../harness/stack.ts";

const issueRoute = ROUTES.find((route) => route.id === "credentials.issue")!;

/** A test-only copy of credentials.issue whose 201 lacks credentialId: it fails its output schema. */
const BROKEN_ROUTE: RouteDef = Object.freeze({
  ...issueRoute,
  id: "test.issue_broken",
  path: `${issueRoute.path}/test-broken`,
});
const brokenHandler: Handler = async (ctx, deps) => {
  const result = await credentialsIssueHandler(ctx, deps);
  const body = result.body as { credential: Record<string, unknown>; token: string };
  // Kept in this test's memory only, to search the log for it.
  brokenToken = body.token;
  delete body.credential.credentialId;
  return result;
};

let f: CredentialsFixture;
const issued: { credentialId: string; token: string; operationId: string }[] = [];
let brokenToken: string | null = null;

beforeAll(async () => {
  f = await createCredentialsFixture({
    processes: 2,
    routes: [{ def: BROKEN_ROUTE, handler: brokenHandler }],
  });
  for (const env of ["env1a", "env1b", "env2a"] as const) {
    issued.push(await issueFor(f, env, { ttlSeconds: 600 }));
  }
}, 600_000);

afterAll(async () => {
  for (const env of ["env1a", "env1b", "env2a"] as const) {
    await clearCredentials(f, f.env(env).environmentId);
  }
  await f.close();
});

const holds = (text: string, token: string): boolean => text.includes(token);

describe("no token bytes outside the 201", () => {
  it("the database dump holds none; it holds the credential ids (control)", async () => {
    const dump = await pgDump(f.stack, f.api.database.database);
    for (const { token, credentialId } of issued) {
      expect(holds(dump, token)).toBe(false);
      expect(holds(dump, credentialId)).toBe(true);
    }
  });

  it("no log line of either API process holds one; the route's request lines are there (control)", () => {
    const lines = [
      ...f.api.logs.map((entry) => JSON.stringify(entry)),
      f.second?.output() ?? "",
    ].join("\n");
    for (const { token } of issued) expect(holds(lines, token)).toBe(false);
    expect(
      lines.includes(
        '"path":"/v1/organizations/:org/projects/:project/environments/:env/credentials"',
      ),
    ).toBe(true);
  });

  it("audit.event and schema jobs hold none; audit holds the credential ids (control)", async () => {
    const audit = await f.api.superuser.query<{ row: string }>(
      "SELECT row_to_json(e)::text AS row FROM audit.event e",
    );
    const auditText = audit.rows.map((r) => r.row).join("\n");
    const jobs = await f.api.superuser.query<{ row: string }>(
      "SELECT row_to_json(j)::text AS row FROM jobs.job j",
    );
    const jobsText = jobs.rows.map((r) => r.row).join("\n");
    for (const { token, credentialId } of issued) {
      expect(holds(auditText, token)).toBe(false);
      expect(holds(jobsText, token)).toBe(false);
      expect(holds(auditText, credentialId)).toBe(true);
    }
  });

  it("OpenBao's audit device holds none in the clear; it recorded the creates (control)", async () => {
    const entries = await readAuditLog(f.stack);
    const raw = entries.map((entry) => entry.raw).join("\n");
    for (const { token, operationId } of issued) {
      expect(holds(raw, token)).toBe(false);
      expect(
        entries.some(
          (entry) =>
            entry.type === "request" &&
            entry.path.startsWith("auth/token/create/") &&
            entry.headers["x-mykey-operation-id"]?.[0] === operationId,
        ),
      ).toBe(true);
    }
  });

  it("a 201 that fails its output schema is logged output_invalid and not sent", async () => {
    await f.freshen();
    const answer = await f.send("POST", `${f.env("env1a").path}/credentials/test-broken`, {
      body: { name: "broken", ttlSeconds: 600 },
    });
    expect(answer.status).toBe(503);
    expect(answer.code).toBe("dependency_unavailable");
    expect(f.api.logs.some((entry) => entry.event === "output_invalid")).toBe(true);
    expect(typeof brokenToken).toBe("string");
    const token = brokenToken!;
    const lines = f.api.logs.map((entry) => JSON.stringify(entry)).join("\n");
    expect(holds(lines, token)).toBe(false);
    expect(holds(answer.text, token)).toBe(false);
  });
});
