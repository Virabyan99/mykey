// Run 5.9 Task A (P-101, FR-1.52, FR-1.53): GET /v1/openapi.json is the
// generated document reduced to what this build serves. Owner and admin of the
// process's organization get it; every member and the owner of another
// organization get the hidden 404, the same as an unknown path. Every
// operation it lists is answered by a handler of this build; every contract
// route without one is absent and ends in the terminal answer.
import { randomUUID } from "node:crypto";
import { handledRouteIds } from "@mykey/api";
import { ROUTES, type RouteDef } from "@mykey/contracts";
import { validate } from "@scalar/openapi-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCredentialsFixture,
  issueFor,
  issueRuntimeFor,
  type CredentialsFixture,
} from "../../harness/credentials-fixture.ts";
import { sessionCookieOf } from "../../harness/api.ts";
import { ENV_NAMES, machineFetch } from "../../harness/machine.ts";
import { readFileSync } from "node:fs";

type Json = Record<string, unknown>;
let f: CredentialsFixture;
let token: string;
/** Run 11.3: a runtime credential's client secret, the bearer of machine.exchange. */
let clientSecret: string;
let credentialId: string;
let operationId: string;

beforeAll(async () => {
  f = await createCredentialsFixture();
  ({ token, credentialId, operationId } = await issueFor(f, "env1a", { ttlSeconds: 600 }));
  ({ clientSecret } = await issueRuntimeFor(f, "env1a"));
}, 600_000);

afterAll(async () => {
  await f.revoke("env1a", credentialId);
  await f.close();
});

const operationsOf = (doc: Json): { id: string; method: string; path: string }[] =>
  Object.entries(doc.paths as Record<string, Record<string, Json>>).flatMap(([path, item]) =>
    Object.entries(item).map(([method, op]) => ({
      id: op.operationId as string,
      method: method.toUpperCase(),
      path,
    })),
  );

async function servedDocument(): Promise<Json> {
  const answer = await f.send("GET", "/v1/openapi.json", { user: "ownerA" });
  expect(answer.status).toBe(200);
  return answer.body;
}

describe("GET /v1/openapi.json", () => {
  it("owner and admin get it; members and another organization's owner get the 404 of an unknown path", async () => {
    for (const user of ["ownerA", "adminA"] as const) {
      const answer = await f.send("GET", "/v1/openapi.json", { user });
      expect(answer.status, user).toBe(200);
      expect(String(answer.body.openapi), user).toMatch(/^3\.1\./);
    }
    const unknown = await f.send("GET", "/v1/no-such-route", { user: "ownerA" });
    expect(unknown.status).toBe(404);
    const shape = (body: Json) => {
      const error = body.error as Json;
      return { code: error.code, message: error.message };
    };
    for (const user of ["editorA", "readerA", "envEditorA", "ownerB"] as const) {
      const answer = await f.send("GET", "/v1/openapi.json", { user });
      expect(answer.status, user).toBe(404);
      expect(shape(answer.body), user).toEqual(shape(unknown.body));
    }
  });

  it("no session → 401; a session past the password step only → the pipeline's incomplete-session answer", async () => {
    const anonymous = await f.api.request("GET", "/v1/openapi.json");
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { error: { code: string } }).error.code).toBe(
      "unauthenticated",
    );
    const { email, password } = f.tenants.credentials("ownerA");
    const signedIn = await f.api.request("POST", "/v1/auth/sign-in/email", {
      body: { email, password },
    });
    const partial = await f.api.request("GET", "/v1/openapi.json", {
      headers: { cookie: sessionCookieOf(signedIn) },
    });
    expect(partial.status).toBe(401);
    expect(((await partial.json()) as { error: { code: string } }).error.code).toBe(
      "mfa_incomplete",
    );
  });

  it("is OpenAPI 3.1, valid, lists exactly the handled contract routes, has no server host, no token or canary example, no unused schema", async () => {
    const doc = await servedDocument();
    expect(String(doc.openapi)).toMatch(/^3\.1\./);
    const { valid, errors } = await validate(doc);
    expect(errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    const handled = handledRouteIds();
    const expected = ROUTES.filter((route) => handled.has(route.id)).map((route) => route.id);
    expect(
      operationsOf(doc)
        .map((op) => op.id)
        .sort(),
    ).toEqual(expected.sort());
    for (const server of (doc.servers ?? []) as { url: string }[]) {
      expect(server.url).not.toMatch(/^[a-z]+:\/\//i);
    }
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/\bhv[sbr]\.[A-Za-z0-9_-]{16,}/);
    expect(text).not.toMatch(/MYKEY_CANARY_[A-Za-z0-9]{32}/);
    const components = (doc.components ?? {}) as Json;
    const schemas = Object.keys(components.schemas ?? {});
    for (const name of schemas) expect(text, name).toContain(`"#/components/schemas/${name}"`);
  });
});

/** A valid body for every contract route that takes one (as routes-mounted.test.ts). */
const BODIES: Record<string, unknown> = {
  "projects.create": { name: "p" },
  "projects.rename": { name: "p" },
  "projects.archive": { confirmed: true },
  "projects.reactivate": { confirmed: true },
  "environments.create": { name: "dev" },
  "environments.rename": { name: "dev" },
  "environments.archive": { confirmed: true },
  "environments.reactivate": { confirmed: true },
  "secrets.reveal": {},
  "secrets.create": { name: "A", value: "" },
  "secrets.update": { value: "", expectedVersion: 1, expectedStateTag: "t" },
  "secrets.delete": { expectedVersion: 1, expectedStateTag: "t", confirmed: true },
  "secrets.undelete": { expectedVersion: 1, expectedStateTag: "t", confirmed: true },
  "secrets.restore": {
    sourceVersion: 1,
    expectedVersion: 1,
    expectedStateTag: "t",
    confirmed: true,
  },
  "export.create": { confirmed: true },
  "credentials.issue": { name: "c" },
  "credentials.revoke": { confirmed: true },
  "auth.reset.complete": { token: "A".repeat(43), newPassword: "a-long-new-password" },
  // Session 11: the human routes of the new credentials.
  "runtime_credentials.issue": { name: "c" },
  "automation_credentials.issue": {
    name: "c",
    rights: ["projects.create"],
    cidrs: ["192.0.2.0/24"],
  },
  "automation_credentials.revoke": { confirmed: true },
};

/**
 * Session 11 (Run 11.2): the class this build cannot authenticate. A route of
 * it is never listed and never reaches the handler's door; Run 11.5 gives it
 * its requests here. (Run 11.3: the exchange is sent with a client secret.)
 */
const unauthenticatedClass = (route: RouteDef): boolean => route.auth === "automation";

describe("what the document lists is what the build answers", () => {
  it("every listed operation reaches a handler of this build; every contract route without one ends in the terminal answer", async () => {
    const listed = new Set(operationsOf(await servedDocument()).map((op) => op.id));
    const env = f.env("env1a");
    const ids: Record<string, string> = {
      org: f.tenants.a.organizationId,
      project: env.projectId,
      env: env.environmentId,
      name: "A",
      envName: ENV_NAMES.env1a,
      credential: credentialId,
      operation: operationId,
    };
    const concrete = (route: RouteDef): string =>
      route.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => ids[name] ?? randomUUID());
    const ca = readFileSync(f.stack.api.certAuthorityPath);
    const reached: { routeId: string; handled: boolean }[] = [];
    // Every request stops at the handler's door: nothing is created, changed or read.
    f.setBeforeHandler((routeId, info) => {
      reached.push({ routeId, handled: info.handled });
      return Promise.reject(new Error("stopped at the handler (Run 5.9 probe)"));
    });
    try {
      await f.freshen();
      const seen: Record<string, boolean | "not reached"> = {};
      for (const route of ROUTES) {
        reached.length = 0;
        const body = BODIES[route.id];
        if (route.auth === "machine") {
          await machineFetch({ port: f.api.port, ca }, route.method, concrete(route), { token });
        } else if (route.auth === "machine_exchange") {
          await machineFetch({ port: f.api.port, ca }, route.method, concrete(route), {
            token: clientSecret,
          });
        } else if (route.auth === "human" || route.auth === "human_fresh_totp") {
          await f.send(route.method, concrete(route), {
            user: "ownerA",
            ...(route.request.body === "raw-dotenv"
              ? { text: "A=1\n" }
              : route.request.body === "pending"
                ? { body: {} }
                : body === undefined
                  ? {}
                  : { body }),
            key: route.idempotent ? randomUUID() : null,
          });
        } else {
          await f.api.request(route.method, concrete(route), body === undefined ? {} : { body });
        }
        seen[route.id] =
          reached.find((entry) => entry.routeId === route.id)?.handled ?? "not reached";
      }
      const expected = Object.fromEntries(
        ROUTES.map((route) => [
          route.id,
          unauthenticatedClass(route) ? "not reached" : listed.has(route.id),
        ]),
      );
      expect(seen).toEqual(expected);
      expect(ROUTES.filter((route) => unauthenticatedClass(route) && listed.has(route.id))).toEqual(
        [],
      );
    } finally {
      f.setBeforeHandler(null);
    }
  });
});
