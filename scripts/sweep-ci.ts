// Run 8.4 Step 3 (P-152): node scripts/sweep-ci.ts <file>…
//
// Counts canary-shaped strings (the secret scan's rule, any case) and OpenBao
// token shapes (hvs./hvb./hvr., the legacy s. + 24, and since Session 11 the
// client secret and the automation secret, mkrc. and mkac.) in the files it is
// given: CI logs and CLI reports downloaded at the one pass (Run 8.7). It
// prints one line of counts per file, never what it found, and exits 1 when
// any file holds one, 2 when it is given no file or a file it cannot read.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const CANARY = /MYKEY_CANARY_[A-Za-z0-9]{32}/g;
const TOKEN = /\bhv[sbr]\.[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9.])s\.[A-Za-z0-9]{24}(?![A-Za-z0-9])/g;
// Session 11 (Run 11.8): a runtime credential's client secret and an automation
// secret, `mkrc.` or `mkac.`, the credential's id and 43 characters. Counted
// with the tokens: either one opens what a token opens, or more. Twenty
// characters of the secret are enough to count: a body printed with a slice
// can end inside it (the token rule above allows the same).
const PRESENTED =
  /mk(?:rc|ac)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{20,}/g;
// A downloaded CI log keeps its colour codes, and one ends in a letter: with it
// in front, a word boundary is not where the secret starts.
// eslint-disable-next-line no-control-regex
const COLOUR = /\u001b\[[0-9;]*m/g;

export function countFindings(input: string): { canaries: number; tokens: number } {
  const text = input.replace(COLOUR, " ");
  return {
    canaries: [...text.matchAll(CANARY)].length,
    tokens: [...text.matchAll(TOKEN)].length + [...text.matchAll(PRESENTED)].length,
  };
}

function main(files: string[]): number {
  if (files.length === 0) {
    process.stderr.write("usage: node scripts/sweep-ci.ts <file>…\n");
    return 2;
  }
  let total = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      process.stderr.write(`sweep-ci: cannot read ${basename(file)}\n`);
      return 2;
    }
    const { canaries, tokens } = countFindings(text);
    total += canaries + tokens;
    process.stdout.write(
      `${basename(file)}: ${String(canaries)} canary-shaped, ${String(tokens)} token-shaped\n`,
    );
  }
  process.stdout.write(`sweep-ci: ${String(total)} found in ${String(files.length)} files\n`);
  return total === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
