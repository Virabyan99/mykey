// Run 9.0 Task C (P-159, FR-1.102, Review focus 1 and 2): every text the
// workspace shows beyond a field's label lives in one catalogue. It is
// complete (every page, every state, every confirmation), it names only
// articles that exist, and none of it holds a secret's shape, an address of
// a deployment, or a claim the product does not make.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { AUTOMATION_RIGHTS, LIMITS, WEB_ROUTES } from "@mykey/contracts";
import {
  ACTIONS,
  CREDENTIAL_COPY,
  ALLOWED_DENIALS,
  ARTICLES,
  CATEGORIES,
  CLI_EXIT_CODES,
  CONNECT_STEPS,
  GLOSSARY,
  OPERATOR_RUNBOOKS,
  PAGES,
  STATES,
  STATE_LABELS,
  TOKEN_WARNING,
  lintText,
  stringsOf,
} from "@mykey/web";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../apps/web/src");

function sources(directory: string = ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
const read = (file: string): string => readFileSync(file, "utf8");
const name = (file: string): string => relative(ROOT, file).replaceAll("\\", "/");
const screens = sources().filter(
  (file) => name(file).startsWith("screens/") || name(file).startsWith("ui/"),
);
const articleIds = new Set(ARTICLES.map((article) => article.id));

/** The texts the action functions give, with sample numbers. */
const actionTexts = (): string[] => [
  ACTIONS.deleteSecret(3),
  ACTIONS.undeleteSecret(3),
  ACTIONS.restoreVersion(1, 3),
  ...stringsOf(ACTIONS),
];

/** Every text of the catalogue and the help centre. */
const everyText = (): string[] => [
  ...stringsOf(PAGES),
  ...stringsOf(STATES),
  ...stringsOf(GLOSSARY),
  ...actionTexts(),
  ...stringsOf(ARTICLES),
  ...stringsOf(CATEGORIES),
  ...stringsOf(CLI_EXIT_CODES),
  ...stringsOf(OPERATOR_RUNBOOKS),
  ...stringsOf(CONNECT_STEPS),
  ...stringsOf(CREDENTIAL_COPY),
  TOKEN_WARNING,
];

describe("the copy catalogue", () => {
  it('every WEB_ROUTES id has a page entry with a title, a summary of one sentence of at most 160 characters ending in a full stop, two to five "how this works" points and a help article that exists', () => {
    const problems: string[] = [];
    const pages = PAGES as Record<
      string,
      { title: string; summary: string; how: readonly string[]; help: string } | undefined
    >;
    for (const route of WEB_ROUTES) {
      const page = pages[route.id];
      if (page === undefined) {
        problems.push(`${route.id}: no entry`);
        continue;
      }
      if (page.title.trim() === "") problems.push(`${route.id}: no title`);
      if (page.summary.length > 160) problems.push(`${route.id}: summary over 160 characters`);
      if (!/^[^.!?]+\.$/.test(page.summary.replaceAll(".env", "dotenv"))) {
        problems.push(`${route.id}: summary is not one sentence ending in a full stop`);
      }
      if (page.how.length < 2 || page.how.length > 5) {
        problems.push(`${route.id}: ${String(page.how.length)} "how this works" points`);
      }
      if (!articleIds.has(page.help)) problems.push(`${route.id}: no article ${page.help}`);
    }
    expect(Object.keys(PAGES).sort()).toEqual(WEB_ROUTES.map((route) => route.id).sort());
    expect(problems).toEqual([]);
  });

  it("every state of every kind in STATE_LABELS has a meaning and a next step", () => {
    const problems: string[] = [];
    const states = STATES as Record<
      string,
      Record<string, { meaning: string; next: string } | undefined>
    >;
    for (const [kind, labels] of Object.entries(STATE_LABELS)) {
      for (const state of Object.keys(labels)) {
        const entry = states[kind]?.[state];
        if (entry === undefined || entry.meaning.trim() === "" || entry.next.trim() === "") {
          problems.push(`${kind}.${state}`);
        }
      }
      expect(Object.keys(states[kind] ?? {}).sort(), kind).toEqual(Object.keys(labels).sort());
    }
    expect(problems).toEqual([]);
  });

  it("every destructive, export and token action named in actions.ts is used by a screen, and every Confirm of a screen takes its text from actions.ts", () => {
    const text = screens.map(read).join("\n");
    const unused = Object.keys(ACTIONS).filter(
      (key) => !new RegExp(`\\bACTIONS\\.${key}\\b`).test(text),
    );
    expect(unused).toEqual([]);
    const own: string[] = [];
    for (const file of screens) {
      const source = read(file);
      for (const match of source.matchAll(/<ConfirmButton\b[\s\S]*?\/>/g)) {
        if (!match[0].includes("warning={ACTIONS.")) own.push(`${name(file)}: ConfirmButton`);
      }
      for (const match of source.matchAll(/<ConfirmDialog\b[\s\S]*?<\/ConfirmDialog>/g)) {
        if (!match[0].includes("ACTIONS.")) own.push(`${name(file)}: ConfirmDialog`);
      }
    }
    expect(own).toEqual([]);
    // The search finds the confirmations at all.
    expect(text.match(/<ConfirmDialog\b/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(text.match(/<ConfirmButton\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("every Term used names a glossary entry, and every glossary entry has an article", () => {
    const used = sources().flatMap((file) =>
      [...read(file).matchAll(/<Term\s+id="([^"]+)"/g)].map((m) => m[1] ?? ""),
    );
    const missing = used.filter((id) => !(id in GLOSSARY));
    expect(missing).toEqual([]);
    const orphans = Object.entries(GLOSSARY)
      .filter(([, entry]) => !articleIds.has(entry.article))
      .map(([id]) => id);
    expect(orphans).toEqual([]);
  });

  it("no text of the catalogue or the help holds a secret's shape, an address, a deployment's host name or a banned claim", () => {
    const texts = everyText();
    expect(texts.length).toBeGreaterThan(200);
    const problems = texts.flatMap((text) => lintText(text));
    expect(problems).toEqual([]);
  });

  it("the banned claims are those of FR-1.102, and a banned word stands only in a listed denial", () => {
    for (const denial of ALLOWED_DENIALS) expect(lintText(denial)).toEqual([]);
    expect(lintText("Your values are zero-knowledge encrypted.").map((p) => p.rule)).toEqual([
      'the claim "zero-knowledge"',
    ]);
    expect(lintText("Deleted values are permanently deleted.").length).toBeGreaterThan(0);
    expect(lintText("The service is always available.").length).toBeGreaterThan(0);
    expect(lintText("100% secure").length).toBeGreaterThan(0);
  });

  it("control: the lint finds a planted address and a planted canary", () => {
    const canary = [["MYKEY", "CANARY"].join("_"), "A".repeat(32)].join("_");
    expect(lintText(`a value such as ${canary}`).map((p) => p.rule)).toContain("a canary");
    expect(lintText("reach it at 10.20.30.40").map((p) => p.rule)).toContain("an IPv4 address");
    expect(lintText("reach it at fd00:1:2::3:4").map((p) => p.rule)).toContain("an IPv6 address");
    expect(lintText("open https://api.mykey-ops.com/v1").map((p) => p.rule)).toContain(
      "a host name (api.mykey-ops.com)",
    );
    expect(lintText("token hvs.CAESIJ2x3y4z5a6b7c8d9e0f1g2").map((p) => p.rule)).toContain(
      "an OpenBao token",
    );
    expect(lintText(`?token=${"x".repeat(43)}`).map((p) => p.rule)).toContain("a reset token");
    expect(lintText("see consumer-local.md and secrets.reveal on mykey.example")).toEqual([]);
  });

  // Session 11 (Run 11.6): the two kinds of machine credential and the automation credential.
  it("both kinds of machine credential and every right of an automation credential have a label and one sentence, and the numbers are the contract's", () => {
    expect(Object.keys(CREDENTIAL_COPY.kinds).sort()).toEqual(["runtime", "token"]);
    expect(Object.keys(CREDENTIAL_COPY.rights).sort()).toEqual([...AUTOMATION_RIGHTS].sort());
    for (const entry of [
      ...Object.values(CREDENTIAL_COPY.kinds),
      ...Object.values(CREDENTIAL_COPY.rights),
    ]) {
      expect(entry.label.trim()).not.toBe("");
      expect(entry.text).toMatch(/^[A-Z].*\.$/);
    }
    const days = (seconds: number): string => String(Math.floor(seconds / 86_400));
    expect(CREDENTIAL_COPY.kinds.token.label).toContain(
      `${days(LIMITS.machineToken.maxTtlSeconds)}-day`,
    );
    expect(CREDENTIAL_COPY.runtime.how).toContain(
      `${String(LIMITS.runtimeCredential.exchangeTtlSeconds / 60)} minutes`,
    );
    expect(PAGES.automation.how.join(" ")).toContain(
      `${days(LIMITS.automationCredential.maxTtlSeconds)} days`,
    );
    expect(PAGES.credentials.how.join(" ")).toContain(
      `${days(LIMITS.runtimeCredential.maxTtlSeconds)} days`,
    );
  });

  it("every article id named by pages.ts exists, and every article is reachable from /help", () => {
    const named = Object.values(PAGES).map((page) => page.help);
    expect(named.filter((id) => !articleIds.has(id))).toEqual([]);
    const categories = new Set(CATEGORIES.map((category) => category.id));
    expect(
      ARTICLES.filter((article) => !categories.has(article.category)).map((a) => a.id),
    ).toEqual([]);
    for (const article of ARTICLES) {
      for (const related of article.related)
        expect(articleIds.has(related), `${article.id} → ${related}`).toBe(true);
    }
    expect(articleIds.size).toBe(ARTICLES.length);
    expect(ARTICLES.length).toBeGreaterThanOrEqual(24);
  });
});
