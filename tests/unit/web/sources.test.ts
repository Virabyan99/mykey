// Run 7.1 Task B (Doc 10 §4.1 rule 2, Doc 06 §9 and §18.2): what the
// workspace's sources may not name. The page keeps nothing outside its own
// memory, writes nothing to the console, and builds no markup from text.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ROUTES } from "@mykey/contracts";
import { SECRET_BEARING } from "@mykey/web";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../apps/web/src");

function sources(directory: string = ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [path] : [];
  });
}

/** Names assembled here so this file would pass its own search. */
const BANNED: [string, RegExp][] = [
  ["local storage", new RegExp(["local", "Storage"].join(""))],
  ["session storage", new RegExp(["session", "Storage"].join(""))],
  ["IndexedDB", new RegExp(["indexed", "DB"].join(""), "i")],
  ["the cookie jar", new RegExp(["document", "cookie"].join("\\."))],
  ["Cache Storage", new RegExp(`\\b${["cach", "es"].join("")}\\b\\s*\\.`)],
  ["a service worker", new RegExp(["service", "Worker"].join(""))],
  ["a broadcast channel", new RegExp(["Broadcast", "Channel"].join(""))],
  ["the console", new RegExp(`\\b${["con", "sole"].join("")}\\s*\\.`)],
  ["markup from text", new RegExp(["dangerously", "SetInnerHTML"].join(""))],
  ["inner HTML", new RegExp(`\\.${["inner", "HTML"].join("")}\\b`)],
  ["eval", new RegExp(`\\b${["ev", "al"].join("")}\\s*\\(`)],
  ["a Function constructor", new RegExp(`new\\s+${["Func", "tion"].join("")}\\s*\\(`)],
  ["a query persister", new RegExp(["persist", "QueryClient"].join(""), "i")],
  ["an optimistic update", new RegExp(["on", "Mutate"].join(""))],
];

describe("the workspace's sources", () => {
  const files = sources();

  it("exist (the search has something to read)", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((file) => file.endsWith(".tsx"))).toBe(true);
  });

  it.each(BANNED)("never name %s", (_what, pattern) => {
    const hits = files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file).replaceAll("\\", "/"));
    expect(hits).toEqual([]);
  });

  it("the search finds a banned name when one is there (control)", () => {
    const sample = `window.${["con", "sole"].join("")}.log("a")`;
    const pattern = BANNED.find(([what]) => what === "the console")![1];
    expect(pattern.test(sample)).toBe(true);
    expect(pattern.test("a console is a desk")).toBe(false);
  });
});

// Run 7.4 (P-138, D-60): a route whose request or answer carries a secret is
// never called through the query cache, which would keep the answer for as
// long as the cache lives. They go through `callSecret` and the auth
// functions, called from an event handler, and their answers live in the
// forgetting holder.
describe("the secret-bearing routes", () => {
  const files = sources().filter((file) => !file.endsWith(".css"));
  const text = (file: string): string => readFileSync(file, "utf8");
  const name = (file: string): string => relative(ROOT, file).replaceAll("\\", "/");

  /** The text of every call of `fn(` in `source`, by matching brackets. */
  function calls(source: string, fn: string): string[] {
    const found: string[] = [];
    const pattern = new RegExp(`\\b${fn}\\s*(<[^>(]*>)?\\(`, "g");
    for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
      let depth = 0;
      let end = match.index + match[0].length - 1;
      for (; end < source.length; end += 1) {
        if (source[end] === "(") depth += 1;
        if (source[end] === ")") depth -= 1;
        if (depth === 0) break;
      }
      found.push(source.slice(match.index, end + 1));
    }
    return found;
  }

  /** Every way an answer gets into the query cache. */
  const CACHED = [
    "useQuery",
    "useInfiniteQuery",
    "useQueries",
    "useSuspenseQuery",
    "fetchQuery",
    "prefetchQuery",
    "ensureQueryData",
    "setQueryData",
  ];

  /** The exported functions of auth.ts that post to a secret-bearing path. */
  function secretAuthFunctions(): string[] {
    const auth = text(join(ROOT, "api/auth.ts"));
    const names: string[] = [];
    const pattern = /export const (\w+) =[\s\S]*?post\(\s*"([^"]+)"/g;
    for (let match = pattern.exec(auth); match !== null; match = pattern.exec(auth)) {
      if ((SECRET_BEARING as readonly string[]).includes(`/v1/auth${match[2] ?? ""}`)) {
        names.push(match[1] ?? "");
      }
    }
    return names;
  }

  it("are the list of P-138, and each is a route of the contract or a path of the auth module", () => {
    expect([...SECRET_BEARING].sort()).toEqual(
      [
        "secrets.reveal",
        "secrets.create",
        "secrets.update",
        "import.preview",
        "import.apply",
        "import.resume",
        "export.create",
        "credentials.issue",
        "auth.reset.complete",
        "/v1/auth/totp/enroll",
        "/v1/auth/totp/activate",
        "/v1/auth/recovery/regenerate",
        "/v1/auth/change-password",
        "/v1/auth/sign-in/email",
      ].sort(),
    );
    const ids = new Set(ROUTES.map((route) => route.id));
    for (const entry of SECRET_BEARING) {
      if (!entry.startsWith("/")) expect(ids.has(entry), entry).toBe(true);
    }
    expect(secretAuthFunctions().sort()).toEqual(
      ["activateTotp", "changePassword", "enrollTotp", "regenerateRecovery", "signIn"].sort(),
    );
  });

  it("no route of SECRET_BEARING is called through useQuery or useMutation", () => {
    const forbidden = [
      "callSecret",
      // The export's answer is a file, read by its own function (api/export.ts).
      "exportEnvironment",
      ...secretAuthFunctions(),
      ...SECRET_BEARING.filter((entry) => !entry.startsWith("/")).map((id) => `"${id}"`),
    ];
    const hits: string[] = [];
    for (const file of files) {
      const source = text(file);
      // The workspace has no mutation hook at all: a change is sent by use-action.ts.
      if (/\buseMutation\b/.test(source)) hits.push(`${name(file)}: useMutation`);
      for (const hook of CACHED) {
        for (const call of calls(source, hook)) {
          for (const word of forbidden) {
            if (call.includes(word)) hits.push(`${name(file)}: ${hook} with ${word}`);
          }
        }
      }
      // The plain client cannot name them either: `call` and `callSecret` share no route.
      for (const call of calls(source, "call")) {
        for (const id of SECRET_BEARING) {
          if (call.startsWith(`call("${id}"`)) hits.push(`${name(file)}: call("${id}")`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("only the screens that print the operation's own state read a 202 themselves", () => {
    // use-action.ts turns a 202 into "not finished yet" for every other screen:
    // a screen that takes it for itself must show the state it carries.
    const takers = files
      .filter((file) => /unfinished:\s*"caller"/.test(text(file)))
      .map((file) => name(file))
      // The hook itself names the option.
      .filter((file) => file !== "state/use-action.ts")
      .sort();
    expect(takers).toEqual(["screens/import.tsx", "screens/lifecycle.tsx"]);
  });

  it("the search finds such a call when one is there (control)", () => {
    const sample = `const q = useQuery({ queryKey: ["x"], queryFn: () => need(callSecret("secrets.reveal", { params: at(1) })) });`;
    const found = calls(sample, "useQuery");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("callSecret");
    expect(found[0]?.endsWith("})")).toBe(true);
    expect(
      calls(`call("secrets.reveal", {})`, "call")[0]?.startsWith(`call("secrets.reveal"`),
    ).toBe(true);
  });
});
