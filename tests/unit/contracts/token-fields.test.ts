// Run 5.1 Task C (FR-1.53, P-88): exactly one response of the contract holds
// an OpenBao token — the 201 of credentials.issue. Every response schema of
// every route is walked; a string field named like a credential anywhere else
// fails.
import { ROUTES } from "@mykey/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const CREDENTIAL_FIELDS = new Set([
  "token",
  "secretId",
  "accessor",
  "client_token",
  // Session 11 (P-185): the two presented secrets, and what must never be served.
  "clientSecret",
  "secret",
  "verifier",
]);

/** Every property name of a JSON schema whose value can be a string, with its path. */
function credentialFields(schema: unknown, path: string, found: string[]): void {
  if (schema === null || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;
  const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
  for (const [name, inner] of Object.entries(properties ?? {})) {
    if (CREDENTIAL_FIELDS.has(name)) found.push(`${path}.${name}`);
    credentialFields(inner, `${path}.${name}`, found);
  }
  for (const key of ["items", "additionalProperties"]) credentialFields(node[key], path, found);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const list = node[key];
    if (Array.isArray(list)) for (const inner of list) credentialFields(inner, path, found);
  }
}

describe("credential fields in responses", () => {
  it("only the issue routes and the exchange hold a credential, each once (Session 11: five)", () => {
    const found: string[] = [];
    for (const route of ROUTES) {
      for (const [status, schema] of Object.entries(route.responses)) {
        if (typeof schema === "string") continue;
        const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" });
        credentialFields(json, `${route.id} ${status}`, found);
      }
    }
    expect(found).toEqual([
      "credentials.issue 201.token",
      "machine.exchange 200.token",
      "runtime_credentials.issue 201.clientSecret",
      "automation_credentials.issue 201.secret",
      "automation.runtime_credentials.issue 201.clientSecret",
    ]);
  });

  it("the walker finds a nested field (control)", () => {
    const found: string[] = [];
    const json = z.toJSONSchema(
      z.strictObject({ a: z.array(z.strictObject({ accessor: z.string() })) }),
      { target: "draft-2020-12", io: "output" },
    );
    credentialFields(json, "x", found);
    expect(found).toEqual(["x.a.accessor"]);
  });
});
