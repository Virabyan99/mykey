// Session 11, Run 11.7 (spec §2.4): the documents of the two new credentials
// say what the contract says. automation.md's rights are AUTOMATION_RIGHTS,
// its examples are the ten automation routes, every number it and
// machine-credentials.md name is LIMITS's, and no document shows anything
// shaped like a client secret or an automation secret.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTOMATION_RIGHTS, LIMITS, ROUTES } from "@mykey/contracts";

const ROOT = resolve(import.meta.dirname, "../../..");
const read = (path: string): string =>
  readFileSync(join(ROOT, path), "utf8").replaceAll("\r\n", "\n");

const AUTOMATION = read("docs/runbooks/automation.md");
const CREDENTIALS = read("docs/runbooks/machine-credentials.md");
const LIMITS_DOC = read("docs/runbooks/known-limits.md");
const LOCAL = read("docs/runbooks/consumer-local.md");

const DAY = 86_400;
const days = (seconds: number): string => String(seconds / DAY);

/** The fenced `sh` blocks of a text, continuations joined. */
function shBlocks(text: string): string[] {
  return [...text.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) =>
    (m[1] ?? "").replace(/\\\n\s*/g, " ").trim(),
  );
}

/** A section from its heading to the next heading of the same level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`no heading ${heading}`);
  const rest = text.slice(start + heading.length + 2);
  const next = /^## /m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

describe("automation.md (Run 11.7)", () => {
  it("the rights table is AUTOMATION_RIGHTS, in the contract's order", () => {
    const rows = [...section(AUTOMATION, "## Issue it").matchAll(/^\| `([a-z_.]+)` +\|/gm)].map(
      (m) => m[1],
    );
    expect(rows).toEqual([...AUTOMATION_RIGHTS]);
  });

  it("its curl examples are the automation routes of the contract: each once, with its method", () => {
    const wanted = ROUTES.filter((route) => route.auth === "automation")
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(wanted).toHaveLength(10);
    const shown = shBlocks(section(AUTOMATION, "## The ten routes"))
      .filter((block) => block.includes("curl "))
      .map((block) => {
        const path = /"\$API(\/v1\/automation[^"]*)"/.exec(block)?.[1] ?? "";
        const method = /(?:^| )-d /.test(block) ? "POST" : "GET";
        return `${method} ${path.replaceAll(/<([a-z]+)>/g, (_, word: string) =>
          word === "environment" ? ":env" : `:${word}`,
        )}`;
      })
      .sort();
    expect(shown).toEqual(wanted);
  });

  it("every example reads the secret from the file, sends a key with a change, and names no host but the example's", () => {
    const blocks = shBlocks(AUTOMATION).filter((block) => block.includes("curl "));
    for (const block of blocks) {
      expect(block, block).toContain('-H @"$AUTH"');
      expect(block, block).not.toMatch(/Bearer/);
      if (/(?:^| )-d /.test(block)) expect(block, block).toContain("Idempotency-Key: ");
    }
    const hosts = new Set([...AUTOMATION.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]));
    expect([...hosts]).toEqual(["mykey.example"]);
    expect(AUTOMATION).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it("the step that stores the secret is the token step itself, with its file and its words changed", () => {
    const step = shBlocks(section(LOCAL, "## 8. Store the token"))[0] ?? "";
    let wanted = step;
    for (const [from, to] of [
      ["machine-token", "automation-auth"],
      ["Paste the token, then press Enter: ", "Paste the secret, then press Enter: "],
      [
        "that was not one token. If a token was shown on the screen, revoke it.",
        "that was not one secret. If a secret was shown on the screen, revoke its credential.",
      ],
      ['printf "%s\\n" "$t"', 'printf "Authorization: Bearer %s\\n" "$t"'],
      ["Token stored.", "Secret stored."],
    ] as const) {
      expect(wanted.split(from), from).toHaveLength(2);
      wanted = wanted.replace(from, to);
    }
    expect(shBlocks(section(AUTOMATION, "## Store it"))[0]).toBe(wanted);
  });

  it("every limit it names is LIMITS's", () => {
    const a = LIMITS.automationCredential;
    for (const text of [
      `1 hour to ${days(a.maxTtlSeconds)} days, ${days(a.defaultTtlSeconds)} days unless you say otherwise`,
      `1 to ${String(a.maxCidrs)}, in CIDR form`,
      `${String(LIMITS.rate.perAutomationCredentialPerMinute)} requests a minute`,
      `${days(LIMITS.machineToken.expiryWarningSeconds)} days before a credential expires`,
    ]) {
      expect(AUTOMATION, text).toContain(text);
    }
    expect(a.minTtlSeconds).toBe(3600);
  });

  it("it says what the credential cannot do, and the two steps by which it can reach values", () => {
    expect(AUTOMATION).toContain("It never reads a value.");
    expect(AUTOMATION).toContain("It can reach values in two steps, when you give it the right.");
    expect(AUTOMATION).toContain(
      "A credential issued without it starts a new chain and manages nothing.",
    );
  });
});

describe("machine-credentials.md, both kinds (Run 11.7)", () => {
  it("every limit of the runtime credential it names is LIMITS's", () => {
    const r = LIMITS.runtimeCredential;
    for (const text of [
      `at most ${days(r.maxTtlSeconds)} days`,
      `${String(r.exchangeTtlSeconds / 60)} minutes`,
      `at most ${String(r.maxCidrs)} networks`,
      `${String(LIMITS.rate.exchangePerCredentialPerMinute)} exchanges a minute`,
      `${days(LIMITS.machineToken.maxTtlSeconds)} days`,
    ]) {
      expect(CREDENTIALS, text).toContain(text);
    }
  });

  it("it has the table of when to choose which, and says what a revocation does in OpenBao", () => {
    const choose = section(CREDENTIALS, "## Two kinds");
    expect(choose).toMatch(/^\| A 30-day token +\|/m);
    expect(choose).toMatch(/^\| A runtime credential +\|/m);
    const revoke = section(CREDENTIALS, "## Runtime credentials");
    expect(revoke).toContain("OpenBao keeps accepting such a token until it expires");
    expect(revoke).toContain("`cli-v0.2.0`");
  });
});

describe("known-limits.md holds Session 11's nine lines (Run 11.7)", () => {
  it.each([
    "Whoever can write the database can bring a revoked or expired runtime credential back.",
    "A revoked runtime credential's last token still reads in OpenBao for up to 15 minutes.",
    "A lost answer of an exchange leaves a token nobody holds, for at most 15 minutes.",
    "Give each server its own runtime credential.",
    "An automation credential cannot change, delete or read a secret",
    "A bound network is compared with the address the edge reports.",
    "A restore with the two new kinds is proven in the integration suite, not yet on a host.",
    "`cli-v0.1.2` given a runtime credential exits 77.",
    "Production has none of this yet.",
  ])("%s", (line) => {
    expect(LIMITS_DOC).toContain(line);
  });
});

describe("no document shows a secret of the new shapes (Run 11.7)", () => {
  it("no runbook, guide, llms.txt or README holds an mkrc or mkac secret, or a bearer value", () => {
    const files = [
      ...readdirSync(join(ROOT, "docs/runbooks"))
        .filter((name) => name.endsWith(".md"))
        .map((name) => `docs/runbooks/${name}`),
      ...readdirSync(join(ROOT, "docs/agents"))
        .filter((name) => name.endsWith(".md"))
        .map((name) => `docs/agents/${name}`),
      "llms.txt",
      "README.md",
    ];
    const found: string[] = [];
    for (const path of files) {
      const text = read(path);
      // A placeholder is `mkrc.<id>.<secret>`: letters after the prefix's dot are a real id or secret.
      if (/\bmk(?:rc|ac)\.[A-Za-z0-9_-]{4,}/.test(text)) found.push(`${path}: a secret's shape`);
      if (/Bearer [A-Za-z0-9_-]{16,}/.test(text)) found.push(`${path}: a bearer value`);
    }
    expect(found).toEqual([]);
    // The control: the same search finds a secret assembled here.
    const made = ["mkac", "0".repeat(8), "x".repeat(43)].join(".");
    expect(/\bmk(?:rc|ac)\.[A-Za-z0-9_-]{4,}/.test(made)).toBe(true);
  });
});
