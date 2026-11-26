import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DENIED_ALIASES, LIMITS, ROUTES, buildOpenApiDocument } from "@mykey/contracts";
import { validate } from "@scalar/openapi-parser";
import { describe, expect, it } from "vitest";
import { OPENAPI_FILE, openApiFileIsCurrent } from "../../../scripts/contracts-openapi.ts";

const root = resolve(import.meta.dirname, "../../..");

interface Operation {
  operationId: string;
  parameters?: { name: string; in: string; required?: boolean; description?: string }[];
  requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
  responses: Record<string, { content?: Record<string, { schema: Record<string, unknown> }> }>;
  security?: Record<string, string[]>[];
}
interface Document {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
}

const document = buildOpenApiDocument(ROUTES) as unknown as Document;
const serialise = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const openApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, "{$1}");

function operation(id: string): Operation {
  for (const methods of Object.values(document.paths)) {
    for (const candidate of Object.values(methods)) {
      if (candidate.operationId === id) return candidate;
    }
  }
  throw new Error(`no operation ${id}`);
}

describe("generated OpenAPI document", () => {
  it("is valid OpenAPI 3.1", async () => {
    expect(document.openapi).toBe("3.1.0");
    const result = await validate(serialise(document));
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("is rejected by the validator when it is broken (the validator really checks)", async () => {
    const broken = structuredClone(document) as unknown as { paths: Record<string, unknown> };
    broken.paths["/health"] = { get: { responses: "not-an-object" } };
    const result = await validate(serialise(broken));
    expect(result.valid).toBe(false);
  });

  it("contains all 57 operations, with operationId = route id and {param} paths", () => {
    const found = new Map<string, string>();
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, candidate] of Object.entries(methods)) {
        found.set(candidate.operationId, `${method.toUpperCase()} ${path}`);
      }
    }
    expect(found.size).toBe(57);
    for (const route of ROUTES) {
      expect(found.get(route.id), route.id).toBe(`${route.method} ${openApiPath(route.path)}`);
    }
    expect(JSON.stringify(Object.keys(document.paths))).not.toContain(":");
  });

  it("declares every path parameter and the Idempotency-Key header where required", () => {
    for (const route of ROUTES) {
      const parameters = operation(route.id).parameters ?? [];
      const names = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]);
      for (const name of names) {
        expect(
          parameters.some((p) => p.in === "path" && p.name === name && p.required === true),
          `${route.id} ${name}`,
        ).toBe(true);
      }
      const header = parameters.some((p) => p.in === "header" && p.name === "Idempotency-Key");
      expect(header, route.id).toBe(route.idempotent);
    }
  });

  // M-6 (P-103, FR-1.83): a stored rejection is final and replays as recorded.
  it("the Idempotency-Key header says that a rejected request is retried with a new key", () => {
    for (const route of ROUTES.filter((candidate) => candidate.idempotent)) {
      const header = (operation(route.id).parameters ?? []).find(
        (p) => p.in === "header" && p.name === "Idempotency-Key",
      );
      expect(header?.description, route.id).toContain(
        "a rejected request is retried with a new key",
      );
    }
  });

  it("contains no denied alias", () => {
    for (const alias of DENIED_ALIASES) {
      expect(document.paths[openApiPath(alias.path)]).toBeUndefined();
    }
    expect(Object.keys(document.paths).filter((path) => path.endsWith("/status"))).toEqual([]);
  });

  it("describes raw dotenv bodies and the export attachment as bounded text", () => {
    const preview = operation("import.preview").requestBody?.content["text/plain"]?.schema;
    expect(preview).toMatchObject({ type: "string", maxLength: LIMITS.body.dotenvMaxBytes });
    expect(operation("export.create").responses["200"]?.content?.["text/plain"]).toBeDefined();
  });

  it("uses the error envelope for every error response and separates the two credentials", () => {
    const resolveOperation = operation("machine.resolve");
    const errorStatuses = Object.keys(resolveOperation.responses).filter((s) => Number(s) >= 400);
    expect(errorStatuses.length).toBeGreaterThan(3);
    for (const status of errorStatuses) {
      expect(resolveOperation.responses[status]?.content?.["application/json"]?.schema).toEqual({
        $ref: "#/components/schemas/ErrorEnvelope",
      });
    }
    expect(resolveOperation.security).toEqual([{ machineBearer: [] }]);
    expect(operation("secrets.list").security).toEqual([{ sessionCookie: [] }]);
    expect(operation("health.get").security).toEqual([]);
    // Session 11: one scheme per kind of credential, so a client cannot mix them up.
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual([
      "automationBearer",
      "machineBearer",
      "runtimeCredentialBearer",
      "sessionCookie",
    ]);
    expect(operation("machine.exchange").security).toEqual([{ runtimeCredentialBearer: [] }]);
    expect(operation("machine.metadata").security).toEqual([{ machineBearer: [] }]);
    expect(operation("automation.projects.create").security).toEqual([{ automationBearer: [] }]);
    expect(operation("automation_credentials.issue").security).toEqual([{ sessionCookie: [] }]);
    // P-39: the real name of Better Auth's session cookie.
    expect(JSON.stringify(document.components.securitySchemes)).toContain(
      '"name":"__Secure-better-auth.session_token"',
    );
  });

  it("marks pending response bodies and nothing else", () => {
    const pending = ROUTES.filter((route) => route.pending).map((route) => route.id);
    for (const route of ROUTES) {
      const marked = JSON.stringify(operation(route.id)).includes('"x-mykey-pending":true');
      expect(marked, route.id).toBe(pending.includes(route.id));
    }
  });

  it("builds byte-identically twice and matches the committed file", () => {
    const again = buildOpenApiDocument(ROUTES);
    expect(serialise(again)).toBe(serialise(document));
    const committed = readFileSync(
      resolve(root, "packages/contracts/openapi/openapi.json"),
      "utf8",
    );
    expect(committed).toBe(serialise(document));
  });
});

describe("contracts:check", () => {
  it("accepts the committed file and rejects a stale or missing one", () => {
    expect(openApiFileIsCurrent()).toBe(true);
    const directory = mkdtempSync(join(tmpdir(), "mykey-openapi-"));
    try {
      const stale = join(directory, "openapi.json");
      writeFileSync(stale, readFileSync(OPENAPI_FILE, "utf8").replace("3.1.0", "3.1.1"));
      expect(openApiFileIsCurrent(stale)).toBe(false);
      expect(openApiFileIsCurrent(join(directory, "missing.json"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
