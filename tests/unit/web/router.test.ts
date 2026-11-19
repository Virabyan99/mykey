// Run 7.1 Task A (P-134): the table of client paths. The API serves the shell
// on these paths and on no other; the browser's router reads the same table.
import { describe, expect, it } from "vitest";
import { WEB_ROUTES, matchWebRoute, webPath } from "@mykey/contracts";

const ORG = "6f1c2a1e-1d7b-4f43-9a51-0b3a3c1e9f01";
const PROJECT = "0b3a3c1e-9f01-4f43-9a51-6f1c2a1e1d7b";
const ENV = "1d7b6f1c-2a1e-4f43-9a51-9f010b3a3c1e";

/** One concrete path for every pattern. */
const EXAMPLES: Record<string, { path: string; params: Record<string, string> }> = {
  home: { path: "/", params: {} },
  "sign-in": { path: "/sign-in", params: {} },
  enroll: { path: "/enroll", params: {} },
  reset: { path: "/reset", params: {} },
  account: { path: "/account", params: {} },
  help: { path: "/help", params: {} },
  overview: { path: `/o/${ORG}`, params: { org: ORG } },
  activity: { path: `/o/${ORG}/activity`, params: { org: ORG } },
  audit: { path: `/o/${ORG}/audit`, params: { org: ORG } },
  project: { path: `/o/${ORG}/p/${PROJECT}`, params: { org: ORG, project: PROJECT } },
  secrets: {
    path: `/o/${ORG}/p/${PROJECT}/e/${ENV}`,
    params: { org: ORG, project: PROJECT, env: ENV },
  },
  secret: {
    path: `/o/${ORG}/p/${PROJECT}/e/${ENV}/s/DATABASE_URL`,
    params: { org: ORG, project: PROJECT, env: ENV, name: "DATABASE_URL" },
  },
  import: {
    path: `/o/${ORG}/p/${PROJECT}/e/${ENV}/import`,
    params: { org: ORG, project: PROJECT, env: ENV },
  },
  credentials: {
    path: `/o/${ORG}/p/${PROJECT}/e/${ENV}/credentials`,
    params: { org: ORG, project: PROJECT, env: ENV },
  },
  operations: {
    path: `/o/${ORG}/p/${PROJECT}/e/${ENV}/operations`,
    params: { org: ORG, project: PROJECT, env: ENV },
  },
};

describe("the table of client paths", () => {
  it("has exactly the fifteen screens of the plan", () => {
    expect(WEB_ROUTES.map((route) => route.id).sort()).toEqual(Object.keys(EXAMPLES).sort());
    expect(new Set(WEB_ROUTES.map((route) => route.pattern)).size).toBe(WEB_ROUTES.length);
  });

  it.each(Object.entries(EXAMPLES))("%s matches its own example", (id, example) => {
    expect(matchWebRoute(example.path)).toEqual({ id, params: example.params });
  });

  it.each(Object.entries(EXAMPLES))("webPath builds the example of %s", (id, example) => {
    expect(webPath(id, example.params)).toBe(example.path);
  });

  it.each([
    "/sign-in/",
    "/sign-in/extra",
    "/o",
    "/o/",
    "/o//p/x",
    `/o/${ORG}/`,
    `/o/${ORG}/p`,
    `/o/${ORG}/p/${PROJECT}/e/${ENV}/s/`,
    `/o/${ORG}/p/${PROJECT}/e/${ENV}/s/A/B`,
    `/o/${ORG}/p/${PROJECT}/e/${ENV}/unknown`,
    "/o/a%2Fb",
    "/o/..",
    "/metrics",
    "/debug",
    "/status",
    "/dashboard/",
    "/v1/anything",
    "/assets/app.js",
    "",
    "sign-in",
  ])("%s matches nothing", (path) => {
    expect(matchWebRoute(path)).toBeNull();
  });

  it("no pattern lies under /v1, /health or /assets", () => {
    for (const route of WEB_ROUTES) {
      expect(route.pattern, route.id).not.toMatch(/^\/(v1|health|assets)(\/|$)/);
    }
  });

  it("webPath refuses an unknown screen and a missing parameter", () => {
    expect(() => webPath("nope", {})).toThrow();
    expect(() => webPath("overview", {})).toThrow();
  });
});
