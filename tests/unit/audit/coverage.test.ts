// Run 6.1 Task A (P-105, FR-1.56): audit coverage is a table, checked both
// ways. Every route, auth path, operator command and timer has an entry —
// the actions it writes, or the reason it writes none — and every action of
// the closed list is named by at least one entry.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_COVERAGE, type Coverage } from "@mykey/audit";
import { servedAuthRoutes } from "@mykey/auth";
import { ROUTES } from "@mykey/contracts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Every `.ts` file under `dir`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

/** `<app>/<file>` of every source file of the app that starts a recurring or delayed timer. */
function timerFiles(app: "api" | "provisioner"): string[] {
  return sources(join(ROOT, "apps", app, "src"))
    .filter((file) => /setInterval\(|timer = setTimeout\(/.test(readFileSync(file, "utf8")))
    .map((file) => `${app}/${basename(file, ".ts")}`);
}

const entries = (): [string, Coverage][] => [
  ...Object.entries(AUDIT_COVERAGE.routes),
  ...Object.entries(AUDIT_COVERAGE.auth),
  ...Object.entries(AUDIT_COVERAGE.ops),
  ...Object.entries(AUDIT_COVERAGE.timers),
];

describe("the audit coverage table (P-105)", () => {
  it("every route id of ROUTES has an entry", () => {
    const missing = ROUTES.map((route) => route.id).filter(
      (id) => !Object.hasOwn(AUDIT_COVERAGE.routes, id),
    );
    expect(missing).toEqual([]);
  });

  it("every path of NATIVE_ALLOWED, PRODUCT_OWNED, PRODUCT_ROUTES and FACTOR_PATHS has an entry", () => {
    const missing = servedAuthRoutes()
      .map((route) => `${route.method} ${route.path}`)
      .filter((key) => !Object.hasOwn(AUDIT_COVERAGE.auth, key));
    expect(servedAuthRoutes().length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  it("every file of apps/ops/src/commands has an entry", () => {
    const commands = readdirSync(join(ROOT, "apps", "ops", "src", "commands"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => basename(name, ".ts"));
    expect(commands.length).toBeGreaterThan(5);
    expect(commands.filter((name) => !Object.hasOwn(AUDIT_COVERAGE.ops, name))).toEqual([]);
  });

  it("every timer of the API and the provisioner has an entry", () => {
    const timers = [...timerFiles("api"), ...timerFiles("provisioner")];
    expect(timers).toContain("api/operation-sweep");
    expect(timers.filter((key) => !Object.hasOwn(AUDIT_COVERAGE.timers, key))).toEqual([]);
  });

  it("every action of AUDIT_ACTIONS is named by an entry", () => {
    const named = new Set(
      entries().flatMap(([, entry]) => ("actions" in entry ? entry.actions : [])),
    );
    expect(AUDIT_ACTIONS.filter((action) => !named.has(action))).toEqual([]);
  });

  it("an entry names only actions of the closed list, and never none", () => {
    const known = new Set<string>(AUDIT_ACTIONS);
    for (const [key, entry] of entries()) {
      if (!("actions" in entry)) continue;
      expect(entry.actions.length, key).toBeGreaterThan(0);
      expect(
        entry.actions.filter((action) => !known.has(action)),
        key,
      ).toEqual([]);
    }
  });

  it("an entry with none has a reason of at least 20 characters", () => {
    const short = entries()
      .filter(([, entry]) => "none" in entry && entry.none.trim().length < 20)
      .map(([key]) => key);
    expect(short).toEqual([]);
  });
});
