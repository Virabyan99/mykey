// MyKey dotenv format v1: the strict parser (Doc 04 FR-1.33).
// The grammar is written down in docs/runbooks/dotenv-format-v1.md.
// Nothing this module returns for a rejected file contains input text: an issue
// is a line number, a rule name and, only when the name passed checkSecretName,
// that name.
import { LIMITS } from "../limits.ts";
import { checkSecretName, checkSecretValue } from "../names.ts";

export const DOTENV_RULES = [
  "file_too_large",
  "bom",
  "invalid_utf8",
  "nul",
  "lone_cr",
  "invalid_line",
  "missing_equals",
  "export_prefix",
  "invalid_name",
  "reserved_name",
  "duplicate_name",
  "single_quote",
  "unquoted_whitespace",
  "unquoted_forbidden_character",
  "inline_comment",
  "unterminated_quote",
  "raw_newline_in_quotes",
  "unknown_escape",
  "text_after_quote",
  "value_too_large",
  "too_many_entries",
] as const;

export type DotenvRule = (typeof DOTENV_RULES)[number];

/** `line` is 1-based. `file_too_large` is about the whole file and has line 0. */
export interface DotenvIssue {
  line: number;
  rule: DotenvRule;
  name?: string;
}

export interface DotenvEntry {
  name: string;
  value: string;
  line: number;
}

export type DotenvParseResult =
  { ok: true; entries: DotenvEntry[] } | { ok: false; issues: DotenvIssue[] };

/** Parsing stops after this many issues. */
export const DOTENV_MAX_ISSUES = 100;

const LF = 0x0a;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["\\", "\\"],
  ['"', '"'],
]);

// Fatal: an invalid sequence throws instead of becoming U+FFFD. ignoreBOM keeps
// U+FEFF in the text, so a byte order mark is seen and a later U+FEFF is data.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Whitespace as any loader might trim it: what JavaScript calls `\s` (which
 * includes U+FEFF) plus the characters only Python's `str.strip` removes.
 */
function isWhitespace(character: string): boolean {
  if (character === "") return false;
  const code = character.charCodeAt(0);
  return /\s/.test(character) || (code >= 0x1c && code <= 0x1f) || code === 0x85;
}

function isWhitespaceOnly(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (!isWhitespace(text.charAt(index))) return false;
  }
  return true;
}

/** The lines of a file. A line that is not valid UTF-8 reads as `null`. */
interface Lines {
  readonly count: number;
  at(index: number): string | null;
}

/**
 * Splits at LF. A valid file is decoded once. A file with an invalid sequence
 * is decoded line by line and only on demand: a failed decode is expensive and
 * parsing stops after DOTENV_MAX_ISSUES, so the rest is never looked at.
 */
function splitLines(bytes: Uint8Array): Lines {
  try {
    const lines = decoder.decode(bytes).split("\n");
    return { count: lines.length, at: (index) => lines[index] ?? null };
  } catch {
    // 0x0A never occurs inside a multi-byte sequence, so cutting there is safe.
    const starts = [0];
    for (let lf = bytes.indexOf(LF); lf !== -1; lf = bytes.indexOf(LF, lf + 1)) starts.push(lf + 1);
    return {
      count: starts.length,
      at: (index) => {
        const start = starts[index];
        if (start === undefined) return null;
        const next = starts[index + 1];
        const end = next === undefined ? bytes.length : next - 1;
        if (end === start) return "";
        try {
          return decoder.decode(bytes.subarray(start, end));
        } catch {
          return null;
        }
      },
    };
  }
}

type Line = { text: string } | { rule: "bom" | "invalid_utf8" | "nul" | "lone_cr" };

/** Applies the byte-level rules to one line and removes the CR of a CRLF ending. */
function readLine(lines: Lines, index: number, hasBom: boolean): Line {
  if (index === 0 && hasBom) return { rule: "bom" };
  const raw = lines.at(index);
  if (raw === null) return { rule: "invalid_utf8" };
  if (raw.includes("\0")) return { rule: "nul" };
  // Only a line that was ended by LF can end in CRLF; the last one was not.
  const endedByLf = index < lines.count - 1;
  const text = endedByLf && raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  if (text.includes("\r")) return { rule: "lone_cr" };
  return { text };
}

type ValueRule =
  | "single_quote"
  | "unquoted_whitespace"
  | "unquoted_forbidden_character"
  | "inline_comment"
  | "unterminated_quote"
  | "unknown_escape"
  | "text_after_quote";

type Value = { value: string } | { rule: ValueRule };

function parseQuoted(rest: string): Value {
  const parts: string[] = [];
  let segmentStart = 1;
  let index = 1;
  while (index < rest.length) {
    const code = rest.charCodeAt(index);
    if (code === QUOTE) {
      if (index !== rest.length - 1) return { rule: "text_after_quote" };
      parts.push(rest.slice(segmentStart, index));
      return { value: parts.join("") };
    }
    if (code === BACKSLASH) {
      if (index + 1 >= rest.length) break;
      const unescaped = ESCAPES.get(rest.charAt(index + 1));
      if (unescaped === undefined) return { rule: "unknown_escape" };
      parts.push(rest.slice(segmentStart, index), unescaped);
      index += 2;
      segmentStart = index;
      continue;
    }
    index += 1;
  }
  return { rule: "unterminated_quote" };
}

function parseUnquoted(rest: string): Value {
  if (isWhitespace(rest.charAt(0))) return { rule: "unquoted_whitespace" };
  for (let index = 0; index < rest.length; index += 1) {
    const character = rest.charAt(index);
    if (character === "#") return { rule: "inline_comment" };
    if (character === "\\" || character === "\t" || character === '"' || character === "'") {
      return { rule: "unquoted_forbidden_character" };
    }
  }
  if (isWhitespace(rest.charAt(rest.length - 1))) return { rule: "unquoted_whitespace" };
  return { value: rest };
}

function parseValue(rest: string): Value {
  if (rest === "") return { value: "" };
  if (rest.startsWith('"')) return parseQuoted(rest);
  if (rest.startsWith("'")) return { rule: "single_quote" };
  return parseUnquoted(rest);
}

function hasUnescapedQuote(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === BACKSLASH) index += 1;
    else if (code === QUOTE) return true;
  }
  return false;
}

/**
 * After an unterminated quote at `from`: the index of the first later line
 * that holds an unescaped double quote, or -1. The search does not cross a
 * line that breaks a byte-level rule, so that line is still reported itself.
 */
function findClosingLine(lines: Lines, from: number, hasBom: boolean): number {
  for (let index = from + 1; index < lines.count; index += 1) {
    const line = readLine(lines, index, hasBom);
    if ("rule" in line) return -1;
    if (hasUnescapedQuote(line.text)) return index;
  }
  return -1;
}

function startsWithExport(rawName: string): boolean {
  return rawName.startsWith("export") && isWhitespace(rawName.charAt("export".length));
}

export function parseDotenv(bytes: Uint8Array): DotenvParseResult {
  // Checked before decoding: an oversized body is never turned into text.
  if (bytes.byteLength > LIMITS.body.dotenvMaxBytes) {
    return { ok: false, issues: [{ line: 0, rule: "file_too_large" }] };
  }

  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const lines = splitLines(bytes);
  const entries: DotenvEntry[] = [];
  const issues: DotenvIssue[] = [];
  const seen = new Set<string>();
  let tooManyReported = false;

  for (let index = 0; index < lines.count && issues.length < DOTENV_MAX_ISSUES; index += 1) {
    const lineNumber = index + 1;
    const line = readLine(lines, index, hasBom);
    if ("rule" in line) {
      issues.push({ line: lineNumber, rule: line.rule });
      continue;
    }
    const text = line.text;
    if (text === "" || text.startsWith("#")) continue;

    const equals = text.indexOf("=");
    if (equals === -1) {
      const blankOrIndented = isWhitespaceOnly(text) || isWhitespace(text.charAt(0));
      issues.push({ line: lineNumber, rule: blankOrIndented ? "invalid_line" : "missing_equals" });
      continue;
    }

    const rawName = text.slice(0, equals);
    if (isWhitespace(rawName.charAt(0)) || isWhitespace(rawName.charAt(rawName.length - 1))) {
      issues.push({ line: lineNumber, rule: "invalid_line" });
      continue;
    }
    if (startsWithExport(rawName)) {
      issues.push({ line: lineNumber, rule: "export_prefix" });
      continue;
    }
    const nameCheck = checkSecretName(rawName);
    if (!nameCheck.ok) {
      const rule = nameCheck.rule === "reserved_prefix" ? "reserved_name" : "invalid_name";
      issues.push({ line: lineNumber, rule });
      continue;
    }
    const name = nameCheck.value;
    if (seen.has(name)) {
      issues.push({ line: lineNumber, rule: "duplicate_name", name });
      continue;
    }
    seen.add(name);

    const parsed = parseValue(text.slice(equals + 1));
    if ("rule" in parsed) {
      if (parsed.rule === "unterminated_quote") {
        const closingLine = findClosingLine(lines, index, hasBom);
        if (closingLine !== -1) {
          // A raw line break inside quotes: one issue, and the continuation
          // lines are not parsed as entries of their own.
          issues.push({ line: lineNumber, rule: "raw_newline_in_quotes", name });
          index = closingLine;
          continue;
        }
      }
      issues.push({ line: lineNumber, rule: parsed.rule, name });
      continue;
    }
    if (!checkSecretValue(parsed.value).ok) {
      // Decoded text without NUL is well formed, so only the size can fail.
      issues.push({ line: lineNumber, rule: "value_too_large", name });
      continue;
    }
    if (entries.length >= LIMITS.body.dotenvMaxEntries) {
      if (!tooManyReported) issues.push({ line: lineNumber, rule: "too_many_entries" });
      tooManyReported = true;
      continue;
    }
    entries.push({ name, value: parsed.value, line: lineNumber });
  }

  return issues.length === 0 ? { ok: true, entries } : { ok: false, issues };
}
