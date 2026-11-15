// The reference routes (Run 5.9, P-101). openapi.get: the OpenAPI document this
// build serves; reference.get: the page built on it (reference/page.ts). Both
// are computed once at start (app.ts). Authorization is the pipeline's (action
// reference.read against the process's organization); these answer it.
import { ApiError, type Handler } from "../pipeline/context.ts";
import type { OpenApiDocument } from "../reference/document.ts";
import type { ReferencePage } from "../reference/page.ts";

export function openapiGetHandler(document: () => OpenApiDocument): Handler {
  return () => Promise.resolve({ status: 200, body: document() });
}

/** No page (the asset is missing; logged once at start): 503. */
export function referenceGetHandler(page: () => ReferencePage | null): Handler {
  return () => {
    const built = page();
    if (built === null) return Promise.reject(new ApiError("dependency_unavailable"));
    return Promise.resolve({
      status: 200,
      body: null,
      raw: { bytes: built.html, contentType: "text/html; charset=utf-8" },
      headers: {
        "content-security-policy": built.csp,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  };
}
