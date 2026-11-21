// Run 8.4 Step 3 (P-152): node scripts/sweep-ci.ts <file>…
//
// Counts canary-shaped strings (the secret scan's rule, any case) and OpenBao
// token shapes (hvs./hvb./hvr. and the legacy s. + 24) in the files it is
// given: CI logs and CLI reports downloaded at the one pass (Run 8.7). It
// prints one line of counts per file, never what it found, and exits 1 when
// any file holds one, 2 when it is given no file or a file it cannot read.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const CANARY = /MYKEY_CANARY_[A-Za-z0-9]{32}/g;
const TOKEN = /\bhv[sbr]\.[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9.])s\.[A-Za-z0-9]{24}(?![A-Za-z0-9])/g;

export function countFindings(text: string): { canaries: number; tokens: number } {
  return {
    canaries: [...text.matchAll(CANARY)].length,
    tokens: [...text.matchAll(TOKEN)].length,
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
