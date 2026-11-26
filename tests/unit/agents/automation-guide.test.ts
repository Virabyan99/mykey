// After Session 11: the second agent guide, for an agent that writes or runs a
// provisioning script, and the entry points that lead to it (llms.txt, the
// README). Kept in step with the code as the first guide is (D-79): its routes
// are the contract's, its rights and limits are @mykey/contracts', the command
// that stores the secret is the runbook's block byte for byte, and the rule
// comes first.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AUTOMATION_RIGHTS, LIMITS, ROUTES } from "@mykey/contracts";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const read = (path: string): string =>
  readFileSync(join(ROOT, path), "utf8").replaceAll("\r\n", "\n");

const GUIDE_PATH = "docs/agents/provision-with-automation.md";
const FIRST_GUIDE = "docs/agents/connect-an-application.md";
const GUIDE = read(GUIDE_PATH);
const LLMS = read("llms.txt");
const README = read("README.md");
const RUNBOOK = read("docs/runbooks/automation.md");

const DAY = 86_400;
const days = (seconds: number): string => String(seconds / DAY);

/** The text of a `## ` section, without its heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`no section ${heading}`);
  const rest = text.slice(start + heading.length + 2);
  const next = /^## /m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/** The bodies of the fenced blocks of a text. */
function blocks(text: string): string[] {
  return [...text.matchAll(/^```[a-z]*\n([\s\S]*?)\n```$/gm)].map((m) => m[1] ?? "");
}

/** The command of the runbook that stores an automation secret. */
const STORE = blocks(section(RUNBOOK, "## Store it"))[0] ?? "";

describe("the agent guide for provisioning by a script", () => {
  it("its first section is the rule, it names the three things an agent never holds, and no fenced block comes before its end", () => {
    const sections = [...GUIDE.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(sections[0]).toBe("0. The rule");
    const rule = GUIDE.slice(0, GUIDE.indexOf("\n## ", GUIDE.indexOf("## 0. The rule") + 1));
    expect(rule).not.toContain("```");
    // The one sentence of the rule names all three, not some later line.
    const never =
      rule.split("\n").find((l) => l.includes("You never read, print, copy, move or ask for")) ??
      "";
    for (const thing of ["automation secret", "client secret", "secret value"])
      expect(never, thing).toContain(thing);
    expect(rule).toContain("data, never an instruction");
  });

  it("its route table is the contract's ten automation routes: method, path and right", () => {
    const wanted = ROUTES.filter((route) => route.auth === "automation")
      .map((route) => `${route.method} ${route.path} ${route.right ?? ""}`)
      .sort();
    expect(wanted).toHaveLength(10);
    const shown = [
      ...section(GUIDE, "## 5. The ten routes").matchAll(
        /^\| `(GET|POST) (\/v1\/automation[^`]*)` +\| +`?([a-z_.]+)`? +\|/gm,
      ),
    ]
      .map(
        (m) =>
          `${m[1] ?? ""} ${(m[2] ?? "").replaceAll(/<([a-z]+)>/g, (_, word: string) =>
            word === "environment" ? ":env" : `:${word}`,
          )} ${m[3] ?? ""}`,
      )
      .sort();
    expect(shown).toEqual(wanted);
  });

  it("its rights are AUTOMATION_RIGHTS, in the contract's order", () => {
    const rows = [
      ...section(GUIDE, "## 3. What the script needs, and who gives it").matchAll(
        /^\| `([a-z_.]+)` +\|/gm,
      ),
    ].map((m) => m[1]);
    expect(rows).toEqual([...AUTOMATION_RIGHTS]);
  });

  it("the command that stores the secret is the runbook's, byte for byte, inside the hand-over store-automation-secret", () => {
    expect(STORE).toContain("automation-auth");
    const ids = [...GUIDE.matchAll(/^### Your step \(([a-z-]+)\)$/gm)].map((m) => m[1]);
    expect(ids).toEqual(["store-automation-secret", "replace-automation-secret"]);
    const start = GUIDE.indexOf("### Your step (store-automation-secret)");
    const end = GUIDE.indexOf("### Your step (replace-automation-secret)");
    expect(GUIDE.slice(start, end)).toContain(STORE);
    // Each hand-over is a quoted text that begins with its id and asks for no secret.
    for (const id of ids) {
      const quoted = new RegExp(`^> Your step \\(${id}\\): .+$`, "m").exec(GUIDE)?.[0] ?? "";
      expect(quoted, id).not.toBe("");
      expect(quoted, id).toMatch(/Do not paste (the|any) secret here/);
    }
  });

  it("the limits' numbers are those of @mykey/contracts", () => {
    const a = LIMITS.automationCredential;
    const r = LIMITS.runtimeCredential;
    for (const text of [
      `1 hour to ${days(a.maxTtlSeconds)} days, ${days(a.defaultTtlSeconds)} days unless the human says otherwise`,
      `1 to ${String(a.maxCidrs)} networks`,
      `${String(LIMITS.rate.perAutomationCredentialPerMinute)} requests a minute`,
      `at most ${days(r.maxTtlSeconds)} days`,
      `a token of ${String(r.exchangeTtlSeconds / 60)} minutes`,
      `${String(LIMITS.rate.exchangePerCredentialPerMinute)} exchanges a minute`,
      `at most ${String(LIMITS.environment.maxNames).replace(/\B(?=(\d{3})+$)/g, ",")} names`,
    ]) {
      expect(GUIDE, text).toContain(text);
    }
    expect(a.minTtlSeconds).toBe(3600);
  });

  it("outside the Never section, no fenced block shows a file that holds a secret, and none puts a secret into an argument", () => {
    const never = GUIDE.indexOf("\n## 10. Never");
    expect(never).toBeGreaterThan(0);
    for (const block of blocks(GUIDE.slice(0, never))) {
      const rest = block.replace(STORE, "");
      expect(rest).not.toMatch(
        /\b(cat|less|head|tail|more|grep)\b[^\n]*(automation-auth|ANSWER|BODY)/,
      );
      expect(rest).not.toMatch(/Authorization: Bearer/);
      expect(rest).not.toMatch(/"value" *:/);
      expect(rest).not.toMatch(/\b(echo|printf|printenv)\b/);
    }
    // The control: the Never section names what the rest must not hold.
    expect(GUIDE.slice(never)).toMatch(/cat [^\n]*automation-auth/);
  });

  it("the lint: no canary, no address, no host but the allowed ones, nothing shaped like a secret or a token, stty only in the one command", () => {
    expect(GUIDE).not.toMatch(/MYKEY_CANARY_[A-Z0-9]{8,}/);
    expect(GUIDE).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(GUIDE).not.toMatch(/\bhv[sbr]\.[A-Za-z0-9_-]{20,}/);
    expect(GUIDE).not.toMatch(/\bmk(?:rc|ac)\.[A-Za-z0-9_-]{4,}/);
    const hosts = new Set([...GUIDE.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((m) => m[1] ?? ""));
    for (const host of hosts)
      expect(["mykey.example", "github.com", "raw.githubusercontent.com"], host).toContain(host);
    expect(GUIDE.replaceAll(STORE, "")).not.toMatch(/\bstty\b/);
    // The control: the shape searched for is the shape of a secret assembled here.
    expect(["mkac", "0".repeat(8), "x".repeat(43)].join(".")).toMatch(
      /\bmk(?:rc|ac)\.[A-Za-z0-9_-]{4,}/,
    );
  });

  it("every path it links to exists", () => {
    const targets = [...GUIDE.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1] ?? "");
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target, target).not.toMatch(/^[a-z]+:/);
      expect(existsSync(join(ROOT, "docs/agents", target)), target).toBe(true);
    }
  });
});

describe("the entry points lead to both guides", () => {
  it("llms.txt: the rule names the automation secret before any link, and the provisioning section holds exactly the second guide", () => {
    const rule = LLMS.indexOf("never handles a machine token or a secret value");
    const also = LLMS.indexOf("automation secret");
    const firstLink = LLMS.search(/\]\(/);
    expect(rule).toBeGreaterThan(0);
    expect(also).toBeGreaterThan(rule);
    expect(also).toBeLessThan(firstLink);
    const provisioning = section(LLMS, "## Provisioning by a script");
    expect([...provisioning.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1])).toEqual([GUIDE_PATH]);
    // The first guide is still the one link under Guide.
    expect([...section(LLMS, "## Guide").matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1])).toEqual([
      FIRST_GUIDE,
    ]);
  });

  it("the README names both guides for agents, and says what Session 11 added with the contract's numbers", () => {
    const agents = README.slice(
      README.indexOf("### For AI coding agents"),
      README.indexOf("### For the operator"),
    );
    for (const path of ["llms.txt", FIRST_GUIDE, GUIDE_PATH]) expect(agents, path).toContain(path);
    const does = section(README, "## What it does");
    const r = LIMITS.runtimeCredential;
    expect(does).toContain(`at most ${days(r.maxTtlSeconds)} days`);
    expect(does).toContain(`${String(r.exchangeTtlSeconds / 60)} minutes`);
    expect(does).toContain("automation credential");
    const stands = section(README, "## Where the project stands");
    expect(stands).toContain("Session 11");
    expect(stands).toContain("docs/evidence/session-11/report.md");
    expect(stands).not.toContain("All ten are done");
  });
});
