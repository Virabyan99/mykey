// MyKey dotenv format v1: the canonical writer (Doc 04 FR-1.33, FR-1.38).
// Entries sorted by name in ASCII order, every value double-quoted, exactly
// LF, CR, TAB, backslash and double quote escaped, one LF after every line.
import { checkSecretName, checkSecretValue } from "../names.ts";

export type DotenvEntryRule =
  | "invalid_name"
  | "reserved_name"
  | "duplicate_name"
  | "nul"
  | "ill_formed_value"
  | "value_too_large";

/** Thrown for an entry that could not be read back. Carries no name and no value. */
export class DotenvEntryError extends Error {
  readonly rule: DotenvEntryRule;
  /** Position of the offending entry in the array that was passed in. */
  readonly index: number;

  constructor(rule: DotenvEntryRule, index: number) {
    super(`dotenv entry ${index}: ${rule}`);
    this.name = "DotenvEntryError";
    this.rule = rule;
    this.index = index;
  }
}

const VALUE_RULES = {
  nul: "nul",
  ill_formed: "ill_formed_value",
  too_large: "value_too_large",
} as const;

/**
 * Validates the entries and returns them in canonical order (a new array).
 * Throws DotenvEntryError for the first invalid name, invalid value or
 * repeated name.
 */
export function canonicalDotenvEntries(
  entries: readonly { name: string; value: string }[],
): { name: string; value: string }[] {
  const seen = new Set<string>();
  const checked = entries.map(({ name, value }, index) => {
    const nameCheck = checkSecretName(name);
    if (!nameCheck.ok) {
      const rule = nameCheck.rule === "reserved_prefix" ? "reserved_name" : "invalid_name";
      throw new DotenvEntryError(rule, index);
    }
    if (seen.has(name)) throw new DotenvEntryError("duplicate_name", index);
    seen.add(name);
    const valueCheck = checkSecretValue(value);
    if (!valueCheck.ok) throw new DotenvEntryError(VALUE_RULES[valueCheck.rule], index);
    return { name, value };
  });
  // Names are ASCII, so comparing UTF-16 code units is ASCII order.
  return checked.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const ESCAPED: Readonly<Record<string, string>> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\\": "\\\\",
  '"': '\\"',
};

/** The text between the quotes of a canonical line. */
export function escapeDotenvValue(value: string): string {
  return value.replace(/[\n\r\t\\"]/g, (character) => ESCAPED[character] ?? character);
}

const encoder = new TextEncoder();

export function serializeDotenv(entries: readonly { name: string; value: string }[]): Uint8Array {
  const lines = canonicalDotenvEntries(entries).map(
    ({ name, value }) => `${name}="${escapeDotenvValue(value)}"\n`,
  );
  return encoder.encode(lines.join(""));
}
