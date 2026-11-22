// The commands of "Connect an application" (Run 9.0 Task E, P-160): the code
// blocks of consumer-local.md and consumer-deploy.md, bundled as a generated
// module (connect/runbooks.ts, scripts/web-runbooks.ts), so the panel and the runbooks cannot drift apart
// (tests/consumers rehearses the runbooks; connect-commands.test.ts holds the
// panel to them). Three values are filled in: the page's origin, the
// project's id and the environment's name. A token is never filled in.

export interface RunbookSection {
  number: number;
  title: string;
  /** The fenced `sh` blocks of the section, as they are in the file. */
  blocks: string[];
}

/** The numbered sections ("## 7. Title") of a runbook and their shell blocks. */
export function runbookSections(text: string): RunbookSection[] {
  const sections: RunbookSection[] = [];
  let current: RunbookSection | null = null;
  let block: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw;
    if (block !== null) {
      if (/^\s*```\s*$/.test(line)) {
        current?.blocks.push(block.join("\n"));
        block = null;
      } else {
        block.push(line);
      }
      continue;
    }
    const heading = /^## (\d+)\. (.+)$/.exec(line);
    if (heading !== null) {
      current = { number: Number(heading[1]), title: (heading[2] ?? "").trim(), blocks: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith("## ")) {
      current = null;
      continue;
    }
    if (current !== null && /^```sh\s*$/.test(line)) block = [];
  }
  return sections;
}

export interface Fill {
  origin: string;
  project: string;
  environment: string;
}

export interface ConnectStep {
  /** The key of the step's text in copy/connect.ts. */
  id: string;
  commands: string[];
  /** A warning shown before the commands. */
  warning?: string;
  /** The commands of the other way, when a step has two (gh beside curl). */
  alternative?: string[];
}

/** What may be filled into a double-quoted shell word: no quote, no dollar, no backtick, no backslash. */
const SAFE = /^[A-Za-z0-9.:/_-]{1,200}$/;

function fillVariables(block: string, fill: Fill): string {
  const given: readonly [string, string][] = [
    ["origin", fill.origin],
    ["project", fill.project],
    ["environment", fill.environment],
  ];
  for (const [name, value] of given) {
    if (!SAFE.test(value)) throw new Error(`connect: the ${name} cannot be put into a command`);
  }
  return block
    .replace(/^export SECRETS_API_URL=".*"$/m, `export SECRETS_API_URL="${fill.origin}"`)
    .replace(/^export SECRETS_PROJECT=".*"$/m, `export SECRETS_PROJECT="${fill.project}"`)
    .replace(
      /^export SECRETS_ENVIRONMENT=".*"$/m,
      `export SECRETS_ENVIRONMENT="${fill.environment}"`,
    );
}

export const TOKEN_WARNING =
  "stty -echo keeps the pasted token off the screen; stty echo turns the echo back on. Run them as separate lines, not pasted together with the block. Without stty -echo the pasted token stays on the screen: do not copy that terminal into a chat, a ticket or a screenshot.";

/**
 * The token block with the terminal's echo off around it, as three blocks run one
 * at a time, as the runbook says to type them (review RR-5): pasted as one, a shell
 * without bracketed paste would read the last line into the token file. The middle
 * block is the runbook's own.
 */
const quietly = (block: string): string[] => ["stty -echo", block, "stty echo"];

const blocks = (sections: RunbookSection[], n: number): string[] => {
  const found = sections.find((section) => section.number === n);
  if (found === undefined) throw new Error(`connect: the runbook has no section ${String(n)}`);
  return found.blocks;
};

const one = (list: string[], what: string): string => {
  const first = list[0];
  if (first === undefined) throw new Error(`connect: no block for ${what}`);
  return first;
};

/** The local tab: consumer-local.md, steps 1 to 9. */
export function localSteps(
  text: string,
  fill: Fill,
  options: { application: boolean },
): ConnectStep[] {
  const sections = runbookSections(text);
  const release = blocks(sections, 1);
  const curl = release.find((block) => block.includes("curl"));
  const gh = release.find((block) => block.includes("gh release download"));
  if (curl === undefined) throw new Error("connect: the runbook has no curl block in step 1");
  let variables = fillVariables(one(blocks(sections, 5), "the variables"), fill);
  if (!options.application) {
    variables = variables
      .split("\n")
      .filter((line) => !/^export APP_(?:DIR|START)=/.test(line))
      .join("\n");
  }
  const start = blocks(sections, 9);
  return [
    {
      id: "local-get",
      commands: [curl, ...blocks(sections, 2)],
      ...(gh === undefined ? {} : { alternative: [gh] }),
    },
    { id: "local-install", commands: [...blocks(sections, 3), ...blocks(sections, 4)] },
    { id: "local-name", commands: [variables] },
    { id: "local-check", commands: blocks(sections, 6) },
    // Review RR-9: the terminal waits for the token before the token is issued.
    {
      id: "local-store",
      commands: quietly(one(blocks(sections, 8), "the token")),
      warning: TOKEN_WARNING,
    },
    { id: "local-issue", commands: [] },
    {
      id: options.application ? "local-start" : "local-names",
      commands: [options.application ? one(start, "the start") : (start[1] ?? one(start, "names"))],
    },
    { id: "local-done", commands: [] },
  ];
}

/** The server tab: consumer-deploy.md, steps 1 to 6. */
export function serverSteps(text: string, fill: Fill): ConnectStep[] {
  const sections = runbookSections(text);
  return [
    { id: "server-get", commands: blocks(sections, 1) },
    {
      id: "server-name",
      commands: [fillVariables(one(blocks(sections, 2), "the variables"), fill)],
    },
    { id: "server-node", commands: blocks(sections, 3) },
    { id: "server-build", commands: blocks(sections, 4) },
    {
      id: "server-store",
      commands: quietly(one(blocks(sections, 5), "the token")),
      warning: TOKEN_WARNING,
    },
    { id: "server-run", commands: blocks(sections, 6) },
    { id: "server-done", commands: [] },
  ];
}
