// openapi.get (Run 5.9, P-101): the OpenAPI document this build serves,
// computed once at start (app.ts). Authorization is the pipeline's (action
// reference.read against the process's organization); this answers it.
import type { Handler } from "../pipeline/context.ts";
import type { OpenApiDocument } from "../reference/document.ts";

export function openapiGetHandler(document: () => OpenApiDocument): Handler {
  return () => Promise.resolve({ status: 200, body: document() });
}
