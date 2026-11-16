// The compatibility check of `contracts:check` (Run 5.9, P-101): what a client
// written against packages/contracts/openapi/baseline-v1.json relies on must
// still hold in the generated document while API_MAJOR is 1.
//   path_removed, method_removed      an operation of the baseline is gone
//   response_field_removed            a property a response had is gone
//   enum_value_removed                a value an enum had is gone (request or response)
//   request_field_required            a request property or parameter became required
//   type_narrowed                     a request schema accepts a type less; a
//                                     response schema can send a type it could not
// Not breaks: a new path or method, a new optional request field, a new
// response field, a request type that accepts more.
// Run: node scripts/contracts-compat.ts (exit 1 and one line per break).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { API_MAJOR, ROUTES, buildOpenApiDocument } from "@mykey/contracts";

export type Json = Record<string, unknown>;
export interface OpenApiDocument {
  openapi: string;
  info: Json;
  paths: Record<string, Record<string, Json>>;
  components?: Json;
  [key: string]: unknown;
}

export interface Break {
  kind:
    | "path_removed"
    | "method_removed"
    | "response_field_removed"
    | "enum_value_removed"
    | "request_field_required"
    | "type_narrowed";
  where: string;
}

export const BASELINE_FILE = resolve(
  import.meta.dirname,
  "../packages/contracts/openapi/baseline-v1.json",
);

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
type Side = "request" | "response";

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Follows local `$ref`s (`#/components/...`); a cycle stops at the second visit. */
function deref(doc: OpenApiDocument, schema: unknown, seen: Set<string>): Json | null {
  let current = schema;
  while (isObject(current) && typeof current.$ref === "string") {
    const ref = current.$ref;
    if (seen.has(ref) || !ref.startsWith("#/")) return null;
    seen.add(ref);
    current = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), doc);
  }
  return isObject(current) ? current : null;
}

const typesOf = (schema: Json): Set<string> | null => {
  if (typeof schema.type === "string") return new Set([schema.type]);
  if (Array.isArray(schema.type)) return new Set(schema.type as string[]);
  return null;
};

function compareSchemas(
  docs: { base: OpenApiDocument; current: OpenApiDocument },
  base: unknown,
  current: unknown,
  where: string,
  side: Side,
  found: Break[],
  seen: { base: Set<string>; current: Set<string> },
): void {
  const b = deref(docs.base, base, new Set(seen.base));
  const c = deref(docs.current, current, new Set(seen.current));
  if (b === null || c === null) return;
  const nextSeen = {
    base:
      isObject(base) && typeof base.$ref === "string"
        ? new Set([...seen.base, base.$ref])
        : seen.base,
    current:
      isObject(current) && typeof current.$ref === "string"
        ? new Set([...seen.current, current.$ref])
        : seen.current,
  };
  if (isObject(base) && typeof base.$ref === "string" && seen.base.has(base.$ref)) return;

  const bTypes = typesOf(b);
  const cTypes = typesOf(c);
  if (bTypes !== null && cTypes !== null) {
    const narrowed =
      side === "request"
        ? [...bTypes].some((type) => !cTypes.has(type))
        : [...cTypes].some((type) => !bTypes.has(type));
    if (narrowed) found.push({ kind: "type_narrowed", where });
  }

  if (Array.isArray(b.enum)) {
    const values = new Set(
      (Array.isArray(c.enum) ? c.enum : "const" in c ? [c.const] : []).map((v) =>
        JSON.stringify(v),
      ),
    );
    if (Array.isArray(c.enum) || "const" in c) {
      for (const value of b.enum) {
        if (!values.has(JSON.stringify(value))) {
          found.push({ kind: "enum_value_removed", where: `${where} ${JSON.stringify(value)}` });
        }
      }
    }
  }

  const bProps = isObject(b.properties) ? b.properties : {};
  const cProps = isObject(c.properties) ? c.properties : {};
  const bRequired = new Set(Array.isArray(b.required) ? (b.required as string[]) : []);
  const cRequired = new Set(Array.isArray(c.required) ? (c.required as string[]) : []);
  for (const [name, schema] of Object.entries(bProps)) {
    if (!(name in cProps)) {
      if (side === "response")
        found.push({ kind: "response_field_removed", where: `${where}.${name}` });
      continue;
    }
    compareSchemas(docs, schema, cProps[name], `${where}.${name}`, side, found, nextSeen);
  }
  if (side === "request") {
    for (const name of cRequired) {
      if (!bRequired.has(name))
        found.push({ kind: "request_field_required", where: `${where}.${name}` });
    }
  }
  if (b.items !== undefined && c.items !== undefined) {
    compareSchemas(docs, b.items, c.items, `${where}[]`, side, found, nextSeen);
  }
  if (isObject(b.additionalProperties) && isObject(c.additionalProperties)) {
    compareSchemas(
      docs,
      b.additionalProperties,
      c.additionalProperties,
      `${where}{}`,
      side,
      found,
      nextSeen,
    );
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const bList = b[key];
    const cList = c[key];
    if (Array.isArray(bList) && Array.isArray(cList) && bList.length === cList.length) {
      bList.forEach((entry, index) => {
        compareSchemas(
          docs,
          entry,
          cList[index],
          `${where}<${key}${String(index)}>`,
          side,
          found,
          nextSeen,
        );
      });
    }
  }
}

function contentSchemas(node: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!isObject(node) || !isObject(node.content)) return out;
  for (const [type, media] of Object.entries(node.content)) {
    if (isObject(media) && "schema" in media) out.set(type, media.schema);
  }
  return out;
}

export function breakingChanges(baseline: OpenApiDocument, current: OpenApiDocument): Break[] {
  const found: Break[] = [];
  const docs = { base: baseline, current };
  const empty = () => ({ base: new Set<string>(), current: new Set<string>() });
  for (const [path, baseItem] of Object.entries(baseline.paths)) {
    const currentItem = current.paths[path];
    if (currentItem === undefined) {
      found.push({ kind: "path_removed", where: path });
      continue;
    }
    for (const method of METHODS) {
      const baseOp = baseItem[method];
      if (!isObject(baseOp)) continue;
      const op = `${method.toUpperCase()} ${path}`;
      const currentOp = currentItem[method];
      if (!isObject(currentOp)) {
        found.push({ kind: "method_removed", where: op });
        continue;
      }
      // Parameters: one that was optional (or absent) and is required now.
      const params = (list: unknown): Map<string, Json> =>
        new Map(
          (Array.isArray(list) ? list : [])
            .filter(isObject)
            .map((p) => [`${String(p.in)}:${String(p.name)}`, p]),
        );
      const baseParams = params(baseOp.parameters);
      for (const [key, param] of params(currentOp.parameters)) {
        const before = baseParams.get(key);
        if (param.required === true && before?.required !== true) {
          found.push({ kind: "request_field_required", where: `${op} parameter ${key}` });
        }
        if (before !== undefined) {
          compareSchemas(
            docs,
            before.schema,
            param.schema,
            `${op} parameter ${key}`,
            "request",
            found,
            empty(),
          );
        }
      }
      // The request body.
      if (isObject(currentOp.requestBody) && currentOp.requestBody.required === true) {
        if (!isObject(baseOp.requestBody) || baseOp.requestBody.required !== true) {
          found.push({ kind: "request_field_required", where: `${op} body` });
        }
      }
      const baseBodies = contentSchemas(baseOp.requestBody);
      for (const [type, schema] of contentSchemas(currentOp.requestBody)) {
        if (baseBodies.has(type)) {
          compareSchemas(
            docs,
            baseBodies.get(type),
            schema,
            `${op} body`,
            "request",
            found,
            empty(),
          );
        }
      }
      // Responses: a status the baseline answered keeps every field it had.
      const baseResponses = isObject(baseOp.responses) ? baseOp.responses : {};
      const currentResponses = isObject(currentOp.responses) ? currentOp.responses : {};
      for (const [status, response] of Object.entries(baseResponses)) {
        const now = currentResponses[status];
        if (now === undefined) continue;
        const nowContent = contentSchemas(deref(current, now, new Set()));
        for (const [type, schema] of contentSchemas(deref(baseline, response, new Set()))) {
          if (nowContent.has(type)) {
            compareSchemas(
              docs,
              schema,
              nowContent.get(type),
              `${op} ${status}`,
              "response",
              found,
              empty(),
            );
          }
        }
      }
    }
  }
  return found;
}

if (import.meta.main) {
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as OpenApiDocument;
  const current = buildOpenApiDocument(ROUTES) as OpenApiDocument;
  const found = breakingChanges(baseline, current);
  const major: number = API_MAJOR;
  if (found.length > 0 && major === 1) {
    for (const entry of found)
      console.error(`contracts: breaking change ${entry.kind}: ${entry.where}`);
    console.error("contracts: the document breaks baseline-v1.json; a break needs API major 2");
    process.exit(1);
  }
  console.log(`contracts: compatible with baseline-v1.json (API major ${String(major)})`);
}
