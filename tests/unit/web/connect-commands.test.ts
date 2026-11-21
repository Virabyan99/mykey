// Run 9.0 Task E (P-160, P-161, the walkthrough's findings): "Connect an
// application" shows the runbooks' own commands, with the page's origin, the
// project's id and the environment's name filled in and nothing else changed.
// It never holds a token: the token step is the runbook's stdin block, with
// the terminal's echo switched off around it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONSUMER_DEPLOY,
  CONSUMER_LOCAL,
  localSteps,
  runbookSections,
  serverSteps,
} from "@mykey/web";
import { describe, expect, it } from "vitest";

const RUNBOOKS = resolve(import.meta.dirname, "../../../docs/runbooks");
const LOCAL = readFileSync(resolve(RUNBOOKS, "consumer-local.md"), "utf8");
const DEPLOY = readFileSync(resolve(RUNBOOKS, "consumer-deploy.md"), "utf8");

const FILL = {
  origin: "https://mykey.example:8443",
  project: "0b3a3c1e-9f01-4f43-9a51-6f1c2a1e1d7b",
  environment: "development",
};

/** The runbook's blocks of section `n`, as they are in the file. */
const blocksOf = (text: string, n: number): string[] =>
  runbookSections(text).find((section) => section.number === n)?.blocks ?? [];

const filled = (block: string, environment: string): string =>
  block
    .replace(
      `export SECRETS_API_URL="https://mykey.example"`,
      `export SECRETS_API_URL="${FILL.origin}"`,
    )
    .replace(`export SECRETS_PROJECT="<project id>"`, `export SECRETS_PROJECT="${FILL.project}"`)
    .replace(
      `export SECRETS_ENVIRONMENT="${environment}"`,
      `export SECRETS_ENVIRONMENT="${FILL.environment}"`,
    );

const TOKEN_SHAPES = [/hv[sbr]\.[A-Za-z0-9_-]{20,}/, /\bs\.[A-Za-z0-9]{20,}/];

describe("Connect an application's commands", () => {
  it("the bundled runbooks are the files themselves (else: node scripts/web-runbooks.ts)", () => {
    expect(CONSUMER_LOCAL).toBe(LOCAL.replaceAll("\r\n", "\n"));
    expect(CONSUMER_DEPLOY).toBe(DEPLOY.replaceAll("\r\n", "\n"));
  });

  it("the runbooks have the sections the panel reads", () => {
    expect(runbookSections(LOCAL).map((section) => section.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(blocksOf(LOCAL, 1)).toHaveLength(2);
    expect(blocksOf(LOCAL, 9)).toHaveLength(2);
    expect(runbookSections(DEPLOY).map((section) => section.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("the panel's commands are consumer-local.md's code blocks with the placeholders filled in: the origin, the project id, the environment name — byte for byte", () => {
    const commands = localSteps(LOCAL, FILL, { application: true }).flatMap(
      (step) => step.commands,
    );
    const curl = blocksOf(LOCAL, 1).find((block) => block.includes("curl"));
    const expected = [
      curl,
      ...blocksOf(LOCAL, 2),
      ...blocksOf(LOCAL, 3),
      ...blocksOf(LOCAL, 4),
      filled(blocksOf(LOCAL, 5)[0] ?? "", "development"),
      ...blocksOf(LOCAL, 6),
      `stty -echo\n${blocksOf(LOCAL, 8)[0] ?? ""}\nstty echo`,
      blocksOf(LOCAL, 9)[0],
    ];
    expect(commands).toEqual(expected);
    const variables = commands[4] ?? "";
    expect(variables).toContain(`SECRETS_API_URL="${FILL.origin}"`);
    expect(variables).toContain(`SECRETS_PROJECT="${FILL.project}"`);
    expect(variables).toContain(`SECRETS_ENVIRONMENT="${FILL.environment}"`);
    expect(variables).not.toContain("<project id>");
  });

  it("the server tab is consumer-deploy.md's blocks, filled in the same way", () => {
    const commands = serverSteps(DEPLOY, FILL).flatMap((step) => step.commands);
    expect(commands).toEqual([
      ...blocksOf(DEPLOY, 1),
      filled(blocksOf(DEPLOY, 2)[0] ?? "", "production"),
      ...blocksOf(DEPLOY, 3),
      ...blocksOf(DEPLOY, 4),
      `stty -echo\n${blocksOf(DEPLOY, 5)[0] ?? ""}\nstty echo`,
      ...blocksOf(DEPLOY, 6),
    ]);
  });

  it('the "no application yet" variant prints names only', () => {
    const commands = localSteps(LOCAL, FILL, { application: false }).flatMap(
      (step) => step.commands,
    );
    expect(commands).toContain(blocksOf(LOCAL, 9)[1]);
    expect(commands).not.toContain(blocksOf(LOCAL, 9)[0]);
    expect(commands.join("\n")).not.toContain("APP_START");
  });

  it("no command holds a token, and the token step is the stdin block with stty -echo", () => {
    for (const application of [true, false]) {
      const steps = localSteps(LOCAL, FILL, { application });
      for (const command of steps.flatMap((step) => step.commands)) {
        for (const shape of TOKEN_SHAPES) expect(command).not.toMatch(shape);
        expect(command).not.toMatch(/SECRETS_TOKEN=|--token\s+\S/);
      }
      const token = steps.find((step) => step.commands.some((c) => c.includes("machine-token")));
      expect(token?.commands).toEqual([`stty -echo\n${blocksOf(LOCAL, 8)[0] ?? ""}\nstty echo`]);
      expect(token?.warning).toMatch(/stays on the screen/);
    }
  });

  it("a value that would break the shell is refused, not filled in", () => {
    expect(() =>
      localSteps(LOCAL, { ...FILL, environment: 'dev"; rm -rf ~' }, { application: true }),
    ).toThrow();
    expect(() => localSteps(LOCAL, { ...FILL, project: "$(id)" }, { application: true })).toThrow();
  });
});
