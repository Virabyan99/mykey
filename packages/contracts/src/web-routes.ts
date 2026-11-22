// The paths of the owner workspace (Session 7, P-134). The API serves the
// workspace's shell on these paths and on no other, and the browser's router
// reads the same table: a path outside it keeps the API's 404. A secret's name
// is metadata and may be a path segment; a value, a token or a code never is.

export interface WebRoute {
  readonly id: string;
  /** Segments separated by `/`; a segment that starts with `:` is a parameter. */
  readonly pattern: string;
}

const O = "/o/:org";
const E = `${O}/p/:project/e/:env`;

export const WEB_ROUTES: readonly WebRoute[] = Object.freeze([
  { id: "home", pattern: "/" },
  { id: "sign-in", pattern: "/sign-in" },
  { id: "enroll", pattern: "/enroll" },
  { id: "reset", pattern: "/reset" },
  { id: "account", pattern: "/account" },
  { id: "help", pattern: "/help" },
  // Run 9.0 (P-161): an article of the help centre, deep-linked from every page.
  { id: "help-article", pattern: "/help/:article" },
  { id: "overview", pattern: O },
  { id: "activity", pattern: `${O}/activity` },
  { id: "audit", pattern: `${O}/audit` },
  { id: "project", pattern: `${O}/p/:project` },
  { id: "secrets", pattern: E },
  { id: "secret", pattern: `${E}/s/:name` },
  { id: "import", pattern: `${E}/import` },
  { id: "credentials", pattern: `${E}/credentials` },
  { id: "operations", pattern: `${E}/operations` },
  // Run 9.0 (P-161): Connect an application, with this environment's ids filled in.
  { id: "connect", pattern: `${E}/connect` },
]);

/** What a parameter may be: an id or a secret's name. Nothing that needs encoding. */
const PARAMETER = /^[A-Za-z0-9_-]{1,128}$/;

const segmentsOf = (pattern: string): string[] =>
  pattern === "/" ? [] : pattern.slice(1).split("/");

const COMPILED = WEB_ROUTES.map((route) => ({ id: route.id, segments: segmentsOf(route.pattern) }));

/** The screen a path names, or null: no trailing slash, no empty or encoded segment. */
export function matchWebRoute(path: string): { id: string; params: Record<string, string> } | null {
  if (!path.startsWith("/")) return null;
  const given = path === "/" ? [] : path.slice(1).split("/");
  for (const route of COMPILED) {
    if (route.segments.length !== given.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (const [index, segment] of route.segments.entries()) {
      const value = given[index] ?? "";
      if (segment.startsWith(":")) {
        if (!PARAMETER.test(value)) matched = false;
        else params[segment.slice(1)] = value;
      } else if (segment !== value) {
        matched = false;
      }
      if (!matched) break;
    }
    if (matched) return { id: route.id, params };
  }
  return null;
}

/** The path of a screen; throws for an unknown screen or a parameter that is missing or unfit. */
export function webPath(id: string, params: Readonly<Record<string, string>> = {}): string {
  const route = COMPILED.find((candidate) => candidate.id === id);
  if (route === undefined) throw new Error(`webPath: no screen ${id}`);
  if (route.segments.length === 0) return "/";
  return `/${route.segments
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const value = params[segment.slice(1)];
      if (value === undefined || !PARAMETER.test(value)) {
        throw new Error(`webPath: ${id} needs ${segment}`);
      }
      return value;
    })
    .join("/")}`;
}
