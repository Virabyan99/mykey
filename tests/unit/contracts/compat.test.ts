// Run 5.9 Task A (P-101): the compatibility check of `contracts:check`. While
// API_MAJOR is 1, a change that can break a client written against the
// baseline fails: a removed path, method, response field or enum value, a
// request field that becomes required, a request type that accepts less.
// A new route, a new optional request field and a new response field are not breaks.
import { readFileSync } from "node:fs";
import { ROUTES, buildOpenApiDocument } from "@mykey/contracts";
import { describe, expect, it } from "vitest";
import {
  BASELINE_FILE,
  breakingChanges,
  type OpenApiDocument,
} from "../../../scripts/contracts-compat.ts";

function baseline(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/a": {
        get: {
          operationId: "a.get",
          parameters: [
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Thing" } },
              },
            },
          },
        },
        post: {
          operationId: "a.post",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    count: { type: ["integer", "string"] },
                    mode: { type: "string", enum: ["fast", "slow"] },
                  },
                  required: ["name"],
                },
              },
            },
          },
          responses: { "201": { description: "Created" } },
        },
      },
      "/b": { get: { operationId: "b.get", responses: { "204": { description: "No content" } } } },
    },
    components: {
      schemas: {
        Thing: {
          type: "object",
          properties: {
            id: { type: "string" },
            state: { type: "string", enum: ["active", "archived"] },
            items: {
              type: "array",
              items: { type: "object", properties: { n: { type: "integer" } } },
            },
          },
          required: ["id", "state"],
        },
      },
    },
  };
}

type Node = Record<string, unknown>;
/** The node at `keys` below `root` (the test edits a plain JSON document). */
const at = (root: unknown, ...keys: (string | number)[]): Node =>
  keys.reduce<unknown>(
    (node, key) => (node as Record<string | number, unknown>)[key],
    root,
  ) as Node;
const list = (root: unknown, ...keys: (string | number)[]): unknown[] =>
  at(root, ...keys) as unknown as unknown[];
const changed = (edit: (doc: Node) => void): OpenApiDocument => {
  const doc = baseline() as unknown as Node;
  edit(doc);
  return doc as unknown as OpenApiDocument;
};
const kinds = (doc: OpenApiDocument) => breakingChanges(baseline(), doc).map((b) => b.kind);
const postBody = (doc: Node): Node =>
  at(doc, "paths", "/a", "post", "requestBody", "content", "application/json", "schema");
const thing = (doc: Node, ...keys: string[]): Node =>
  at(doc, "components", "schemas", "Thing", ...keys);

describe("breakingChanges", () => {
  it("the same document → nothing", () => {
    expect(breakingChanges(baseline(), baseline())).toEqual([]);
  });

  it("a removed path → path_removed", () => {
    const found = breakingChanges(
      baseline(),
      changed((doc) => delete at(doc, "paths")["/b"]),
    );
    expect(found).toEqual([{ kind: "path_removed", where: "/b" }]);
  });

  it("a removed method → method_removed", () => {
    expect(kinds(changed((doc) => delete at(doc, "paths", "/a").post))).toEqual(["method_removed"]);
  });

  it("a removed response field, also inside a $ref and an array → response_field_removed", () => {
    const top = breakingChanges(
      baseline(),
      changed((doc) => delete thing(doc, "properties").id),
    );
    expect(top.map((b) => b.kind)).toContain("response_field_removed");
    expect(top[0]?.where).toContain("GET /a 200");
    const nested = changed(
      (doc) => delete thing(doc, "properties", "items", "items", "properties").n,
    );
    expect(kinds(nested)).toEqual(["response_field_removed"]);
  });

  it("a removed enum value, in a response or a request → enum_value_removed", () => {
    expect(kinds(changed((doc) => (thing(doc, "properties", "state").enum = ["active"])))).toEqual([
      "enum_value_removed",
    ]);
    expect(
      kinds(changed((doc) => (at(postBody(doc), "properties", "mode").enum = ["fast"]))),
    ).toEqual(["enum_value_removed"]);
  });

  it("an optional request field made required, a new required field, a parameter made required → request_field_required", () => {
    expect(kinds(changed((doc) => list(postBody(doc), "required").push("count")))).toEqual([
      "request_field_required",
    ]);
    expect(
      kinds(
        changed((doc) => {
          at(postBody(doc), "properties").extra = { type: "string" };
          list(postBody(doc), "required").push("extra");
        }),
      ),
    ).toEqual(["request_field_required"]);
    expect(
      kinds(changed((doc) => (at(doc, "paths", "/a", "get", "parameters", 0).required = true))),
    ).toEqual(["request_field_required"]);
  });

  it("a request type that accepts less → type_narrowed", () => {
    expect(
      kinds(changed((doc) => (at(postBody(doc), "properties", "count").type = "integer"))),
    ).toEqual(["type_narrowed"]);
  });

  it("not breaks: a new route, a new optional request field, a new response field", () => {
    const additions = changed((doc) => {
      at(doc, "paths")["/c"] = {
        get: { operationId: "c.get", responses: { "200": { description: "OK" } } },
      };
      at(doc, "paths", "/b").post = {
        operationId: "b.post",
        responses: { "204": { description: "No content" } },
      };
      at(postBody(doc), "properties").note = { type: "string" };
      thing(doc, "properties").createdAt = { type: "string" };
      at(postBody(doc), "properties", "count").type = ["integer", "string", "null"];
    });
    expect(breakingChanges(baseline(), additions)).toEqual([]);
  });

  it("the committed baseline-v1.json against the current document → nothing", () => {
    const committed = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as OpenApiDocument;
    const current = buildOpenApiDocument(ROUTES) as OpenApiDocument;
    expect(Object.keys(committed.paths).length).toBeGreaterThan(30);
    expect(breakingChanges(committed, current)).toEqual([]);
  });
});
