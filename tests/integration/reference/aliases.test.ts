// Run 5.9 Task A (FR-1.52, FR-1.53): no alias, no passthrough. Every path
// below ends in the terminal 404, for the owner's session and for a machine
// bearer, and reaches no handler; while they run, OpenBao's audit device gains
// no request. A method override header does not change the method. A product
// request that carries OpenBao's own headers is made with the API's namespace
// and identity, and the header's value is nowhere in the audit device.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DENIED_ALIASES } from "@mykey/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  issueFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { ENV_NAMES, machineFetch, machinePath } from "../../harness/machine.ts";
import { readAuditLog } from "../../harness/stack.ts";

let f: CredentialsFixture;
let token: string;
let credentialId: string;
let ca: Buffer;
let cookie: string;

beforeAll(async () => {
  f = await createCredentialsFixture();
  ({ token, credentialId } = await issueFor(f, "env1a", { ttlSeconds: 600 }));
  ca = readFileSync(f.stack.api.certAuthorityPath);
  cookie = await f.tenants.cookie("ownerA");
}, 600_000);

afterAll(async () => {
  await f.revoke("env1a", credentialId);
  await f.close();
});

const namespace = (): string => `org-${f.tenants.a.organizationId}/`;
const ownAudit = async () =>
  (await readAuditLog(f.stack)).filter((entry) => entry.namespacePath === namespace());

describe("aliases and passthrough", () => {
  it("every alias is the terminal 404 for the owner and for a machine bearer, reaches no handler, and sends OpenBao nothing", async () => {
    const env = f.env("env1a");
    const id = (raw: string) => raw.replace(/:([A-Za-z]+)/g, () => randomUUID());
    const paths: { method: string; path: string }[] = [
      ...DENIED_ALIASES.map((alias) => ({ method: alias.method, path: id(alias.path) })),
      ...[
        "/v1/version/",
        "/V1/version",
        "/v2/version",
        "//v1/version",
        "/v1/openapi.yaml",
        "/v1/reference/",
        "/v1/sys/health",
        "/v1/kv/data/x",
        "/v1/auth/token/lookup-self",
        "/v1/auth/approle/login",
        `/v1/machine/projects/${env.projectId}/environments/${ENV_NAMES.env1a}/history`,
      ].map((path) => ({ method: "GET", path })),
    ];
    const reached: string[] = [];
    f.setBeforeHandler((routeId) => {
      reached.push(routeId);
      return Promise.resolve();
    });
    const before = (await ownAudit()).length;
    try {
      for (const { method, path } of paths) {
        for (const [who, init] of [
          ["owner", { headers: { cookie } }],
          ["bearer", { token }],
        ] as const) {
          const answer = await machineFetch({ port: f.api.port, ca }, method, path, init);
          expect(answer.status, `${who} ${method} ${path}`).toBe(404);
          expect(answer.code, `${who} ${method} ${path}`).toBe("not_found");
        }
      }
    } finally {
      f.setBeforeHandler(null);
    }
    expect(reached).toEqual([]);
    expect((await ownAudit()).length).toBe(before);
  });

  it("X-HTTP-Method-Override: DELETE on a GET stays a GET", async () => {
    const answer = await machineFetch(
      { port: f.api.port, ca },
      "GET",
      machinePath(f.env("env1a").projectId, ENV_NAMES.env1a, "keys"),
      { token, headers: { "x-http-method-override": "DELETE", "x-method-override": "DELETE" } },
    );
    expect(answer.status).toBe(200);
    expect(Array.isArray(answer.body.names)).toBe(true);
    const owner = await machineFetch({ port: f.api.port, ca }, "GET", "/v1/organizations", {
      headers: { cookie, "x-http-method-override": "DELETE" },
    });
    expect(owner.status).toBe(200);
    expect(Array.isArray(owner.body.organizations)).toBe(true);
  });

  it("X-Vault-Token and X-Vault-Namespace: root on a product request: OpenBao sees the API's namespace and identity, and the value nowhere", async () => {
    const planted = `hvs.${randomBytes(18).toString("base64url")}`;
    const before = (await readAuditLog(f.stack)).length;
    const answer = await machineFetch(
      { port: f.api.port, ca },
      "POST",
      machinePath(f.env("env1a").projectId, ENV_NAMES.env1a, "resolve"),
      { token, headers: { "x-vault-token": planted, "x-vault-namespace": "root" } },
    );
    expect(answer.status, answer.text.slice(0, 200)).toBe(200);
    const after = (await readAuditLog(f.stack)).slice(before);
    const mine = after.filter((entry) => entry.namespacePath === namespace());
    // Control: the request was made, in the API's namespace, as the presented machine token.
    expect(mine.some((entry) => entry.path === "auth/token/lookup-self")).toBe(true);
    expect(mine.some((entry) => entry.path.startsWith("kv/"))).toBe(true);
    expect(after.some((entry) => entry.raw.includes(planted))).toBe(false);
    for (const entry of mine) {
      expect(entry.headers["x-vault-namespace"] ?? []).not.toContain("root");
    }
  });
});
