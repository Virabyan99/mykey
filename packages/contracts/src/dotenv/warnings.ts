// Which entries of a canonical export a pinned loader reads back differently
// (Doc 04 FR-1.34). Static rules; tests/integration/dotenv-loaders runs the
// real loaders and fails if one changes a value these rules did not announce.
// The rules and the evidence for each are in docs/runbooks/dotenv-format-v1.md.
import { canonicalDotenvEntries } from "./serialize.ts";

export interface LoaderWarning {
  name: string;
  loader: "nextjs" | "python-dotenv";
  reason: "expansion" | "escape";
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

function hasSeparator(value: string): boolean {
  return value.includes(LINE_SEPARATOR) || value.includes(PARAGRAPH_SEPARATOR);
}

/**
 * @next/env (dotenv) takes `\"` for an escaped quote wherever it stands. When
 * a value ends with a backslash, its closing quote is therefore a candidate
 * for data, and the loader reads on to the opening quote of the next line. It
 * settles there when what follows that quote is optional whitespace and then
 * a `#` (taken as a comment) or a U+2028/U+2029 (taken as the end of the
 * line): the next entry is lost. Whitespace here is what JavaScript calls
 * `\s`, without TAB, LF and CR, which the canonical form writes as escapes.
 */
function isTakenWithPreviousLine(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (character === "#" || character === LINE_SEPARATOR || character === PARAGRAPH_SEPARATOR) {
      return true;
    }
    if (character === "\t" || character === "\n" || character === "\r") return false;
    if (!/\s/.test(character)) return false;
  }
  return false;
}

/**
 * Warnings in canonical order: by name, then `nextjs` before `python-dotenv`,
 * then `expansion` before `escape`. Never contains a value. Throws
 * DotenvEntryError for entries serializeDotenv would refuse.
 */
export function loaderWarnings(
  entries: readonly { name: string; value: string }[],
): LoaderWarning[] {
  const sorted = canonicalDotenvEntries(entries);

  // Entries @next/env loses to the line before them (see isTakenWithPreviousLine).
  const taken = new Set<string>();
  // After such a loss, a U+2028/U+2029 in the lost value starts a new line for
  // the loader in the middle of it; what follows can define or hide any name.
  let anyNameAtRisk = false;
  let previousEndsWithBackslash = false;
  for (const { name, value } of sorted) {
    if (previousEndsWithBackslash && isTakenWithPreviousLine(value)) {
      taken.add(name);
      if (hasSeparator(value)) anyNameAtRisk = true;
    }
    previousEndsWithBackslash = value.endsWith("\\");
  }

  const warnings: LoaderWarning[] = [];
  for (const { name, value } of sorted) {
    if (value.includes("$")) warnings.push({ name, loader: "nextjs", reason: "expansion" });
    if (/[\\"\t]/.test(value) || taken.has(name) || anyNameAtRisk) {
      warnings.push({ name, loader: "nextjs", reason: "escape" });
    }
    if (value.includes("${")) {
      warnings.push({ name, loader: "python-dotenv", reason: "expansion" });
    }
  }
  return warnings;
}
