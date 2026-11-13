// Strict validation of the parsed body and the query (Doc 06 §9). A value of
// the wrong shape is `400 malformed_request` (Zod issues `invalid_type` and
// `unrecognized_keys`); a value of the right shape that breaks a rule of its
// schema is `422 validation_failed`.
import type { RouteDef } from "@mykey/contracts";
import { z } from "zod";
import { ApiError } from "./context.ts";

function classify(error: z.ZodError): ApiError {
  const shape = error.issues.some(
    (issue) => issue.code === "invalid_type" || issue.code === "unrecognized_keys",
  );
  return new ApiError(shape ? "malformed_request" : "validation_failed");
}

export function validateBody(route: RouteDef, body: unknown): unknown {
  const schema = route.request.body;
  // No schema yet (`pending`) or a dotenv text: the owning run validates it.
  if (schema === undefined || typeof schema === "string") return body;
  const result = schema.safeParse(body);
  if (!result.success) throw classify(result.error);
  return result.data;
}

const integerFields = new WeakMap<z.ZodObject, Set<string>>();

/** The query fields the schema declares as integers: their text is converted before validation. */
function integersOf(schema: z.ZodObject): Set<string> {
  let fields = integerFields.get(schema);
  if (fields === undefined) {
    const json = z.toJSONSchema(schema, { io: "input" }) as {
      properties?: Record<string, { type?: string }>;
    };
    fields = new Set(
      Object.entries(json.properties ?? {})
        .filter(([, property]) => property.type === "integer")
        .map(([name]) => name),
    );
    integerFields.set(schema, fields);
  }
  return fields;
}

export function validateQuery(route: RouteDef, search: URLSearchParams): unknown {
  const schema = route.request.query;
  const names = [...search.keys()];
  if (schema === undefined) {
    if (names.length > 0) throw new ApiError("malformed_request");
    return undefined;
  }
  if (new Set(names).size !== names.length) throw new ApiError("malformed_request");
  const integers = integersOf(schema);
  const raw: Record<string, unknown> = {};
  for (const [name, text] of search) {
    raw[name] = integers.has(name) && /^-?[0-9]{1,15}$/.test(text) ? Number(text) : text;
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw classify(result.error);
  return result.data;
}
