// The OpenAPI document a build serves (Run 5.9, P-101). The generated
// document of the contract stays complete: it is the contract. What a build
// serves is what the build does: only operations whose operationId has a
// handler, and only the component schemas those operations still reach.
export type OpenApiDocument = Record<string, unknown> & {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components?: Record<string, unknown>;
};

const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const REF = "#/components/schemas/";

/** Every `#/components/schemas/<name>` that `node` names, directly. */
function refsIn(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const entry of node) refsIn(entry, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string" && value.startsWith(REF)) {
      out.add(value.slice(REF.length));
    } else {
      refsIn(value, out);
    }
  }
}

export function servedDocument(
  full: OpenApiDocument,
  handlerIds: ReadonlySet<string>,
): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const [path, item] of Object.entries(full.paths)) {
    const kept = Object.fromEntries(
      Object.entries(item).filter(
        ([method, operation]) =>
          !METHODS.has(method) || handlerIds.has(String(operation.operationId)),
      ),
    );
    if (Object.keys(kept).some((method) => METHODS.has(method))) paths[path] = kept;
  }
  const schemas = (full.components?.schemas ?? {}) as Record<string, unknown>;
  // The schemas the kept operations reach, following schemas that name schemas.
  const used = new Set<string>();
  refsIn(paths, used);
  for (let grew = true; grew;) {
    grew = false;
    for (const name of [...used]) {
      const before = used.size;
      refsIn(schemas[name], used);
      if (used.size > before) grew = true;
    }
  }
  const components = {
    ...full.components,
    schemas: Object.fromEntries(Object.entries(schemas).filter(([name]) => used.has(name))),
  };
  // No servers entry: the page and its clients use the origin they were served from.
  const rest = Object.fromEntries(Object.entries(full).filter(([key]) => key !== "servers"));
  return { ...rest, paths, components };
}
