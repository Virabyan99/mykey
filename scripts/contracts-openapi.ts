// Writes packages/contracts/openapi/openapi.json from the route list.
// With --check it writes nothing and exits 1 when the committed file differs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ROUTES, buildOpenApiDocument, serialiseOpenApiDocument } from "@mykey/contracts";

export const OPENAPI_FILE = resolve(
  import.meta.dirname,
  "../packages/contracts/openapi/openapi.json",
);

/** Returns true when the file on disk already equals a fresh build. */
export function openApiFileIsCurrent(file: string = OPENAPI_FILE): boolean {
  let committed: string;
  try {
    committed = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  return committed === serialiseOpenApiDocument(buildOpenApiDocument(ROUTES));
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    if (!openApiFileIsCurrent()) {
      console.error(
        "packages/contracts/openapi/openapi.json is out of date. Run: pnpm run contracts:openapi",
      );
      process.exit(1);
    }
    console.log("OpenAPI document is current.");
  } else {
    mkdirSync(dirname(OPENAPI_FILE), { recursive: true });
    writeFileSync(OPENAPI_FILE, serialiseOpenApiDocument(buildOpenApiDocument(ROUTES)));
    console.log(`Wrote ${OPENAPI_FILE} (${String(ROUTES.length)} routes).`);
  }
}
