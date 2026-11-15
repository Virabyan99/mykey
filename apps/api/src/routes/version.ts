// version.get (Run 3.1): the API's major version and the commit it was built from.
import { API_MAJOR } from "@mykey/contracts";
import type { Handler } from "../pipeline/context.ts";

export const versionHandler: Handler = (_ctx, deps) =>
  Promise.resolve({ status: 200, body: { apiMajor: API_MAJOR, build: deps.config.build } });
