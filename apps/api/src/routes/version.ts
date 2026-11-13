// version.get (Run 3.1): the API's major version and the commit it was built from.
import type { Handler } from "../pipeline/context.ts";

export const versionHandler: Handler = (_ctx, deps) =>
  Promise.resolve({ status: 200, body: { apiMajor: 1, build: deps.config.build } });
